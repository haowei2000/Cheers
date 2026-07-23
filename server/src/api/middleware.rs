use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::app_state::AppState;

/// Issuer claim pinned on every gateway-minted JWT and verified on every request.
pub const JWT_ISSUER: &str = "cheers-gateway";

fn default_issuer() -> String {
    JWT_ISSUER.to_string()
}

/// User JWT claims. `sid` is deliberately required: user JWTs minted before
/// the unified-session rollout fail deserialization and must reauthenticate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // user_id
    pub sid: String, // auth_sessions.session_id
    pub role: String,
    pub exp: u64,
    pub iat: u64,
    #[serde(default)]
    pub nbf: u64,
    #[serde(default = "default_issuer")]
    pub iss: String,
    /// 会话吊销版本（W6）。旧 token 无此字段 → 反序列化为 0。
    #[serde(default)]
    pub token_version: u64,
}

/// 从 Authorization: Bearer <token> 提取 user_id，注入请求扩展。
/// 验签失败返回 401。
pub async fn jwt_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = extract_bearer(req.headers()).ok_or(StatusCode::UNAUTHORIZED)?;

    let claims =
        verify_rs256(&token, &state.config.jwt.decoding).map_err(|_| StatusCode::UNAUTHORIZED)?;

    if is_revoked(&state.db, &claims)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Err(StatusCode::UNAUTHORIZED);
    }

    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

/// A user token is valid only while both its account and exact session are active.
async fn is_revoked(db: &sqlx::PgPool, claims: &Claims) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        "SELECT u.token_version, u.is_suspended, u.is_deleted,
                s.revoked_at, s.absolute_expires_at
         FROM users u
         JOIN auth_sessions s ON s.user_id = u.user_id
         WHERE u.user_id = $1 AND s.session_id = $2",
    )
    .bind(&claims.sub)
    .bind(&claims.sid)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(true); // unknown user_id → treat as revoked
    };
    let db_version: i32 = row.try_get("token_version").unwrap_or(0);
    let suspended: bool = row.try_get("is_suspended").unwrap_or(false);
    let deleted: bool = row.try_get("is_deleted").unwrap_or(false);
    let session_revoked: Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("revoked_at").ok().flatten();
    let session_expiry: chrono::DateTime<chrono::Utc> = row.try_get("absolute_expires_at")?;
    Ok(deleted
        || suspended
        || session_revoked.is_some()
        || session_expiry <= chrono::Utc::now()
        || (claims.token_version as i64) < db_version as i64)
}

fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
}

/// WS handler 直接调用（不经过 axum middleware）。Performs the SAME DB-backed
/// revocation checks (token_version / is_suspended / is_deleted) as the HTTP
/// middleware, at connection time and on every in-connection re-auth — a
/// logged-out/banned user must not be able to open (or renew) a live socket
/// with a stale JWT. NOTE: an ALREADY-OPEN socket is only torn down when a
/// revocation path calls `Fanout::kick_user` (logout / password change+reset /
/// suspend / delete all do); sockets of users revoked by any other means
/// survive until they disconnect.
pub async fn verify_token(
    token: &str,
    state: &crate::app_state::AppState,
) -> Result<Claims, &'static str> {
    let claims =
        verify_rs256(token, &state.config.jwt.decoding).map_err(|_| "invalid or expired token")?;
    match is_revoked(&state.db, &claims).await {
        Ok(false) => Ok(claims),
        Ok(true) => Err("token revoked or account unavailable"),
        Err(_) => Err("auth check failed"),
    }
}

fn verify_rs256(token: &str, key: &DecodingKey) -> Result<Claims, jsonwebtoken::errors::Error> {
    // Algorithm is pinned by the decoding-key type (RS256); also enforce exp + nbf
    // and require our own issuer so tokens minted for another service can't be reused.
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.set_issuer(&[JWT_ISSUER]);
    decode::<Claims>(token, key, &validation).map(|d| d.claims)
}

#[cfg(test)]
mod tests {
    use super::Claims;

    #[test]
    fn pre_session_jwt_without_sid_is_rejected() {
        let value = serde_json::json!({
            "sub": "user",
            "role": "member",
            "exp": 2,
            "iat": 1,
            "iss": "cheers-gateway",
            "token_version": 0
        });
        assert!(serde_json::from_value::<Claims>(value).is_err());
    }
}
