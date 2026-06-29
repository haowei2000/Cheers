//! User account management endpoints (admin moderation today; self-service
//! profile + password change land in W16).

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

fn is_admin(claims: &Claims) -> bool {
    matches!(claims.role.as_str(), "system_admin" | "admin")
}

/// POST /api/v1/users/:user_id/suspend — admin bans a user and revokes every
/// live session by bumping token_version (audit M8 / W6).
pub async fn suspend_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    if user_id == claims.sub {
        return Err(AppError::BadRequest("cannot suspend yourself".into()));
    }
    let updated = sqlx::query(
        "UPDATE users
         SET is_suspended = TRUE, token_version = token_version + 1
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&user_id)
    .execute(&state.db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "user_id": user_id, "suspended": true })))
}

/// POST /api/v1/users/:user_id/unsuspend — admin lifts a ban. Existing tokens
/// stay revoked (token_version was bumped); the user must log in again.
pub async fn unsuspend_user(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(user_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    let updated = sqlx::query("UPDATE users SET is_suspended = FALSE WHERE user_id = $1")
        .bind(&user_id)
        .execute(&state.db)
        .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "user_id": user_id, "suspended": false })))
}
