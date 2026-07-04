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

/// JWT Claims（RS256）。新增字段对旧 token 前向兼容：`nbf`/`iss` 缺失时按 serde
/// 默认填充，`token_version` 缺失视为 0（会话吊销 W6 用，避免升级后全员掉线）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // user_id
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

/// Session revocation + account status (W6): a token is revoked when its user is
/// unknown/deleted/suspended, or the JWT predates a forced logout (token_version
/// bump). A token with no token_version claim defaults to 0, matching a fresh
/// user's row, so existing sessions survive the W6 rollout. One indexed PK
/// lookup per check; move to a Redis cache if it ever shows up on the hot path.
async fn is_revoked(db: &sqlx::PgPool, claims: &Claims) -> Result<bool, sqlx::Error> {
    let row =
        sqlx::query("SELECT token_version, is_suspended, is_deleted FROM users WHERE user_id = $1")
            .bind(&claims.sub)
            .fetch_optional(db)
            .await?;
    let Some(row) = row else {
        return Ok(true); // unknown user_id → treat as revoked
    };
    let db_version: i32 = row.try_get("token_version").unwrap_or(0);
    let suspended: bool = row.try_get("is_suspended").unwrap_or(false);
    let deleted: bool = row.try_get("is_deleted").unwrap_or(false);
    Ok(deleted || suspended || (claims.token_version as i64) < db_version as i64)
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
