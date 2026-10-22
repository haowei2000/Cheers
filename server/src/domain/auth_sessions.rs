use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
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
// Rotating a web cookie can briefly race across tabs. A duplicate inside this window
// receives a retryable conflict, but never a replacement token. Older reuse still
// revokes the session as a likely stolen-token signal.
const WEB_REFRESH_CONCURRENCY_GRACE_SECONDS: i64 = 5;
const MAX_FACTOR_ATTEMPTS: i16 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientType {
    Web,
    Ios,
    Macos,
    Android,
}

impl ClientType {
    pub fn parse(value: Option<&str>) -> Result<Self, AppError> {
        match value.unwrap_or("web") {
            "web" => Ok(Self::Web),
            "ios" => Ok(Self::Ios),
            "macos" => Ok(Self::Macos),
            "android" => Ok(Self::Android),
            _ => Err(AppError::BadRequest(
                "client must be web, ios, macos, or android".into(),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Ios => "ios",
            Self::Macos => "macos",
            Self::Android => "android",
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

/// Exact committed session identities whose live browser connections must close.
#[derive(Debug)]
pub struct RevokedSessions {
    pub user_id: Uuid,
    pub session_ids: Vec<String>,
}

impl RevokedSessions {
    fn new(user_id: &str, session_ids: Vec<String>) -> Result<Self, AppError> {
        Ok(Self {
            user_id: user_id
                .parse()
                .map_err(|_| AppError::Internal("invalid revoked session user id".into()))?,
            session_ids,
        })
    }
}

pub enum RefreshOutcome {
    Rotated(RotatedSession),
    /// Reuse is an authenticated security outcome, committed before it is
    /// returned. The adapter closes these sessions before returning its 401.
    ReuseRevoked(RevokedSessions),
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

pub enum LoginProof<'a> {
    /// This user/version was captured before verifying the primary credential.
    Primary {
        user: &'a AuthUser,
        factor: &'a str,
    },
    StoredPrimary {
        factor: &'a str,
    },
}

pub struct CompletedLogin {
    pub user: AuthUser,
    pub session: IssuedSession,
    pub client: ClientType,
    pub trusted_device: Option<String>,
}

struct LoginTransaction {
    user_id: Option<String>,
    session_id: Option<String>,
    kind: String,
    status: String,
    client_type: String,
    context_json: serde_json::Value,
    failed_attempts: i16,
    expires_at: DateTime<Utc>,
    consumed_at: Option<DateTime<Utc>>,
}

fn invalid_login_transaction() -> AppError {
    AppError::Unauthorized("authentication transaction is invalid; restart sign-in".into())
}

fn changed_authentication() -> AppError {
    AppError::Unauthorized("authentication changed; sign in again".into())
}

async fn database_now(tx: &mut Transaction<'_, Postgres>) -> Result<DateTime<Utc>, AppError> {
    Ok(sqlx::query_scalar!(r#"SELECT clock_timestamp() AS "now!""#)
        .fetch_one(&mut **tx)
        .await?)
}

async fn lock_auth_user(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
) -> Result<AuthUser, AppError> {
    let row = sqlx::query!(
        "SELECT user_id, username, display_name, role, token_version, is_suspended
         FROM users WHERE user_id = $1 AND is_deleted = FALSE FOR SHARE",
        user_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(changed_authentication)?;
    if row.is_suspended {
        return Err(changed_authentication());
    }
    Ok(AuthUser {
        id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        token_version: row.token_version,
    })
}

async fn lock_login_transaction(
    tx: &mut Transaction<'_, Postgres>,
    transaction_id: &str,
    expected_user_id: &str,
) -> Result<(AuthUser, LoginTransaction), AppError> {
    // Credential replacement takes the user lock before touching sessions. All
    // proof transitions and issuance use this same user -> transaction order.
    let user = lock_auth_user(tx, expected_user_id).await?;
    let transaction = sqlx::query_as!(
        LoginTransaction,
        "SELECT user_id, session_id, kind, status, client_type, context_json,
                failed_attempts, expires_at, consumed_at
         FROM auth_transactions WHERE transaction_id = $1 FOR UPDATE",
        transaction_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(invalid_login_transaction)?;
    let now = database_now(tx).await?;
    if transaction.user_id.as_deref() != Some(expected_user_id)
        || transaction.session_id.is_some()
        || transaction.kind != "login"
        || transaction.consumed_at.is_some()
        || transaction.failed_attempts >= MAX_FACTOR_ATTEMPTS
        || transaction.expires_at <= now
    {
        return Err(invalid_login_transaction());
    }
    Ok((user, transaction))
}

fn stored_primary<'a>(
    user: &AuthUser,
    transaction: &'a LoginTransaction,
    secondary_factor: Option<&str>,
) -> Result<&'a str, AppError> {
    if transaction.status != "factor_required" {
        return Err(invalid_login_transaction());
    }
    let version = transaction.context_json["primary_token_version"]
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(changed_authentication)?;
    let primary = transaction.context_json["primary_factor"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(changed_authentication)?;
    if version != user.token_version {
        return Err(changed_authentication());
    }
    if secondary_factor.is_some_and(|factor| factor == primary || factor.is_empty()) {
        return Err(AppError::Unauthorized(
            "the primary sign-in method cannot be reused as the second factor".into(),
        ));
    }
    Ok(primary)
}

fn is_concurrent_web_refresh(client: &str, consumed_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    let age = now.signed_duration_since(consumed_at);
    client == "web"
        && age >= Duration::zero()
        && age <= Duration::seconds(WEB_REFRESH_CONCURRENCY_GRACE_SECONDS)
}

fn random_secret() -> Result<String, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| AppError::Internal(format!("secure random generation failed: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub async fn create_factor_transaction(
    db: &PgPool,
    verified_user: &AuthUser,
    client: ClientType,
    device_name: Option<&str>,
    primary_factor: &str,
) -> Result<FactorTransaction, AppError> {
    let transaction_id = Uuid::new_v4().to_string();
    let mut tx = db.begin().await?;
    let user = lock_auth_user(&mut tx, &verified_user.id).await?;
    if user.token_version != verified_user.token_version || primary_factor.is_empty() {
        return Err(changed_authentication());
    }
    let expires_at = database_now(&mut tx).await? + Duration::minutes(AUTH_TRANSACTION_TTL_MINUTES);
    sqlx::query!(
        "INSERT INTO auth_transactions
         (transaction_id, user_id, kind, status, client_type, context_json, expires_at)
         VALUES ($1, $2, 'login', 'factor_required', $3, $4, $5)",
        &transaction_id,
        &user.id,
        client.as_str(),
        json!({
            "device_name": device_name,
            "primary_factor": primary_factor,
            "primary_token_version": verified_user.token_version,
        }),
        expires_at,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(FactorTransaction { transaction_id })
}

pub async fn factor_transaction_user(
    db: &PgPool,
    transaction_id: &str,
) -> Result<(String, String), AppError> {
    let mut tx = db.begin().await?;
    // This first read is only a locator; the owned row is re-read under locks.
    let user_id = sqlx::query_scalar!(
        "SELECT user_id FROM auth_transactions WHERE transaction_id = $1 AND kind = 'login'",
        transaction_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .flatten()
    .ok_or_else(invalid_login_transaction)?;
    let (user, transaction) = lock_login_transaction(&mut tx, transaction_id, &user_id).await?;
    let primary_factor = stored_primary(&user, &transaction, None)?.to_owned();
    tx.commit().await?;
    Ok((user_id, primary_factor))
}

/// Reject stale or repeated primary proof before consuming an OTP/assertion.
pub async fn validate_stored_primary(
    db: &PgPool,
    transaction_id: &str,
    expected_user_id: &str,
    secondary_factor: &str,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    let (user, transaction) =
        lock_login_transaction(&mut tx, transaction_id, expected_user_id).await?;
    stored_primary(&user, &transaction, Some(secondary_factor))?;
    tx.commit().await?;
    Ok(())
}

pub async fn require_second_factor(
    db: &PgPool,
    transaction_id: &str,
    verified_user: &AuthUser,
    primary_factor: &str,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    let (user, transaction) =
        lock_login_transaction(&mut tx, transaction_id, &verified_user.id).await?;
    if transaction.status != "method_required"
        || user.token_version != verified_user.token_version
        || primary_factor.is_empty()
    {
        return Err(changed_authentication());
    }
    let updated = sqlx::query!(
        "UPDATE auth_transactions
         SET status = 'factor_required', context_json = context_json || $2,
             updated_at = clock_timestamp()
         WHERE transaction_id = $1 AND status = 'method_required'
           AND consumed_at IS NULL AND expires_at > clock_timestamp() AND failed_attempts < 5",
        transaction_id,
        json!({
            "primary_factor": primary_factor,
            "primary_token_version": verified_user.token_version,
        }),
    )
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(invalid_login_transaction());
    }
    tx.commit().await?;
    Ok(())
}

pub async fn complete_transaction_login(
    db: &PgPool,
    config: &Config,
    transaction_id: &str,
    expected_user_id: &str,
    proof: LoginProof<'_>,
    remember_device: bool,
) -> Result<CompletedLogin, AppError> {
    let mut tx = db.begin().await?;
    let (user, transaction) =
        lock_login_transaction(&mut tx, transaction_id, expected_user_id).await?;
    let proof_context = match proof {
        LoginProof::Primary {
            user: verified,
            factor,
        } => {
            if transaction.status != "method_required"
                || verified.id != user.id
                || verified.token_version != user.token_version
                || factor.is_empty()
                || transaction
                    .context_json
                    .get("primary_token_version")
                    .is_some()
                || transaction.context_json.get("primary_factor").is_some()
            {
                return Err(changed_authentication());
            }
            json!({
                "primary_factor": factor,
                "primary_token_version": verified.token_version,
            })
        }
        LoginProof::StoredPrimary { factor } => {
            stored_primary(&user, &transaction, Some(factor))?;
            json!({})
        }
    };
    let client = ClientType::parse(Some(&transaction.client_type))?;
    let device_name = transaction.context_json["device_name"].as_str();
    let completed =
        insert_completed_login(&mut tx, config, user, client, device_name, remember_device).await?;
    let consumed = sqlx::query!(
        "UPDATE auth_transactions
         SET status = 'consumed', consumed_at = clock_timestamp(), updated_at = clock_timestamp(),
             context_json = context_json || $2
         WHERE transaction_id = $1 AND kind = 'login'
           AND status IN ('method_required', 'factor_required')
           AND consumed_at IS NULL AND expires_at > clock_timestamp() AND failed_attempts < 5",
        transaction_id,
        proof_context,
    )
    .execute(&mut *tx)
    .await?;
    if consumed.rows_affected() != 1 {
        return Err(invalid_login_transaction());
    }
    tx.commit().await?;
    Ok(completed)
}

pub async fn record_factor_failure(db: &PgPool, transaction_id: &str) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE auth_transactions
         SET failed_attempts = LEAST(failed_attempts + 1, 5),
             status = CASE WHEN failed_attempts + 1 >= 5 THEN 'failed' ELSE status END,
             updated_at = NOW()
         WHERE transaction_id = $1 AND consumed_at IS NULL",
        transaction_id,
    )
    .execute(db)
    .await?;
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
    let result = sqlx::query!(
        "UPDATE trusted_devices SET last_used_at = NOW()
         WHERE user_id = $1 AND credential_hash = $2
           AND revoked_at IS NULL AND expires_at > NOW()",
        user_id,
        sha256_hex(credential),
    )
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
    let mut tx = db.begin().await?;
    let session = sqlx::query!(
        "SELECT user_id, revoked_at, absolute_expires_at FROM auth_sessions
         WHERE session_id = $1 FOR SHARE",
        session_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("session is no longer active".into()))?;
    let now = database_now(&mut tx).await?;
    if session.user_id != user_id
        || session.revoked_at.is_some()
        || session.absolute_expires_at <= now
    {
        return Err(AppError::Unauthorized("session is no longer active".into()));
    }
    let credential = insert_trusted_device(&mut tx, user_id, session_id, device_name, now).await?;
    tx.commit().await?;
    Ok(credential)
}

async fn insert_trusted_device(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    session_id: &str,
    device_name: Option<&str>,
    now: DateTime<Utc>,
) -> Result<String, AppError> {
    let credential = random_secret()?;
    sqlx::query!(
        "INSERT INTO trusted_devices
         (trusted_device_id, user_id, session_id, credential_hash, device_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)",
        Uuid::new_v4().to_string(),
        user_id,
        session_id,
        sha256_hex(&credential),
        device_name,
        now + Duration::days(TRUSTED_DEVICE_TTL_DAYS),
    )
    .execute(&mut **tx)
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
    let mut tx = db.begin().await?;
    let current_user = lock_auth_user(&mut tx, &user.id).await?;
    if current_user.token_version != user.token_version {
        return Err(changed_authentication());
    }
    let now = database_now(&mut tx).await?;
    let session = insert_session(&mut tx, config, &current_user, client, device_name, now).await?;
    tx.commit().await?;
    Ok(session)
}

/// A verified primary that needs no challenge still issues all credentials in
/// one transaction, including optional device trust.
pub async fn complete_direct_login(
    db: &PgPool,
    config: &Config,
    verified_user: &AuthUser,
    client: ClientType,
    device_name: Option<&str>,
    remember_device: bool,
) -> Result<CompletedLogin, AppError> {
    let mut tx = db.begin().await?;
    let user = lock_auth_user(&mut tx, &verified_user.id).await?;
    if user.token_version != verified_user.token_version {
        return Err(changed_authentication());
    }
    let completed =
        insert_completed_login(&mut tx, config, user, client, device_name, remember_device).await?;
    tx.commit().await?;
    Ok(completed)
}

async fn insert_completed_login(
    tx: &mut Transaction<'_, Postgres>,
    config: &Config,
    user: AuthUser,
    client: ClientType,
    device_name: Option<&str>,
    remember_device: bool,
) -> Result<CompletedLogin, AppError> {
    let now = database_now(tx).await?;
    let session = insert_session(tx, config, &user, client, device_name, now).await?;
    let trusted_device = if remember_device {
        Some(insert_trusted_device(tx, &user.id, &session.session_id, device_name, now).await?)
    } else {
        None
    };
    Ok(CompletedLogin {
        user,
        session,
        client,
        trusted_device,
    })
}

async fn insert_session(
    tx: &mut Transaction<'_, Postgres>,
    config: &Config,
    user: &AuthUser,
    client: ClientType,
    device_name: Option<&str>,
    now: DateTime<Utc>,
) -> Result<IssuedSession, AppError> {
    let session_id = Uuid::new_v4().to_string();
    let family_id = Uuid::new_v4().to_string();
    let refresh_token_id = Uuid::new_v4().to_string();
    let refresh_token = random_secret()?;
    let csrf_token = random_secret()?;
    let absolute_expires_at = now + Duration::days(SESSION_ABSOLUTE_TTL_DAYS);
    let refresh_expires_at = now + Duration::days(REFRESH_IDLE_TTL_DAYS);
    let user_uuid = user
        .id
        .parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;
    let access_token = auth::create_access_token(
        config,
        user_uuid,
        &user.role,
        user.token_version as i64,
        &session_id,
    )?;
    sqlx::query!(
        "INSERT INTO auth_sessions
         (session_id, user_id, client_type, device_name, token_family_id,
          csrf_token_hash, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        &session_id,
        &user.id,
        client.as_str(),
        device_name,
        family_id,
        sha256_hex(&csrf_token),
        absolute_expires_at,
    )
    .execute(&mut **tx)
    .await?;
    insert_refresh_token(
        tx,
        &refresh_token_id,
        &session_id,
        &refresh_token,
        refresh_expires_at,
    )
    .await?;
    Ok(IssuedSession {
        access_token,
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
    sqlx::query!(
        "INSERT INTO auth_refresh_tokens
         (refresh_token_id, session_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)",
        token_id,
        session_id,
        sha256_hex(raw_token),
        expires_at,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn rotate_refresh_token(
    db: &PgPool,
    config: &Config,
    raw_token: &str,
    csrf_token: Option<&str>,
) -> Result<RefreshOutcome, AppError> {
    let mut tx = db.begin().await?;
    let token_hash = sha256_hex(raw_token);
    let session_id = sqlx::query_scalar!(
        "SELECT session_id FROM auth_refresh_tokens WHERE token_hash = $1",
        &token_hash,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid refresh token".into()))?;
    // Every credential revoker takes session -> refresh-token locks. The
    // unlocked lookup above is only a locator; both authoritative rows follow.
    let session = sqlx::query!(
        "SELECT user_id, client_type, csrf_token_hash, absolute_expires_at, revoked_at
         FROM auth_sessions WHERE session_id = $1 FOR UPDATE",
        &session_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid refresh token".into()))?;
    let row = sqlx::query!(
        "SELECT refresh_token_id, expires_at, consumed_at, revoked_at
         FROM auth_refresh_tokens WHERE token_hash = $1 AND session_id = $2 FOR UPDATE",
        &token_hash,
        &session_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid refresh token".into()))?;

    let user_id: String = session.user_id.clone();
    let client: String = session.client_type.clone();
    let consumed_at: Option<DateTime<Utc>> = row.consumed_at.clone();
    let now = Utc::now();
    if consumed_at.is_some_and(|consumed_at| is_concurrent_web_refresh(&client, consumed_at, now)) {
        return Err(AppError::Conflict(
            "refresh token was already rotated; retry with the current cookie".into(),
        ));
    }
    if consumed_at.is_some() {
        let revoked = RevokedSessions::new(&user_id, vec![session_id.clone()])?;
        revoke_session_in_tx(&mut tx, &session_id, "refresh_token_reuse").await?;
        sqlx::query!(
            "INSERT INTO auth_security_events
             (event_id, user_id, session_id, event_type)
             VALUES ($1, $2, $3, 'refresh_token_reuse')",
            Uuid::new_v4().to_string(),
            &user_id,
            &session_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(RefreshOutcome::ReuseRevoked(revoked));
    }

    let refresh_expires_at: DateTime<Utc> = row.expires_at;
    let absolute_expires_at: DateTime<Utc> = session.absolute_expires_at;
    let token_revoked: Option<DateTime<Utc>> = row.revoked_at;
    let session_revoked: Option<DateTime<Utc>> = session.revoked_at;
    if token_revoked.is_some()
        || session_revoked.is_some()
        || refresh_expires_at <= now
        || absolute_expires_at <= now
    {
        return Err(AppError::Unauthorized(
            "refresh token is expired or revoked".into(),
        ));
    }

    let csrf_hash: Option<String> = session.csrf_token_hash.clone();
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
    sqlx::query!(
        "UPDATE auth_refresh_tokens
         SET consumed_at = NOW(), replaced_by_id = $2
         WHERE refresh_token_id = $1 AND consumed_at IS NULL",
        row.refresh_token_id.clone(),
        &new_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE auth_sessions SET last_seen_at = NOW() WHERE session_id = $1",
        &session_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let user = auth::load_auth_user(db, &user_id).await?;
    let user_uuid = user
        .id
        .parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;
    Ok(RefreshOutcome::Rotated(RotatedSession {
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
    }))
}

async fn revoke_session_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    session_id: &str,
    reason: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = $2
         WHERE session_id = $1",
        session_id,
        reason,
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query!(
        "UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE session_id = $1",
        session_id,
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query!(
        "UPDATE trusted_devices SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE session_id = $1",
        session_id,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn revoke_session(
    db: &PgPool,
    user_id: &str,
    session_id: &str,
) -> Result<Option<RevokedSessions>, AppError> {
    let mut tx = db.begin().await?;
    let owned = sqlx::query!(
        "SELECT 1 AS present FROM auth_sessions WHERE session_id = $1 AND user_id = $2 FOR UPDATE",
        session_id,
        user_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    let revoked = if owned {
        let revoked = RevokedSessions::new(user_id, vec![session_id.to_owned()])?;
        revoke_session_in_tx(&mut tx, session_id, "user_revoked").await?;
        Some(revoked)
    } else {
        None
    };
    tx.commit().await?;
    Ok(revoked)
}

pub async fn revoke_all_sessions(db: &PgPool, user_id: &str) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    revoke_all_sessions_tx(&mut tx, user_id, "logout_all").await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn revoke_all_sessions_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    reason: &str,
) -> Result<RevokedSessions, AppError> {
    let rows = sqlx::query!(
        "SELECT session_id FROM auth_sessions WHERE user_id = $1
         ORDER BY session_id FOR UPDATE",
        user_id,
    )
    .fetch_all(&mut **tx)
    .await?;
    let revoked = RevokedSessions::new(
        user_id,
        rows.into_iter().map(|row| row.session_id).collect(),
    )?;
    for session_id in &revoked.session_ids {
        revoke_session_in_tx(tx, session_id, reason).await?;
    }
    sqlx::query!(
        "UPDATE trusted_devices SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1",
        user_id,
    )
    .execute(&mut **tx)
    .await?;
    Ok(revoked)
}

/// Security-sensitive identity, credential, and delegated-authority changes
/// require authentication no older than fifteen minutes. A newly-created session
/// is itself a valid step-up; later explicit step-up flows can refresh
/// `step_up_at` without replacing it.
pub async fn require_recent_auth(
    db: &PgPool,
    user_id: &str,
    session_id: &str,
) -> Result<(), AppError> {
    let recent = sqlx::query!(
        "SELECT 1 AS present FROM auth_sessions
         WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL
           AND absolute_expires_at > NOW()
           AND GREATEST(authenticated_at, COALESCE(step_up_at, authenticated_at))
               >= NOW() - INTERVAL '15 minutes'",
        session_id,
        user_id,
    )
    .fetch_optional(db)
    .await?
    .is_some();
    if !recent {
        return Err(AppError::PreconditionRequired(
            json!({
                "code": "recent_authentication_required",
                "detail": "Confirm your identity before changing security-sensitive access."
            })
            .to_string(),
        ));
    }
    Ok(())
}

/// Mark the current active session as freshly verified without rotating its
/// access/refresh credentials. This is the core difference between step-up and
/// a new login.
pub async fn complete_step_up(
    db: &PgPool,
    transaction_id: &str,
    user_id: &str,
    session_id: &str,
    factor: &str,
) -> Result<DateTime<Utc>, AppError> {
    let mut tx = db.begin().await?;
    let context: Option<serde_json::Value> = sqlx::query_scalar!(
        "UPDATE auth_transactions
         SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
         WHERE transaction_id = $1 AND kind = 'step_up'
           AND user_id = $2 AND session_id = $3
           AND status IN ('method_required', 'factor_required', 'verified')
           AND consumed_at IS NULL AND expires_at > NOW()
         RETURNING context_json",
        transaction_id,
        user_id,
        session_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    if context.is_none() {
        return Err(AppError::Unauthorized(
            "authentication transaction is invalid or already used".into(),
        ));
    }
    let stepped_up_at: DateTime<Utc> = sqlx::query_scalar!(
        r#"UPDATE auth_sessions
         SET step_up_at = NOW(), last_seen_at = NOW()
         WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL
           AND absolute_expires_at > NOW()
         RETURNING step_up_at AS "value!""#,
        session_id,
        user_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("session is no longer active".into()))?;
    sqlx::query!(
        "INSERT INTO auth_security_events
         (event_id, user_id, session_id, event_type, factor, metadata)
         VALUES ($1, $2, $3, 'step_up_succeeded', $4, $5)",
        Uuid::new_v4().to_string(),
        user_id,
        session_id,
        factor,
        json!({
            "action_class": context
                .and_then(|value| value.get("action_class").cloned())
        }),
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(stepped_up_at + Duration::minutes(15))
}

/// Reuse a strong factor that the sensitive operation itself just verified.
/// This avoids prompting twice while preserving the same fixed session window.
pub async fn record_direct_step_up(
    db: &PgPool,
    user_id: &str,
    session_id: &str,
    factor: &str,
    action_class: &str,
) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    let updated = sqlx::query!(
        "UPDATE auth_sessions SET step_up_at = NOW(), last_seen_at = NOW()
         WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL
           AND absolute_expires_at > NOW()",
        session_id,
        user_id,
    )
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::Unauthorized("session is no longer active".into()));
    }
    sqlx::query!(
        "INSERT INTO auth_security_events
         (event_id, user_id, session_id, event_type, factor, metadata)
         VALUES ($1, $2, $3, 'step_up_succeeded', $4, $5)",
        Uuid::new_v4().to_string(),
        user_id,
        session_id,
        factor,
        json!({ "action_class": action_class, "proof_reused": true }),
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Identity changes keep the session that authorized the operation but revoke
/// every other session and every trusted-device credential for the account.
/// The caller commits this together with its identity mutation before applying
/// the returned live-session revocations. Concurrent new logins are separate.
pub(crate) async fn revoke_other_sessions_and_trusted_devices_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    current_session_id: &str,
) -> Result<RevokedSessions, AppError> {
    let rows = sqlx::query!(
        "SELECT session_id FROM auth_sessions
         WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL
         ORDER BY session_id FOR UPDATE",
        user_id,
        current_session_id,
    )
    .fetch_all(&mut **tx)
    .await?;
    let revoked = RevokedSessions::new(
        user_id,
        rows.into_iter().map(|row| row.session_id).collect(),
    )?;
    for session_id in &revoked.session_ids {
        revoke_session_in_tx(tx, session_id, "identity_changed").await?;
    }
    sqlx::query!(
        "UPDATE trusted_devices SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE user_id = $1",
        user_id,
    )
    .execute(&mut **tx)
    .await?;
    Ok(revoked)
}

#[derive(Serialize)]
pub struct TrustedDeviceSummary {
    pub trusted_device_id: String,
    pub device_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    /// True when this credential belongs to the session making the request.
    pub current: bool,
}

/// Trusted devices skip the second step at sign-in, so they are worth showing
/// and revoking in Settings rather than being invisible 30-day state.
pub async fn list_trusted_devices(
    db: &PgPool,
    user_id: &str,
    current_session_id: &str,
) -> Result<Vec<TrustedDeviceSummary>, AppError> {
    let rows = sqlx::query!(
        "SELECT trusted_device_id, session_id, device_name, created_at,
                last_used_at, expires_at
         FROM trusted_devices
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
         ORDER BY COALESCE(last_used_at, created_at) DESC",
        user_id,
    )
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            let session_id: Option<String> = row.session_id.clone();
            Ok(TrustedDeviceSummary {
                trusted_device_id: row.trusted_device_id.clone(),
                device_name: row.device_name.clone(),
                created_at: row.created_at.clone(),
                last_used_at: row.last_used_at.clone(),
                expires_at: row.expires_at.clone(),
                current: session_id.as_deref() == Some(current_session_id),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::Db)
}

pub async fn revoke_trusted_device(
    db: &PgPool,
    user_id: &str,
    trusted_device_id: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query!(
        "UPDATE trusted_devices SET revoked_at = NOW()
         WHERE user_id = $1 AND trusted_device_id = $2 AND revoked_at IS NULL",
        user_id,
        trusted_device_id,
    )
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Revoke every live trusted device for the user.
///
/// Called when two-step verification turns on: a "remember this device"
/// credential minted while the account was unprotected must not bypass the
/// factor that was just armed. Without this, arming 2FA silently does nothing
/// on devices the user had already ticked "remember me" on.
pub async fn revoke_all_trusted_devices(db: &PgPool, user_id: &str) -> Result<u64, AppError> {
    let result = sqlx::query!(
        "UPDATE trusted_devices SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL",
        user_id,
    )
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

pub async fn list_sessions(
    db: &PgPool,
    user_id: &str,
    current_session_id: &str,
) -> Result<Vec<SessionSummary>, AppError> {
    let rows = sqlx::query!(
        "SELECT session_id, client_type, device_name, authenticated_at,
                last_seen_at, absolute_expires_at
         FROM auth_sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > NOW()
         ORDER BY last_seen_at DESC",
        user_id,
    )
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|row| {
            let session_id: String = row.session_id.clone();
            Ok(SessionSummary {
                current: session_id == current_session_id,
                session_id,
                client: row.client_type.clone(),
                device_name: row.device_name.clone(),
                authenticated_at: row.authenticated_at.clone(),
                last_seen_at: row.last_seen_at.clone(),
                expires_at: row.absolute_expires_at.clone(),
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
        assert_eq!(
            ClientType::parse(Some("android")).unwrap(),
            ClientType::Android
        );
        assert!(ClientType::parse(Some("unknown")).is_err());
    }

    #[test]
    fn generated_secrets_have_full_entropy_payload() {
        let one = random_secret().unwrap();
        let two = random_secret().unwrap();
        assert_ne!(one, two);
        assert_eq!(URL_SAFE_NO_PAD.decode(one).unwrap().len(), 32);
    }

    #[test]
    fn web_refresh_reuse_is_tolerated_only_inside_concurrency_window() {
        let now = Utc::now();
        assert!(is_concurrent_web_refresh(
            "web",
            now - Duration::seconds(WEB_REFRESH_CONCURRENCY_GRACE_SECONDS),
            now,
        ));
        assert!(!is_concurrent_web_refresh(
            "web",
            now - Duration::seconds(WEB_REFRESH_CONCURRENCY_GRACE_SECONDS + 1),
            now,
        ));
        assert!(!is_concurrent_web_refresh(
            "macos",
            now - Duration::seconds(1),
            now,
        ));
    }
}
