//! WebAuthn / Passkey ceremonies backed by `webauthn_credentials`.
//!
//! Registration and authentication state are stored server-side in
//! `auth_transactions.challenge_json` (see the `danger-allow-state-serialisation`
//! feature on webauthn-rs). Credentials themselves are stored as opaque
//! serialised [`Passkey`] blobs.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;
use webauthn_rs::prelude::*;

use crate::{config::Config, errors::AppError};

const REGISTER_KIND: &str = "passkey_register";
const REGISTER_TTL_MINUTES: i64 = 10;

#[derive(Clone)]
pub struct WebauthnService {
    inner: Webauthn,
    rp_id: String,
    rp_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub credential_pk: String,
    pub credential_id: String,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub backup_eligible: bool,
    pub backup_state: bool,
}

#[derive(Serialize, Deserialize)]
struct RegisterStateEnvelope {
    state: PasskeyRegistration,
    name: String,
}

#[derive(Serialize, Deserialize)]
struct AuthStateEnvelope {
    state: PasskeyAuthentication,
}

impl WebauthnService {
    pub fn from_config(config: &Config) -> Result<Option<Self>, AppError> {
        let (Some(rp_id), Some(origin_raw)) = (
            config.webauthn_rp_id.as_deref(),
            config.webauthn_rp_origin.as_deref(),
        ) else {
            return Ok(None);
        };
        let origin = Url::parse(origin_raw).map_err(|e| {
            AppError::Internal(format!("WEBAUTHN_RP_ORIGIN is not a valid URL: {e}"))
        })?;
        let mut builder = WebauthnBuilder::new(rp_id, &origin)
            .map_err(|e| AppError::Internal(format!("invalid WebAuthn RP config: {e}")))?;
        builder = builder.rp_name(&config.webauthn_rp_name);
        let inner = builder
            .build()
            .map_err(|e| AppError::Internal(format!("failed to build WebAuthn: {e}")))?;
        Ok(Some(Self {
            inner,
            rp_id: rp_id.to_owned(),
            rp_name: config.webauthn_rp_name.clone(),
        }))
    }

    pub fn rp_id(&self) -> &str {
        &self.rp_id
    }

    pub fn rp_name(&self) -> &str {
        &self.rp_name
    }

    pub fn webauthn(&self) -> &Webauthn {
        &self.inner
    }
}

pub async fn user_has_passkeys(db: &PgPool, user_id: &str) -> Result<bool, AppError> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?;
    Ok(count > 0)
}

/// Factors offered when password/OAuth login needs a second step.
pub async fn allowed_login_factors(
    db: &PgPool,
    webauthn: Option<&WebauthnService>,
    user_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut factors = vec!["totp".into(), "recovery_code".into()];
    if user_has_email(db, user_id).await? {
        factors.push("email".into());
    }
    if webauthn.is_some() && user_has_passkeys(db, user_id).await? {
        factors.push("passkey".into());
    }
    Ok(factors)
}

pub async fn user_has_email(db: &PgPool, user_id: &str) -> Result<bool, AppError> {
    let email: Option<String> =
        sqlx::query_scalar("SELECT email FROM users WHERE user_id = $1 AND is_deleted = FALSE")
            .bind(user_id)
            .fetch_optional(db)
            .await?
            .flatten();
    Ok(email.as_deref().is_some_and(|e| !e.trim().is_empty()))
}

pub async fn user_email(db: &PgPool, user_id: &str) -> Result<Option<String>, AppError> {
    let email: Option<String> =
        sqlx::query_scalar("SELECT email FROM users WHERE user_id = $1 AND is_deleted = FALSE")
            .bind(user_id)
            .fetch_optional(db)
            .await?
            .flatten();
    Ok(email.filter(|e| !e.trim().is_empty()))
}

/// Mask an email for UI hints: `a***@example.com`.
pub fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "***".into();
    };
    let visible = local.chars().next().unwrap_or('*');
    format!("{visible}***@{domain}")
}

pub const LOGIN_2FA_EMAIL_PURPOSE: &str = "login_2fa";

/// Issue a fresh login-2FA email code for `email`, invalidating prior unused ones.
pub async fn issue_login_2fa_email_code(db: &PgPool, email: &str) -> Result<String, AppError> {
    let email = email.trim().to_lowercase();
    sqlx::query(
        "UPDATE email_codes SET used = TRUE
         WHERE email = $1 AND purpose = $2 AND used = FALSE",
    )
    .bind(&email)
    .bind(LOGIN_2FA_EMAIL_PURPOSE)
    .execute(db)
    .await?;
    let code = crate::infra::crypto::generate_email_code();
    let expires = Utc::now() + chrono::Duration::minutes(15);
    sqlx::query(
        "INSERT INTO email_codes (email, code, purpose, expires_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&email)
    .bind(&code)
    .bind(LOGIN_2FA_EMAIL_PURPOSE)
    .bind(expires)
    .execute(db)
    .await?;
    Ok(code)
}

/// Consume a login-2FA email code for the account. Returns true when valid.
pub async fn consume_login_2fa_email_code(
    db: &PgPool,
    user_id: &str,
    code: &str,
) -> Result<bool, AppError> {
    let Some(email) = user_email(db, user_id).await? else {
        return Ok(false);
    };
    let email = email.trim().to_lowercase();
    let code = code.trim().to_uppercase();
    let result = sqlx::query(
        "UPDATE email_codes SET used = TRUE
         WHERE email = $1 AND code = $2 AND purpose = $3
           AND used = FALSE AND expires_at > NOW()",
    )
    .bind(&email)
    .bind(&code)
    .bind(LOGIN_2FA_EMAIL_PURPOSE)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod email_hint_tests {
    use super::mask_email;

    #[test]
    fn masks_local_part() {
        assert_eq!(mask_email("alice@example.com"), "a***@example.com");
        assert_eq!(mask_email("a@b.co"), "a***@b.co");
        assert_eq!(mask_email("not-an-email"), "***");
    }
}

pub async fn list_credentials(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<StoredCredential>, AppError> {
    let rows = sqlx::query(
        "SELECT credential_pk, credential_id, name, backup_eligible, backup_state,
                created_at, last_used_at
         FROM webauthn_credentials
         WHERE user_id = $1
         ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| StoredCredential {
            credential_pk: row.get("credential_pk"),
            credential_id: row.get("credential_id"),
            name: row.get("name"),
            backup_eligible: row.get("backup_eligible"),
            backup_state: row.get("backup_state"),
            created_at: row
                .get::<chrono::DateTime<Utc>, _>("created_at")
                .to_rfc3339(),
            last_used_at: row
                .try_get::<Option<chrono::DateTime<Utc>>, _>("last_used_at")
                .ok()
                .flatten()
                .map(|v| v.to_rfc3339()),
        })
        .collect())
}

async fn load_passkeys(db: &PgPool, user_id: &str) -> Result<Vec<Passkey>, AppError> {
    let rows = sqlx::query(
        "SELECT public_key FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let blob: Vec<u8> = row.get("public_key");
        let passkey: Passkey = serde_json::from_slice(&blob)
            .map_err(|e| AppError::Internal(format!("corrupt passkey blob: {e}")))?;
        out.push(passkey);
    }
    Ok(out)
}

fn parse_user_uuid(user_id: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(user_id)
        .map_err(|_| AppError::BadRequest("user id must be a UUID for passkey registration".into()))
}

fn credential_id_string(id: &CredentialID) -> String {
    URL_SAFE_NO_PAD.encode(id.as_ref())
}

/// Start registration and return both the WebAuthn options and the transaction id.
pub async fn start_registration_with_tx(
    db: &PgPool,
    service: &WebauthnService,
    user_id: &str,
    username: &str,
    display_name: &str,
    friendly_name: Option<String>,
) -> Result<(CreationChallengeResponse, String), AppError> {
    let existing = load_passkeys(db, user_id).await?;
    let exclude: Option<Vec<CredentialID>> = if existing.is_empty() {
        None
    } else {
        Some(existing.iter().map(|p| p.cred_id().clone()).collect())
    };
    let user_uuid = parse_user_uuid(user_id)?;
    let (ccr, state) = service
        .webauthn()
        .start_passkey_registration(user_uuid, username, display_name, exclude)
        .map_err(|e| AppError::BadRequest(format!("could not start passkey registration: {e}")))?;

    let name = friendly_name
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("Passkey {}", Utc::now().format("%Y-%m-%d")));
    let transaction_id = Uuid::new_v4().to_string();
    let expires_at = Utc::now() + chrono::Duration::minutes(REGISTER_TTL_MINUTES);
    let envelope = RegisterStateEnvelope { state, name };
    sqlx::query(
        "INSERT INTO auth_transactions
         (transaction_id, user_id, kind, status, client_type, challenge_json, expires_at)
         VALUES ($1, $2, $3, 'pending', 'ios', $4, $5)",
    )
    .bind(&transaction_id)
    .bind(user_id)
    .bind(REGISTER_KIND)
    .bind(serde_json::to_value(&envelope).map_err(|e| AppError::Internal(e.to_string()))?)
    .bind(expires_at)
    .execute(db)
    .await?;
    Ok((ccr, transaction_id))
}

pub async fn finish_registration(
    db: &PgPool,
    service: &WebauthnService,
    user_id: &str,
    transaction_id: &str,
    credential: RegisterPublicKeyCredential,
) -> Result<StoredCredential, AppError> {
    let mut tx = db.begin().await?;
    let row = sqlx::query(
        "SELECT challenge_json, expires_at, status
         FROM auth_transactions
         WHERE transaction_id = $1 AND user_id = $2 AND kind = $3
           AND consumed_at IS NULL
         FOR UPDATE",
    )
    .bind(transaction_id)
    .bind(user_id)
    .bind(REGISTER_KIND)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::BadRequest("passkey registration session not found".into()))?;

    let expires_at: chrono::DateTime<Utc> = row.get("expires_at");
    let status: String = row.get("status");
    if expires_at <= Utc::now() || status != "pending" {
        sqlx::query(
            "UPDATE auth_transactions SET status = 'expired', updated_at = NOW()
             WHERE transaction_id = $1",
        )
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(AppError::BadRequest(
            "passkey registration session expired".into(),
        ));
    }

    let challenge: serde_json::Value = row.get("challenge_json");
    let envelope: RegisterStateEnvelope = serde_json::from_value(challenge)
        .map_err(|e| AppError::Internal(format!("invalid registration state: {e}")))?;
    let passkey = service
        .webauthn()
        .finish_passkey_registration(&credential, &envelope.state)
        .map_err(|e| AppError::Unauthorized(format!("passkey registration failed: {e}")))?;

    let credential_pk = Uuid::new_v4().to_string();
    let credential_id = credential_id_string(passkey.cred_id());
    let blob = serde_json::to_vec(&passkey)
        .map_err(|e| AppError::Internal(format!("serialize passkey: {e}")))?;

    sqlx::query(
        "INSERT INTO webauthn_credentials
         (credential_pk, user_id, credential_id, public_key, sign_count, transports,
          backup_eligible, backup_state, name)
         VALUES ($1, $2, $3, $4, 0, '[]'::jsonb, FALSE, FALSE, $5)",
    )
    .bind(&credential_pk)
    .bind(user_id)
    .bind(&credential_id)
    .bind(&blob)
    .bind(&envelope.name)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(db_err) = &e {
            if db_err.constraint() == Some("uq_webauthn_credentials_id") {
                return AppError::Conflict("this passkey is already registered".into());
            }
        }
        AppError::Db(e)
    })?;

    sqlx::query(
        "UPDATE auth_transactions
         SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
         WHERE transaction_id = $1",
    )
    .bind(transaction_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(StoredCredential {
        credential_pk,
        credential_id,
        name: envelope.name,
        created_at: Utc::now().to_rfc3339(),
        last_used_at: None,
        backup_eligible: false,
        backup_state: false,
    })
}

pub async fn delete_credential(
    db: &PgPool,
    user_id: &str,
    credential_pk: &str,
) -> Result<(), AppError> {
    let result =
        sqlx::query("DELETE FROM webauthn_credentials WHERE credential_pk = $1 AND user_id = $2")
            .bind(credential_pk)
            .bind(user_id)
            .execute(db)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn start_authentication(
    db: &PgPool,
    service: &WebauthnService,
    user_id: &str,
    login_transaction_id: &str,
) -> Result<RequestChallengeResponse, AppError> {
    let passkeys = load_passkeys(db, user_id).await?;
    if passkeys.is_empty() {
        return Err(AppError::BadRequest(
            "no passkeys are registered for this account".into(),
        ));
    }
    let (rcr, state) = service
        .webauthn()
        .start_passkey_authentication(&passkeys)
        .map_err(|e| AppError::BadRequest(format!("could not start passkey assertion: {e}")))?;

    let envelope = AuthStateEnvelope { state };
    let result = sqlx::query(
        "UPDATE auth_transactions
         SET challenge_json = $2, updated_at = NOW()
         WHERE transaction_id = $1 AND kind = 'login'
           AND status IN ('factor_required', 'verified')
           AND consumed_at IS NULL AND expires_at > NOW()",
    )
    .bind(login_transaction_id)
    .bind(serde_json::to_value(&envelope).map_err(|e| AppError::Internal(e.to_string()))?)
    .execute(db)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Unauthorized(
            "invalid authentication transaction".into(),
        ));
    }
    Ok(rcr)
}

pub async fn finish_authentication(
    db: &PgPool,
    service: &WebauthnService,
    user_id: &str,
    login_transaction_id: &str,
    credential: PublicKeyCredential,
) -> Result<(), AppError> {
    let row = sqlx::query(
        "SELECT challenge_json FROM auth_transactions
         WHERE transaction_id = $1 AND kind = 'login'
           AND status IN ('factor_required', 'verified')
           AND consumed_at IS NULL AND expires_at > NOW()",
    )
    .bind(login_transaction_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid authentication transaction".into()))?;

    let challenge: serde_json::Value = row.try_get("challenge_json").unwrap_or_else(|_| json!({}));
    if challenge.is_null() {
        return Err(AppError::BadRequest(
            "passkey assertion was not started for this login".into(),
        ));
    }
    let envelope: AuthStateEnvelope = serde_json::from_value(challenge).map_err(|_| {
        AppError::BadRequest("passkey assertion was not started for this login".into())
    })?;

    let result = service
        .webauthn()
        .finish_passkey_authentication(&credential, &envelope.state)
        .map_err(|e| AppError::Unauthorized(format!("passkey verification failed: {e}")))?;

    // Update matching credential counters / backup flags.
    let mut passkeys = load_passkeys(db, user_id).await?;
    for passkey in &mut passkeys {
        if let Some(true) = passkey.update_credential(&result) {
            let credential_id = credential_id_string(passkey.cred_id());
            let blob = serde_json::to_vec(passkey)
                .map_err(|e| AppError::Internal(format!("serialize passkey: {e}")))?;
            sqlx::query(
                "UPDATE webauthn_credentials
                 SET public_key = $3, last_used_at = NOW(), updated_at = NOW(),
                     backup_eligible = $4, backup_state = $5
                 WHERE user_id = $1 AND credential_id = $2",
            )
            .bind(user_id)
            .bind(&credential_id)
            .bind(&blob)
            .bind(result.backup_eligible())
            .bind(result.backup_state())
            .execute(db)
            .await?;
            break;
        } else if passkey.cred_id() == result.cred_id() {
            sqlx::query(
                "UPDATE webauthn_credentials SET last_used_at = NOW(), updated_at = NOW()
                 WHERE user_id = $1 AND credential_id = $2",
            )
            .bind(user_id)
            .bind(credential_id_string(passkey.cred_id()))
            .execute(db)
            .await?;
            break;
        }
    }
    Ok(())
}
