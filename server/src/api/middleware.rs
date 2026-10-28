use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

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

/// An authenticated token and the earliest deadline imposed by its exact session.
pub(crate) struct VerifiedSession {
    pub claims: Claims,
    pub valid_until: chrono::DateTime<chrono::Utc>,
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

    if session_valid_until(&state.db, &claims)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_none()
    {
        return Err(StatusCode::UNAUTHORIZED);
    }

    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

/// Authenticate when a bearer token is present, while still allowing login
/// flows to start anonymously. Invalid presented tokens never degrade to an
/// anonymous request.
pub async fn optional_jwt_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let Some(token) = extract_bearer(req.headers()) else {
        return Ok(next.run(req).await);
    };
    let claims =
        verify_rs256(&token, &state.config.jwt.decoding).map_err(|_| StatusCode::UNAUTHORIZED)?;
    if session_valid_until(&state.db, &claims)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_none()
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

/// Shared HTTP/WS authority check, also used after registering or rebinding a
/// socket. A deadline never extends beyond either the JWT or its exact session.
pub(crate) async fn session_valid_until(
    db: &sqlx::PgPool,
    claims: &Claims,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, sqlx::Error> {
    let Some(token_expiry) = i64::try_from(claims.exp)
        .ok()
        .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
    else {
        return Ok(None);
    };
    if token_expiry <= chrono::Utc::now() {
        return Ok(None);
    }
    let row = sqlx::query!(
        "SELECT u.token_version, u.is_suspended, u.is_deleted,
                s.revoked_at, s.absolute_expires_at
         FROM users u
         JOIN auth_sessions s ON s.user_id = u.user_id
         WHERE u.user_id = $1 AND s.session_id = $2",
        &claims.sub,
        &claims.sid,
    )
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.is_deleted
        || row.is_suspended
        || row.revoked_at.is_some()
        || i128::from(claims.token_version) < i128::from(row.token_version)
    {
        return Ok(None);
    }
    let valid_until = std::cmp::min(token_expiry, row.absolute_expires_at);
    Ok((valid_until > chrono::Utc::now()).then_some(valid_until))
}

fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
}

/// WS signature verification uses the same account/session check as HTTP and
/// returns the deadline that the socket must enforce without client traffic.
pub(crate) async fn verify_token(
    token: &str,
    state: &crate::app_state::AppState,
) -> Result<VerifiedSession, &'static str> {
    let claims =
        verify_rs256(token, &state.config.jwt.decoding).map_err(|_| "invalid or expired token")?;
    match session_valid_until(&state.db, &claims).await {
        Ok(Some(valid_until)) => Ok(VerifiedSession {
            claims,
            valid_until,
        }),
        Ok(None) => Err("token revoked or account unavailable"),
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
