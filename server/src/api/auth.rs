use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{app_state::AppState, domain::auth, errors::AppError};

#[derive(Deserialize)]
pub struct LoginRequest {
    /// username 或 email
    pub login: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub user_id: String,
    pub display_name: Option<String>,
    pub role: String,
}

/// POST /api/v1/auth/login
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    // Throttle brute-force / bcrypt-DoS (audit H3): cap failed attempts per
    // client source; a successful login clears the counter.
    let limiter = crate::infra::ratelimit::login_limiter();
    let key = crate::infra::ratelimit::client_key(&headers);
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }

    let user = match auth::authenticate(&state.db, &body.login, &body.password).await {
        Ok(u) => u,
        Err(e) => {
            limiter.record_failure(&key);
            return Err(e);
        }
    };
    limiter.reset(&key);

    let user_uuid: Uuid = user
        .id
        .parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;

    let token =
        auth::create_access_token(&state.config, user_uuid, &user.role, user.token_version as i64)?;

    Ok(Json(LoginResponse {
        access_token: token,
        token_type: "bearer".into(),
        user_id: user.id,
        display_name: user.display_name,
        role: user.role,
    }))
}
