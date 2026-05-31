use axum::{extract::State, Json};
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
}

/// POST /api/v1/auth/login
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    let user = auth::authenticate(&state.db, &body.login, &body.password).await?;

    let user_uuid: Uuid = user.id.parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;

    let token = auth::create_access_token(&state.config, user_uuid, &user.role)?;

    Ok(Json(LoginResponse {
        access_token: token,
        token_type: "bearer".into(),
        user_id: user.id,
        display_name: user.display_name,
    }))
}
