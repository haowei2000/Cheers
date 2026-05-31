use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    config::Config,
    errors::AppError,
    api::middleware::Claims,
};

// ── JWT 签发 ─────────────────────────────────────────────────────────────────

pub fn create_access_token(config: &Config, user_id: Uuid, role: &str) -> Result<String, AppError> {
    let now = chrono::Utc::now();
    let exp = (now + chrono::Duration::hours(24)).timestamp() as u64;
    let claims = Claims {
        sub: user_id.to_string(),
        role: role.to_string(),
        exp,
        iat: now.timestamp() as u64,
    };

    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("v1".into()); // kid 支持密钥轮换

    let key = EncodingKey::from_rsa_pem(config.jwt_private_key_pem.as_bytes())
        .map_err(|e| AppError::Internal(format!("invalid private key: {e}")))?;

    encode(&header, &claims, &key)
        .map_err(|e| AppError::Internal(format!("jwt encode: {e}")))
}

// ── 用户查找 + 密码验证 ────────────────────────────────────────────────────────

pub struct AuthUser {
    pub id: String,
    pub display_name: Option<String>,
    pub role: String,
}

/// 通过 username 或 email 查找用户，验证密码，返回用户信息。
pub async fn authenticate(
    db: &PgPool,
    login: &str,   // username 或 email
    password: &str,
) -> Result<AuthUser, AppError> {
    let row = sqlx::query(
        "SELECT user_id, password_hash, display_name, role
         FROM users
         WHERE username = $1 OR email = $1
         LIMIT 1",
    )
    .bind(login)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .ok_or_else(|| AppError::Unauthorized("invalid credentials".into()))?;

    let hashed: String = row.try_get("password_hash").map_err(AppError::Db)?;

    // Python passlib 使用 bcrypt（$2b$ 前缀）
    let ok = bcrypt::verify(password, &hashed)
        .map_err(|_| AppError::Unauthorized("invalid credentials".into()))?;

    if !ok {
        return Err(AppError::Unauthorized("invalid credentials".into()));
    }

    Ok(AuthUser {
        id: row.try_get("user_id").map_err(AppError::Db)?,
        display_name: row.try_get("display_name").ok(),
        role: row.try_get("role").unwrap_or_else(|_| "user".to_string()),
    })
}
