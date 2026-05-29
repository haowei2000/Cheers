use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;

/// JWT Claims（RS256，payload 不变：{sub, role, exp, iat}）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,   // user_id
    pub role: String,
    pub exp: u64,
    pub iat: u64,
}

/// 从 Authorization: Bearer <token> 提取 user_id，注入请求扩展。
/// 验签失败返回 401。
pub async fn jwt_auth(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = extract_bearer(req.headers())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let claims = verify_rs256(&token, &state.config.jwt_public_key_pem)
        .or_else(|_| {
            // 迁移窗口期间同时接受旧 HS256 token
            state
                .config
                .jwt_legacy_hs256_secret
                .as_deref()
                .ok_or(())
                .and_then(|secret| verify_hs256(&token, secret).map_err(|_| ()))
        })
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
}

fn verify_rs256(token: &str, public_key_pem: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let key = DecodingKey::from_rsa_pem(public_key_pem.as_bytes())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = true;
    decode::<Claims>(token, &key, &validation).map(|d| d.claims)
}

fn verify_hs256(token: &str, secret: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    decode::<Claims>(token, &key, &validation).map(|d| d.claims)
}
