//! User-level two-factor lifecycle and remote-agent access gating.
//!
//! 2FA is on when *any* second factor is armed, not only an authenticator app:
//! TOTP (explicit enrolment), a registered passkey (armed automatically), or an
//! emailed one-time code (explicit opt-in). Recovery codes are account-level and
//! back every method rather than belonging to TOTP.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    config::Config,
    errors::AppError,
    infra::crypto::{
        decrypt_secret, derive_master_key, encrypt_secret, generate_email_code, hash_email_code,
        sha256_hex,
    },
    infra::totp,
};

const BACKUP_CODE_COUNT: usize = 8;
const BACKUP_CODE_LENGTH: usize = 8;
const TWOFA_SESSION_TTL_MINUTES: i64 = 5;

const BACKUP_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0, O, 1, I, L

/// Purpose tag for emailed one-time codes. Both the unified auth flow and the
/// legacy `/auth/2fa/*` endpoints issue through here, so a code from either
/// verifies against the other — and each code is still single-use.
const EMAIL_CODE_PURPOSE: &str = "auth_flow";
const EMAIL_CODE_RESEND_COOLDOWN_SECS: i64 = 60;

/// Which second factors a user currently has armed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct TwoFactorMethods {
    /// Authenticator app (TOTP) enrolled and verified.
    pub totp: bool,
    /// At least one passkey registered; armed automatically.
    pub passkey: bool,
    /// Emailed one-time codes opted into, with an address on file.
    pub email: bool,
}

impl TwoFactorMethods {
    /// Whether the account is protected by a second factor at all.
    pub fn any(self) -> bool {
        self.totp || self.passkey || self.email
    }

    /// Factor names the login step can challenge with, strongest first.
    pub fn login_factors(self) -> Vec<String> {
        let mut factors = Vec::new();
        if self.passkey {
            factors.push("passkey".to_string());
        }
        if self.totp {
            factors.push("totp".to_string());
        }
        if self.email {
            factors.push("email".to_string());
        }
        factors
    }
}

pub struct TwoFactorStatus {
    pub enabled: bool,
    pub methods: TwoFactorMethods,
    pub verified_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Derive the AES-256-GCM master key used to encrypt TOTP secrets at rest.
/// Deterministic across restarts; uses SECRET_STORE_KEY if set, otherwise JWT PEM.
pub fn master_key(secret_store_key: Option<&str>, jwt_private_key_pem: &str) -> [u8; 32] {
    derive_master_key(secret_store_key, jwt_private_key_pem)
}

/// Read which second factors are armed for a user.
pub async fn methods(db: &PgPool, user_id: &str) -> Result<TwoFactorMethods, AppError> {
    let row = sqlx::query(
        "SELECT u.totp_enabled,
                u.email_2fa_enabled AND u.email IS NOT NULL AND btrim(u.email) <> ''
                    AS email_armed,
                EXISTS(SELECT 1 FROM webauthn_credentials c WHERE c.user_id = u.user_id)
                    AS has_passkey
         FROM users u WHERE u.user_id = $1 AND u.is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(TwoFactorMethods {
        totp: row.try_get::<bool, _>("totp_enabled").unwrap_or(false),
        passkey: row.try_get::<bool, _>("has_passkey").unwrap_or(false),
        email: row.try_get::<bool, _>("email_armed").unwrap_or(false),
    })
}

pub async fn status(db: &PgPool, user_id: &str) -> Result<TwoFactorStatus, AppError> {
    let row = sqlx::query(
        "SELECT u.totp_enabled, u.totp_verified_at,
                u.email_2fa_enabled AND u.email IS NOT NULL AND btrim(u.email) <> ''
                    AS email_armed,
                EXISTS(SELECT 1 FROM webauthn_credentials c WHERE c.user_id = u.user_id)
                    AS has_passkey
         FROM users u WHERE u.user_id = $1 AND u.is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    let methods = TwoFactorMethods {
        totp: row.try_get::<bool, _>("totp_enabled").unwrap_or(false),
        passkey: row.try_get::<bool, _>("has_passkey").unwrap_or(false),
        email: row.try_get::<bool, _>("email_armed").unwrap_or(false),
    };
    Ok(TwoFactorStatus {
        enabled: methods.any(),
        methods,
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
             totp_verified_at = NULL
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .bind(&encrypted)
    .execute(db)
    .await?;
    Ok(())
}

/// Verify the first TOTP code and arm the authenticator factor. Returns freshly
/// minted recovery codes, or an empty list when the account already has codes
/// backing another factor.
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
    sqlx::query(
        "UPDATE users
         SET totp_enabled = TRUE,
             totp_verified_at = NOW()
         WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(db)
    .await?;
    ensure_recovery_codes(db, user_id).await
}

/// Opt an account into (or out of) emailed one-time codes as a second factor.
/// Returns freshly minted recovery codes when this armed the first factor.
pub async fn set_email_factor(
    db: &PgPool,
    user_id: &str,
    enabled: bool,
) -> Result<Vec<String>, AppError> {
    if enabled {
        let has_email: bool = sqlx::query_scalar(
            "SELECT email IS NOT NULL AND btrim(email) <> '' FROM users
             WHERE user_id = $1 AND is_deleted = FALSE",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)?;
        if !has_email {
            return Err(AppError::BadRequest(
                "add and verify an email address before using email codes for two-step verification"
                    .into(),
            ));
        }
        // An email code is only a *second* factor when something else proves the
        // first one. Without a password or a passkey the mailbox would be both
        // steps, so arming it here would be security theatre.
        let has_other_primary: bool = sqlx::query_scalar(
            "SELECT (u.password_hash IS NOT NULL)
                 OR EXISTS(SELECT 1 FROM webauthn_credentials c WHERE c.user_id = u.user_id)
             FROM users u WHERE u.user_id = $1 AND u.is_deleted = FALSE",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or(AppError::NotFound)?;
        if !has_other_primary {
            return Err(AppError::BadRequest(
                "set a password or add a passkey first: an email code cannot be both sign-in steps"
                    .into(),
            ));
        }
    }
    sqlx::query(
        "UPDATE users SET email_2fa_enabled = $2 WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .bind(enabled)
    .execute(db)
    .await?;
    if enabled {
        return ensure_recovery_codes(db, user_id).await;
    }
    clear_recovery_codes_if_unprotected(db, user_id).await?;
    Ok(Vec::new())
}

/// Mint recovery codes if the account has none. Returns the plaintext codes when
/// they were just generated (the only time they can be shown), else an empty list.
pub async fn ensure_recovery_codes(db: &PgPool, user_id: &str) -> Result<Vec<String>, AppError> {
    let mut tx = db.begin().await?;
    let stored: Value = sqlx::query_scalar(
        "SELECT backup_codes FROM users
         WHERE user_id = $1 AND is_deleted = FALSE
         FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    if stored.as_array().is_some_and(|codes| !codes.is_empty()) {
        tx.commit().await?;
        return Ok(Vec::new());
    }
    let codes = generate_backup_codes();
    let hashes: Vec<Value> = codes
        .iter()
        .map(|c| json!({ "hash": sha256_hex(c), "used_at": Value::Null }))
        .collect();
    sqlx::query("UPDATE users SET backup_codes = $2 WHERE user_id = $1")
        .bind(user_id)
        .bind(Value::Array(hashes))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(codes)
}

/// Replace the account's recovery codes with a fresh set.
pub async fn regenerate_recovery_codes(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, AppError> {
    let codes = generate_backup_codes();
    let hashes: Vec<Value> = codes
        .iter()
        .map(|c| json!({ "hash": sha256_hex(c), "used_at": Value::Null }))
        .collect();
    let updated =
        sqlx::query("UPDATE users SET backup_codes = $2 WHERE user_id = $1 AND is_deleted = FALSE")
            .bind(user_id)
            .bind(Value::Array(hashes))
            .execute(db)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(codes)
}

/// How many unused recovery codes remain.
pub async fn recovery_codes_remaining(db: &PgPool, user_id: &str) -> Result<usize, AppError> {
    let stored: Value = sqlx::query_scalar(
        "SELECT backup_codes FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(stored
        .as_array()
        .map(|codes| {
            codes
                .iter()
                .filter(|entry| entry.get("used_at").and_then(Value::as_str).is_none())
                .count()
        })
        .unwrap_or(0))
}

/// Drop recovery codes once the last second factor is gone — they only exist to
/// rescue a 2FA-protected account.
pub async fn clear_recovery_codes_if_unprotected(
    db: &PgPool,
    user_id: &str,
) -> Result<(), AppError> {
    if methods(db, user_id).await?.any() {
        return Ok(());
    }
    sqlx::query("UPDATE users SET backup_codes = '[]'::jsonb WHERE user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Unenrol the authenticator app after verifying a current TOTP or recovery code.
/// Other armed factors (passkey, email) keep protecting the account, and their
/// recovery codes survive; codes are only cleared once nothing is armed.
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
             totp_verified_at = NULL
         WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(db)
    .await?;
    clear_recovery_codes_if_unprotected(db, user_id).await
}

/// Require a valid second-factor code when the account has 2FA armed.
///
/// Accepts an authenticator code, a recovery code, or an emailed code, so a
/// passkey-only user is not left without an answer: recovery codes are minted
/// for every armed method. Callers that can offer a WebAuthn prompt should use
/// the step-up flow instead.
pub async fn ensure_valid_code_if_enabled(
    db: &PgPool,
    config: &Config,
    user_id: &str,
    code: Option<&str>,
    master_key: &[u8; 32],
) -> Result<(), AppError> {
    if !methods(db, user_id).await?.any() {
        return Ok(());
    }
    let code = code
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Unauthorized("2FA code is required".into()))?;
    if verify_login(db, user_id, code, master_key).await? {
        return Ok(());
    }
    if verify_email_code(db, config, user_id, code).await? {
        return Ok(());
    }
    Err(AppError::Unauthorized("invalid 2FA code".into()))
}

/// Outcome of asking for an emailed one-time code.
pub struct EmailCodeIssue {
    /// Masked destination, for a "sent to a***@example.com" hint.
    pub hint: String,
    /// False when a live code is still within the resend cooldown and this call
    /// deliberately did not mail another.
    pub sent: bool,
}

/// Mail a one-time second-factor code. Returns `None` when the account has no
/// email, so callers stay silent rather than becoming an existence oracle.
pub async fn issue_email_code(
    db: &PgPool,
    config: &Config,
    user_id: &str,
) -> Result<Option<EmailCodeIssue>, AppError> {
    let email: Option<String> =
        sqlx::query_scalar("SELECT email FROM users WHERE user_id = $1 AND is_deleted = FALSE")
            .bind(user_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let Some(email) = email.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let normalized = email.trim().to_lowercase();
    let cooling_down: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM email_codes
            WHERE email = $1 AND purpose = $2 AND used = FALSE
              AND created_at > NOW() - ($3::double precision * INTERVAL '1 second')
              AND expires_at > NOW()
         )",
    )
    .bind(&normalized)
    .bind(EMAIL_CODE_PURPOSE)
    .bind(EMAIL_CODE_RESEND_COOLDOWN_SECS as f64)
    .fetch_one(db)
    .await?;
    if cooling_down {
        return Ok(Some(EmailCodeIssue {
            hint: crate::domain::webauthn::mask_email(&email),
            sent: false,
        }));
    }
    // One live code at a time: a resend invalidates whatever was mailed before.
    sqlx::query(
        "UPDATE email_codes SET used = TRUE WHERE email = $1 AND purpose = $2 AND used = FALSE",
    )
    .bind(&normalized)
    .bind(EMAIL_CODE_PURPOSE)
    .execute(db)
    .await?;
    let code = generate_email_code();
    let hash = hash_email_code(
        config.secret_store_key.as_deref(),
        &config.jwt_private_key_pem,
        &email,
        EMAIL_CODE_PURPOSE,
        &code,
    );
    sqlx::query(
        "INSERT INTO email_codes (email, code, code_hash, purpose, expires_at)
         VALUES ($1, NULL, $2, $3, NOW() + INTERVAL '10 minutes')",
    )
    .bind(&normalized)
    .bind(hash)
    .bind(EMAIL_CODE_PURPOSE)
    .execute(db)
    .await?;
    crate::infra::email::send_login_2fa_code(config, &email, &code).await;
    Ok(Some(EmailCodeIssue {
        hint: crate::domain::webauthn::mask_email(&email),
        sent: true,
    }))
}

/// Consume an emailed one-time code for the user. Single-use: a match burns it.
pub async fn verify_email_code(
    db: &PgPool,
    config: &Config,
    user_id: &str,
    code: &str,
) -> Result<bool, AppError> {
    let email: Option<String> =
        sqlx::query_scalar("SELECT email FROM users WHERE user_id = $1 AND is_deleted = FALSE")
            .bind(user_id)
            .fetch_optional(db)
            .await?
            .flatten();
    let Some(email) = email.filter(|value| !value.trim().is_empty()) else {
        return Ok(false);
    };
    let hash = hash_email_code(
        config.secret_store_key.as_deref(),
        &config.jwt_private_key_pem,
        &email,
        EMAIL_CODE_PURPOSE,
        code,
    );
    let consumed = sqlx::query(
        "UPDATE email_codes SET used = TRUE
         WHERE email = $1 AND purpose = $2 AND code_hash = $3
           AND used = FALSE AND expires_at > NOW()",
    )
    .bind(email.trim().to_lowercase())
    .bind(EMAIL_CODE_PURPOSE)
    .bind(hash)
    .execute(db)
    .await?;
    Ok(consumed.rows_affected() == 1)
}

/// Verify an authenticator code or a recovery code during the second login step.
/// Returns true when the code is valid and the user can be issued a token.
pub async fn verify_login(
    db: &PgPool,
    user_id: &str,
    code: &str,
    master_key: &[u8; 32],
) -> Result<bool, AppError> {
    let mut tx = db.begin().await?;
    let row = sqlx::query(
        "SELECT totp_secret_encrypted, backup_codes, totp_enabled
         FROM users WHERE user_id = $1 AND is_deleted = FALSE
         FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let totp_enrolled: bool = row.try_get("totp_enabled").unwrap_or(false);
    if totp_enrolled {
        let encrypted: Option<String> = row.try_get("totp_secret_encrypted").ok().flatten();
        let encrypted =
            encrypted.ok_or_else(|| AppError::Internal("2FA enabled but no secret".into()))?;
        let secret = decrypt_secret(master_key, &encrypted)
            .map_err(|_| AppError::Internal("failed to decrypt 2FA secret".into()))?;
        if totp::verify(&secret, code, chrono::Utc::now().timestamp() as u64) {
            tx.commit().await?;
            return Ok(true);
        }
    }
    // Recovery codes back every armed factor, not just the authenticator, so
    // they stay valid for passkey- and email-only accounts.
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
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                return Ok(true);
            }
        }
    }
    tx.commit().await?;
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
            "two-step verification is required for remote agent access: add a passkey, an authenticator app, or email codes".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::TwoFactorMethods;

    #[test]
    fn any_armed_method_counts_as_two_factor() {
        assert!(!TwoFactorMethods::default().any());
        for armed in [
            TwoFactorMethods {
                totp: true,
                ..Default::default()
            },
            TwoFactorMethods {
                passkey: true,
                ..Default::default()
            },
            TwoFactorMethods {
                email: true,
                ..Default::default()
            },
        ] {
            assert!(
                armed.any(),
                "{armed:?} should satisfy two-step verification"
            );
        }
    }

    #[test]
    fn a_passkey_alone_is_challengeable() {
        // The regression this replaces: a passkey-only account used to advertise
        // `totp` and had nothing the user could actually answer with.
        let armed = TwoFactorMethods {
            passkey: true,
            ..Default::default()
        };
        assert_eq!(armed.login_factors(), vec!["passkey".to_string()]);
    }

    #[test]
    fn login_factors_list_only_what_is_armed_strongest_first() {
        let armed = TwoFactorMethods {
            totp: true,
            passkey: true,
            email: true,
        };
        assert_eq!(
            armed.login_factors(),
            vec![
                "passkey".to_string(),
                "totp".to_string(),
                "email".to_string()
            ]
        );
        let codes_only = TwoFactorMethods {
            totp: true,
            ..Default::default()
        };
        assert_eq!(codes_only.login_factors(), vec!["totp".to_string()]);
    }
}
