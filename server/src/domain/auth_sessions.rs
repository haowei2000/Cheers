use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    config::Config,
    domain::auth::{self, AuthUser},
    errors::AppError,
    infra::crypto::sha256_hex,
};

pub const ACCESS_TOKEN_TTL_SECONDS: i64 = 10 * 60;
const AUTH_TRANSACTION_TTL_MINUTES: i64 = 10;
const REFRESH_IDLE_TTL_DAYS: i64 = 30;
const SESSION_ABSOLUTE_TTL_DAYS: i64 = 90;
const TRUSTED_DEVICE_TTL_DAYS: i64 = 30;
const MAX_FACTOR_ATTEMPTS: i16 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientType {
    Web,
    Ios,
    Macos,
}

impl ClientType {
    pub fn parse(value: Option<&str>) -> Result<Self, AppError> {
        match value.unwrap_or("web") {
            "web" => Ok(Self::Web),
            "ios" => Ok(Self::Ios),
            "macos" => Ok(Self::Macos),
            _ => Err(AppError::BadRequest(
                "client must be web, ios, or macos".into(),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Ios => "ios",
            Self::Macos => "macos",
        }
    }
}

pub struct IssuedSession {
    pub session_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub csrf_token: String,
    pub expires_in: i64,
}

pub struct RotatedSession {
    pub session_id: String,
    pub user: AuthUser,
    pub access_token: String,
    pub refresh_token: String,
    pub csrf_token: Option<String>,
    pub expires_in: i64,
}

#[derive(Debug, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub client: String,
    pub device_name: Option<String>,
    pub authenticated_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub current: bool,
}

pub struct FactorTransaction {
    pub transaction_id: String,
}

fn random_secret() -> Result<String, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| AppError::Internal(format!("secure random generation failed: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub async fn create_factor_transaction(
    db: &PgPool,
    user_id: &str,
    client: ClientType,
    device_name: Option<&str>,
) -> Result<FactorTransaction, AppError> {
    let transaction_id = Uuid::new_v4().to_string();
    let expires_at = Utc::now() + Duration::minutes(AUTH_TRANSACTION_TTL_MINUTES);
    sqlx::query(
        "INSERT INTO auth_transactions
         (transaction_id, user_id, kind, status, client_type, context_json, expires_at)
         VALUES ($1, $2, 'login', 'factor_required', $3, $4, $5)",
    )
    .bind(&transaction_id)
    .bind(user_id)
    .bind(client.as_str())
    .bind(json!({ "device_name": device_name }))
    .bind(expires_at)
    .execute(db)
    .await?;
    Ok(FactorTransaction { transaction_id })
}

pub async fn factor_transaction_user(
    db: &PgPool,
    transaction_id: &str,
) -> Result<(String, ClientType, Option<String>), AppError> {
    let mut tx = db.begin().await?;
    let row = sqlx::query(
        "SELECT user_id, client_type, context_json, failed_attempts, expires_at
         FROM auth_transactions
         WHERE transaction_id = $1 AND kind = 'login'
           AND status IN ('factor_required', 'verified') AND consumed_at IS NULL
         FOR UPDATE",
    )
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid authentication transaction".into()))?;
    let expires_at: DateTime<Utc> = row.try_get("expires_at")?;
    let failed_attempts: i16 = row.try_get("failed_attempts").unwrap_or(0);
    if expires_at <= Utc::now() || failed_attempts >= MAX_FACTOR_ATTEMPTS {
        sqlx::query(
            "UPDATE auth_transactions SET status = 'expired', updated_at = NOW()
             WHERE transaction_id = $1",
        )
        .bind(transaction_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(AppError::Unauthorized(
            "authentication transaction expired".into(),
        ));
    }
    let user_id: String = row.try_get("user_id")?;
    let client_raw: String = row.try_get("client_type")?;
    let context: serde_json::Value = row.try_get("context_json").unwrap_or(json!({}));
    let device_name = context
        .get("device_name")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    tx.commit().await?;
    Ok((
        user_id,
        ClientType::parse(Some(client_raw.as_str()))?,
        device_name,
    ))
}

pub async fn record_factor_failure(db: &PgPool, transaction_id: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE auth_transactions
         SET failed_attempts = LEAST(failed_attempts + 1, 5),
             status = CASE WHEN failed_attempts + 1 >= 5 THEN 'failed' ELSE status END,
             updated_at = NOW()
         WHERE transaction_id = $1 AND consumed_at IS NULL",
    )
    .bind(transaction_id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn consume_factor_transaction(db: &PgPool, transaction_id: &str) -> Result<(), AppError> {
    let result = sqlx::query(
        "UPDATE auth_transactions
         SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
         WHERE transaction_id = $1 AND status = 'factor_required'
           AND consumed_at IS NULL AND expires_at > NOW() AND failed_attempts < 5",
    )
    .bind(transaction_id)
    .execute(db)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Unauthorized(
            "authentication transaction was already consumed".into(),
        ));
    }
    Ok(())
}

pub async fn trusted_device_is_valid(
    db: &PgPool,
    user_id: &str,
    credential: Option<&str>,
) -> Result<bool, AppError> {
    let Some(credential) = credential.filter(|value| !value.is_empty()) else {
        return Ok(false);
    };
    let result = sqlx::query(
        "UPDATE trusted_devices SET last_used_at = NOW()
         WHERE user_id = $1 AND credential_hash = $2
           AND revoked_at IS NULL AND expires_at > NOW()",
    )
    .bind(user_id)
    .bind(sha256_hex(credential))
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn issue_trusted_device(
    db: &PgPool,
    user_id: &str,
    session_id: &str,
    device_name: Option<&str>,
) -> Result<String, AppError> {
    let credential = random_secret()?;
    sqlx::query(
        "INSERT INTO trusted_devices
         (trusted_device_id, user_id, session_id, credential_hash, device_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(user_id)
    .bind(session_id)
    .bind(sha256_hex(&credential))
    .bind(device_name)
    .bind(Utc::now() + Duration::days(TRUSTED_DEVICE_TTL_DAYS))
    .execute(db)
    .await?;
    Ok(credential)
}

pub async fn finalize_login(
    db: &PgPool,
    config: &Config,
    user: &AuthUser,
    client: ClientType,
    device_name: Option<&str>,
) -> Result<IssuedSession, AppError> {
    let session_id = Uuid::new_v4().to_string();
    let family_id = Uuid::new_v4().to_string();
    let refresh_token_id = Uuid::new_v4().to_string();
    let refresh_token = random_secret()?;
    let csrf_token = random_secret()?;
    let now = Utc::now();
    let absolute_expires_at = now + Duration::days(SESSION_ABSOLUTE_TTL_DAYS);
    let refresh_expires_at = now + Duration::days(REFRESH_IDLE_TTL_DAYS);
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO auth_sessions
         (session_id, user_id, client_type, device_name, token_family_id,
          csrf_token_hash, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&session_id)
    .bind(&user.id)
    .bind(client.as_str())
    .bind(device_name)
    .bind(family_id)
    .bind(sha256_hex(&csrf_token))
    .bind(absolute_expires_at)
    .execute(&mut *tx)
    .await?;
    insert_refresh_token(
        &mut tx,
        &refresh_token_id,
        &session_id,
        &refresh_token,
        refresh_expires_at,
    )
    .await?;
    tx.commit().await?;

    let user_uuid = user
        .id
        .parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;
    Ok(IssuedSession {
        access_token: auth::create_access_token(
            config,
            user_uuid,
            &user.role,
            user.token_version as i64,
            &session_id,
        )?,
        session_id,
        refresh_token,
        csrf_token,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
    })
}

async fn insert_refresh_token(
    tx: &mut Transaction<'_, Postgres>,
    token_id: &str,
    session_id: &str,
    raw_token: &str,
    expires_at: DateTime<Utc>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO auth_refresh_tokens
         (refresh_token_id, session_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(token_id)
    .bind(session_id)
    .bind(sha256_hex(raw_token))
    .bind(expires_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn rotate_refresh_token(
    db: &PgPool,
    config: &Config,
    raw_token: &str,
    csrf_token: Option<&str>,
) -> Result<RotatedSession, AppError> {
    let mut tx = db.begin().await?;
    let row = sqlx::query(
        "SELECT rt.refresh_token_id, rt.session_id, rt.expires_at AS refresh_expires_at,
                rt.consumed_at, rt.revoked_at AS token_revoked_at,
                s.user_id, s.client_type, s.csrf_token_hash, s.absolute_expires_at,
                s.revoked_at AS session_revoked_at
         FROM auth_refresh_tokens rt
         JOIN auth_sessions s ON s.session_id = rt.session_id
         WHERE rt.token_hash = $1
         FOR UPDATE OF rt, s",
    )
    .bind(sha256_hex(raw_token))
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid refresh token".into()))?;

    let session_id: String = row.try_get("session_id")?;
    let user_id: String = row.try_get("user_id")?;
    let consumed_at: Option<DateTime<Utc>> = row.try_get("consumed_at").ok().flatten();
    if consumed_at.is_some() {
        revoke_session_in_tx(&mut tx, &session_id, "refresh_token_reuse").await?;
        sqlx::query(
            "INSERT INTO auth_security_events
             (event_id, user_id, session_id, event_type)
             VALUES ($1, $2, $3, 'refresh_token_reuse')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&user_id)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(AppError::Unauthorized(
            "refresh token reuse detected; session revoked".into(),
        ));
    }

    let now = Utc::now();
    let refresh_expires_at: DateTime<Utc> = row.try_get("refresh_expires_at")?;
    let absolute_expires_at: DateTime<Utc> = row.try_get("absolute_expires_at")?;
    let token_revoked: Option<DateTime<Utc>> = row.try_get("token_revoked_at").ok().flatten();
    let session_revoked: Option<DateTime<Utc>> = row.try_get("session_revoked_at").ok().flatten();
    if token_revoked.is_some()
        || session_revoked.is_some()
        || refresh_expires_at <= now
        || absolute_expires_at <= now
    {
        return Err(AppError::Unauthorized(
            "refresh token is expired or revoked".into(),
        ));
    }

    let client: String = row.try_get("client_type")?;
    let csrf_hash: Option<String> = row.try_get("csrf_token_hash").ok().flatten();
    if client == "web" && csrf_hash.as_deref() != csrf_token.map(sha256_hex).as_deref() {
        return Err(AppError::Unauthorized("invalid CSRF token".into()));
    }

    let new_token = random_secret()?;
    let new_id = Uuid::new_v4().to_string();
    let next_expiry = std::cmp::min(
        now + Duration::days(REFRESH_IDLE_TTL_DAYS),
        absolute_expires_at,
    );
    insert_refresh_token(&mut tx, &new_id, &session_id, &new_token, next_expiry).await?;
    sqlx::query(
        "UPDATE auth_refresh_tokens
         SET consumed_at = NOW(), replaced_by_id = $2
         WHERE refresh_token_id = $1 AND consumed_at IS NULL",
    )
    .bind(row.try_get::<String, _>("refresh_token_id")?)
    .bind(&new_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE auth_sessions SET last_seen_at = NOW() WHERE session_id = $1")
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let user = auth::load_auth_user(db, &user_id).await?;
    let user_uuid = user
        .id
        .parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;
    Ok(RotatedSession {
        access_token: auth::create_access_token(
            config,
            user_uuid,
            &user.role,
            user.token_version as i64,
            &session_id,
        )?,
        session_id,
        user,
        refresh_token: new_token,
        csrf_token: csrf_token.map(str::to_owned),
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
    })
}

async fn revoke_session_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    session_id: &str,
    reason: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = $2
         WHERE session_id = $1",
    )
    .bind(session_id)
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE session_id = $1",
    )
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE trusted_devices SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE session_id = $1",
    )
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn revoke_session(
    db: &PgPool,
    user_id: &str,
    session_id: &str,
) -> Result<bool, AppError> {
    let mut tx = db.begin().await?;
    let owned = sqlx::query(
        "SELECT 1 FROM auth_sessions WHERE session_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if owned {
        revoke_session_in_tx(&mut tx, session_id, "user_revoked").await?;
    }
    tx.commit().await?;
    Ok(owned)
}

pub async fn revoke_all_sessions(db: &PgPool, user_id: &str) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    let rows = sqlx::query("SELECT session_id FROM auth_sessions WHERE user_id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await?;
    for row in rows {
        let session_id: String = row.try_get("session_id")?;
        revoke_session_in_tx(&mut tx, &session_id, "logout_all").await?;
    }
    sqlx::query(
        "UPDATE trusted_devices SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Sensitive account changes require a password/provider authentication no
/// older than five minutes. A newly-created session is itself a valid step-up;
/// later explicit step-up flows can refresh `step_up_at` without replacing it.
pub async fn require_recent_auth(
    db: &PgPool,
    user_id: &str,
    session_id: &str,
) -> Result<(), AppError> {
    let recent = sqlx::query(
        "SELECT 1 FROM auth_sessions
         WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL
           AND absolute_expires_at > NOW()
           AND GREATEST(authenticated_at, COALESCE(step_up_at, authenticated_at))
               >= NOW() - INTERVAL '5 minutes'",
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .is_some();
    if !recent {
        return Err(AppError::PreconditionRequired(
            "recent authentication required; sign in again before changing account access".into(),
        ));
    }
    Ok(())
}

/// Identity changes keep the session that authorized the operation but revoke
/// every other session and every trusted-device credential for the account.
pub async fn revoke_other_sessions_and_trusted_devices(
    db: &PgPool,
    user_id: &str,
    current_session_id: &str,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    let rows = sqlx::query(
        "SELECT session_id FROM auth_sessions
         WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL
         FOR UPDATE",
    )
    .bind(user_id)
    .bind(current_session_id)
    .fetch_all(&mut *tx)
    .await?;
    for row in rows {
        let session_id: String = row.try_get("session_id")?;
        revoke_session_in_tx(&mut tx, &session_id, "identity_changed").await?;
    }
    sqlx::query(
        "UPDATE trusted_devices SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE user_id = $1",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn list_sessions(
    db: &PgPool,
    user_id: &str,
    current_session_id: &str,
) -> Result<Vec<SessionSummary>, AppError> {
    let rows = sqlx::query(
        "SELECT session_id, client_type, device_name, authenticated_at,
                last_seen_at, absolute_expires_at
         FROM auth_sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > NOW()
         ORDER BY last_seen_at DESC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            let session_id: String = row.try_get("session_id")?;
            Ok(SessionSummary {
                current: session_id == current_session_id,
                session_id,
                client: row.try_get("client_type")?,
                device_name: row.try_get("device_name").ok().flatten(),
                authenticated_at: row.try_get("authenticated_at")?,
                last_seen_at: row.try_get("last_seen_at")?,
                expires_at: row.try_get("absolute_expires_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::Db)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_type_is_fail_closed() {
        assert_eq!(ClientType::parse(None).unwrap(), ClientType::Web);
        assert_eq!(ClientType::parse(Some("ios")).unwrap(), ClientType::Ios);
        assert!(ClientType::parse(Some("android")).is_err());
    }

    #[test]
    fn generated_secrets_have_full_entropy_payload() {
        let one = random_secret().unwrap();
        let two = random_secret().unwrap();
        assert_ne!(one, two);
        assert_eq!(URL_SAFE_NO_PAD.decode(one).unwrap().len(), 32);
    }
}
