//! User-level TOTP 2FA lifecycle and remote-agent access gating.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    errors::AppError,
    infra::crypto::{decrypt_secret, derive_master_key, encrypt_secret, sha256_hex},
    infra::totp,
};

const BACKUP_CODE_COUNT: usize = 8;
const BACKUP_CODE_LENGTH: usize = 8;
const TWOFA_SESSION_TTL_MINUTES: i64 = 5;

const BACKUP_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0, O, 1, I, L

pub struct TwoFactorStatus {
    pub enabled: bool,
    pub verified_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Derive the AES-256-GCM master key used to encrypt TOTP secrets at rest.
/// Deterministic across restarts; uses SECRET_STORE_KEY if set, otherwise JWT PEM.
pub fn master_key(secret_store_key: Option<&str>, jwt_private_key_pem: &str) -> [u8; 32] {
    derive_master_key(secret_store_key, jwt_private_key_pem)
}

pub async fn status(db: &PgPool, user_id: &str) -> Result<TwoFactorStatus, AppError> {
    let row = sqlx::query(
        "SELECT totp_enabled, totp_verified_at
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(TwoFactorStatus {
        enabled: row.try_get::<bool, _>("totp_enabled").unwrap_or(false),
        verified_at: row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("totp_verified_at")
            .ok()
            .flatten(),
    })
}

/// Store an encrypted TOTP secret for the caller. The secret is not yet enabled
/// (the user must prove possession with a valid code in `enable`).
pub async fn setup(
    db: &PgPool,
    user_id: &str,
    secret: &str,
    master_key: &[u8; 32],
) -> Result<(), AppError> {
    let encrypted = encrypt_secret(master_key, secret)
        .map_err(|e| AppError::Internal(format!("encrypt: {e}")))?;
    sqlx::query(
        "UPDATE users
         SET totp_secret_encrypted = $2,
             totp_enabled = FALSE,
             totp_verified_at = NULL,
             backup_codes = '[]'::jsonb
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .bind(&encrypted)
    .execute(db)
    .await?;
    Ok(())
}

/// Verify the first TOTP code and enable 2FA. Returns one-time backup codes.
pub async fn enable(
    db: &PgPool,
    user_id: &str,
    code: &str,
    master_key: &[u8; 32],
) -> Result<Vec<String>, AppError> {
    let row = sqlx::query(
        "SELECT totp_secret_encrypted FROM users
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    let encrypted: Option<String> = row.try_get("totp_secret_encrypted").ok().flatten();
    let encrypted =
        encrypted.ok_or_else(|| AppError::BadRequest("2FA setup not started".into()))?;
    let secret = decrypt_secret(master_key, &encrypted)
        .map_err(|_| AppError::Internal("failed to decrypt 2FA secret".into()))?;
    if !totp::verify(&secret, code, chrono::Utc::now().timestamp() as u64) {
        return Err(AppError::Unauthorized("invalid verification code".into()));
    }
    let backup_codes = generate_backup_codes();
    let hashes: Vec<Value> = backup_codes
        .iter()
        .map(|c| json!({ "hash": sha256_hex(c), "used_at": Value::Null }))
        .collect();
    sqlx::query(
        "UPDATE users
         SET totp_enabled = TRUE,
             totp_verified_at = NOW(),
             backup_codes = $2
         WHERE user_id = $1",
    )
    .bind(user_id)
    .bind(serde_json::Value::Array(hashes))
    .execute(db)
    .await?;
    Ok(backup_codes)
}

/// Disable 2FA after verifying a current TOTP code or unused backup code.
pub async fn verify_and_disable(
    db: &PgPool,
    user_id: &str,
    code: &str,
    master_key: &[u8; 32],
) -> Result<(), AppError> {
    if !verify_login(db, user_id, code, master_key).await? {
        return Err(AppError::Unauthorized("invalid verification code".into()));
    }
    sqlx::query(
        "UPDATE users
         SET totp_enabled = FALSE,
             totp_secret_encrypted = NULL,
             totp_verified_at = NULL,
             backup_codes = '[]'::jsonb
         WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Require a valid TOTP or backup code when the user has enabled 2FA.
pub async fn ensure_valid_code_if_enabled(
    db: &PgPool,
    user_id: &str,
    code: Option<&str>,
    master_key: &[u8; 32],
) -> Result<(), AppError> {
    if !status(db, user_id).await?.enabled {
        return Ok(());
    }
    let code = code
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Unauthorized("2FA code is required".into()))?;
    if !verify_login(db, user_id, code, master_key).await? {
        return Err(AppError::Unauthorized("invalid 2FA code".into()));
    }
    Ok(())
}

/// Verify a TOTP code or backup code during the second login step.
/// Returns true when the code is valid and the user can be issued a token.
pub async fn verify_login(
    db: &PgPool,
    user_id: &str,
    code: &str,
    master_key: &[u8; 32],
) -> Result<bool, AppError> {
    let row = sqlx::query(
        "SELECT totp_secret_encrypted, backup_codes, totp_enabled
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    let enabled: bool = row.try_get("totp_enabled").unwrap_or(false);
    if !enabled {
        return Ok(false);
    }
    let encrypted: Option<String> = row.try_get("totp_secret_encrypted").ok().flatten();
    let encrypted =
        encrypted.ok_or_else(|| AppError::Internal("2FA enabled but no secret".into()))?;
    let secret = decrypt_secret(master_key, &encrypted)
        .map_err(|_| AppError::Internal("failed to decrypt 2FA secret".into()))?;
    if totp::verify(&secret, code, chrono::Utc::now().timestamp() as u64) {
        return Ok(true);
    }
    // Fall back to backup codes.
    let backup_codes: Value = row.try_get("backup_codes").unwrap_or(json!([]));
    if let Some(codes) = backup_codes.as_array() {
        let input_hash = sha256_hex(code);
        for (i, entry) in codes.iter().enumerate() {
            if entry.get("hash").and_then(Value::as_str) == Some(&input_hash)
                && entry.get("used_at").and_then(Value::as_str).is_none()
            {
                let mut updated = codes.clone();
                updated[i]["used_at"] = json!(chrono::Utc::now().to_rfc3339());
                sqlx::query("UPDATE users SET backup_codes = $2 WHERE user_id = $1")
                    .bind(user_id)
                    .bind(Value::Array(updated))
                    .execute(db)
                    .await?;
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Create a short-lived intermediate session for the 2FA login step.
pub async fn create_login_session(db: &PgPool, user_id: &str) -> Result<String, AppError> {
    let session_id = Uuid::new_v4().to_string();
    let expires = chrono::Utc::now() + chrono::Duration::minutes(TWOFA_SESSION_TTL_MINUTES);
    sqlx::query(
        "INSERT INTO two_factor_login_sessions (session_id, user_id, expires_at)
         VALUES ($1, $2, $3)",
    )
    .bind(&session_id)
    .bind(user_id)
    .bind(expires)
    .execute(db)
    .await?;
    Ok(session_id)
}

/// Consume a 2FA login session and return the user_id it belongs to.
/// Returns `None` if the session is unknown, expired, or already used.
pub async fn consume_login_session(
    db: &PgPool,
    session_id: &str,
) -> Result<Option<String>, AppError> {
    let row = sqlx::query(
        "SELECT user_id FROM two_factor_login_sessions
         WHERE session_id = $1 AND used = FALSE AND expires_at > NOW()",
    )
    .bind(session_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let user_id: String = row.try_get("user_id").map_err(AppError::Db)?;
    sqlx::query("UPDATE two_factor_login_sessions SET used = TRUE WHERE session_id = $1")
        .bind(session_id)
        .execute(db)
        .await?;
    Ok(Some(user_id))
}

fn generate_backup_codes() -> Vec<String> {
    let mut out = Vec::with_capacity(BACKUP_CODE_COUNT);
    let mut bytes = [0u8; BACKUP_CODE_LENGTH];
    for _ in 0..BACKUP_CODE_COUNT {
        getrandom::getrandom(&mut bytes).expect("CSPRNG unavailable");
        let code: String = bytes
            .iter()
            .map(|b| BACKUP_ALPHABET[(*b as usize) % BACKUP_ALPHABET.len()] as char)
            .collect();
        out.push(code);
    }
    out
}

/// Gate: when the instance requires 2FA for remote agent access, enforce that
/// the user has enabled TOTP before they can create or use an agent.
pub async fn ensure_2fa_for_remote_agent_access(
    db: &PgPool,
    user_id: &str,
    required: bool,
) -> Result<(), AppError> {
    if !required {
        return Ok(());
    }
    let s = status(db, user_id).await?;
    if !s.enabled {
        return Err(AppError::Forbidden(
            "two-factor authentication is required for remote agent access".into(),
        ));
    }
    Ok(())
}
