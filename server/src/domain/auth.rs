use jsonwebtoken::{encode, Algorithm, Header};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{api::middleware::Claims, config::Config, errors::AppError};

/// Reset proof, the password version, and prior credentials have one commit.
/// Password hashing happens before entering this transaction.
pub async fn reset_password_with_code(
    db: &PgPool,
    email: &str,
    code_hash: &str,
    new_password_hash: &str,
) -> Result<super::auth_sessions::RevokedSessions, AppError> {
    let mut tx = db.begin().await?;
    // This is only a locator. Never choose a user by an ambiguous mailbox, or
    // reinterpret proof issued to an account that no longer owns the address.
    let owners = sqlx::query_scalar!(
        "SELECT DISTINCT user_id FROM email_codes
         WHERE email = $1 AND code_hash = $2 AND purpose = 'password_reset'
           AND used = FALSE AND expires_at > clock_timestamp()",
        email,
        code_hash,
    )
    .fetch_all(&mut *tx)
    .await?;
    let [Some(user_id)] = owners.as_slice() else {
        return Err(AppError::BadRequest("invalid or expired code".into()));
    };
    // Session issuance holds SHARE on this same user until its insert commits.
    // NO KEY UPDATE also remains compatible with credential/security-event FKs.
    let user_id = sqlx::query_scalar!(
        "SELECT user_id FROM users
         WHERE user_id = $1 AND lower(email) = $2 AND is_deleted = FALSE
         FOR NO KEY UPDATE",
        user_id,
        email,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::BadRequest("invalid or expired code".into()))?;
    let codes = sqlx::query!(
        "SELECT id, code_hash FROM email_codes
         WHERE email = $1 AND user_id = $2 AND purpose = 'password_reset' AND used = FALSE
         ORDER BY id FOR UPDATE",
        email,
        &user_id,
    )
    .fetch_all(&mut *tx)
    .await?;
    if !codes
        .iter()
        .any(|code| code.code_hash.as_deref() == Some(code_hash))
    {
        return Err(AppError::BadRequest("invalid or expired code".into()));
    }

    sqlx::query!(
        "UPDATE users SET password_hash = $2, token_version = token_version + 1
         WHERE user_id = $1",
        &user_id,
        new_password_hash,
    )
    .execute(&mut *tx)
    .await?;
    let revoked =
        super::auth_sessions::revoke_all_sessions_tx(&mut tx, &user_id, "password_reset").await?;
    // Check the clock after every credential lock wait, before consuming proof.
    let consumed = sqlx::query!(
        "UPDATE email_codes SET used = TRUE
         WHERE email = $1 AND code_hash = $2 AND purpose = 'password_reset'
           AND user_id = $3 AND used = FALSE AND expires_at > clock_timestamp()",
        email,
        code_hash,
        &user_id,
    )
    .execute(&mut *tx)
    .await?;
    if consumed.rows_affected() == 0 {
        return Err(AppError::BadRequest("invalid or expired code".into()));
    }
    sqlx::query!(
        "UPDATE email_codes SET used = TRUE
         WHERE user_id = $1 AND purpose = 'password_reset' AND used = FALSE",
        &user_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(revoked)
}

// ── JWT 签发 ─────────────────────────────────────────────────────────────────

pub fn create_access_token(
    config: &Config,
    user_id: Uuid,
    role: &str,
    token_version: i64,
    session_id: &str,
) -> Result<String, AppError> {
    let now = chrono::Utc::now();
    let iat = now.timestamp() as u64;
    let exp = (now + chrono::Duration::minutes(10)).timestamp() as u64;
    let claims = Claims {
        sub: user_id.to_string(),
        sid: session_id.to_string(),
        role: role.to_string(),
        exp,
        iat,
        nbf: iat,
        iss: crate::api::middleware::JWT_ISSUER.to_string(),
        token_version: token_version.max(0) as u64,
    };

    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("v1".into()); // kid 支持密钥轮换

    // Key parsed once at startup (config::JwtKeys) — bad PEM can't reach here.
    encode(&header, &claims, &config.jwt.encoding)
        .map_err(|e| AppError::Internal(format!("jwt encode: {e}")))
}

// ── 用户查找 + 密码验证 ────────────────────────────────────────────────────────

pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub role: String,
    pub token_version: i32,
}

pub async fn load_auth_user(db: &PgPool, user_id: &str) -> Result<AuthUser, AppError> {
    let row = sqlx::query!(
        "SELECT user_id, username, display_name, role, token_version, is_suspended
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
        user_id,
    )
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    if row.is_suspended.clone() {
        return Err(AppError::Forbidden("account suspended".into()));
    }
    Ok(AuthUser {
        id: row.user_id.clone(),
        username: row.username.clone(),
        display_name: row.display_name.clone(),
        role: row.role.clone(),
        token_version: row.token_version.clone(),
    })
}

/// 通过 username 或 email 查找用户，验证密码，返回用户信息。
pub async fn authenticate(
    db: &PgPool,
    login: &str, // username 或 email
    password: &str,
) -> Result<AuthUser, AppError> {
    let row = sqlx::query!(
        "SELECT user_id, username, password_hash, display_name, role, token_version, is_suspended
         FROM users
         WHERE (username = $1 OR email = $1) AND is_deleted = FALSE
         LIMIT 1",
        login,
    )
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .ok_or_else(|| AppError::Unauthorized("invalid credentials".into()))?;

    let hashed: Option<String> = row.password_hash.clone();
    let hashed = hashed
        .ok_or_else(|| AppError::Unauthorized("use Sign in with Apple for this account".into()))?;

    // Python passlib 使用 bcrypt（$2b$ 前缀）。bcrypt 是 CPU 密集（~200-300ms），
    // 放到 spawn_blocking 线程池执行，避免阻塞 tokio worker。
    let ok = crate::infra::crypto::verify_password(password.to_string(), hashed)
        .await
        .map_err(|_| AppError::Unauthorized("invalid credentials".into()))?;

    if !ok {
        return Err(AppError::Unauthorized("invalid credentials".into()));
    }

    if row.is_suspended.clone() {
        return Err(AppError::Forbidden("account suspended".into()));
    }

    Ok(AuthUser {
        id: row.user_id.clone(),
        username: row.username.clone(),
        display_name: row.display_name.clone(),
        role: row.role.clone(),
        token_version: row.token_version.clone(),
    })
}
