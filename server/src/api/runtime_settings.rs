//! Admin-only runtime settings endpoints: live values, reviewed changes, and
//! their history. See `domain::runtime_settings`.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    api::middleware::Claims, app_state::AppState, domain::runtime_settings, errors::AppError,
};

fn require_admin(claims: &Claims) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(());
    }
    Err(AppError::Forbidden("admin only".into()))
}

/// GET /api/v1/admin/settings/runtime — every setting with its live value.
pub async fn list_settings(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    require_admin(&claims)?;
    Ok(Json(state.runtime_settings.list(&state.db).await?))
}

#[derive(Deserialize)]
pub struct PutSettingRequest {
    /// `null` removes the override and returns to the default.
    pub value: Option<u64>,
    pub reason: String,
}

/// PUT /api/v1/admin/settings/runtime/:key — apply a change and record who made
/// it and why. Live immediately; no restart.
pub async fn put_setting(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(key): Path<String>,
    Json(req): Json<PutSettingRequest>,
) -> Result<Json<Value>, AppError> {
    require_admin(&claims)?;
    state
        .runtime_settings
        .update(&state.db, &key, req.value, &claims.sub, &req.reason)
        .await?;
    Ok(Json(state.runtime_settings.list(&state.db).await?))
}

/// GET /api/v1/admin/settings/runtime/:key/revisions — newest-first history.
pub async fn list_revisions(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(key): Path<String>,
) -> Result<Json<Value>, AppError> {
    require_admin(&claims)?;
    Ok(Json(runtime_settings::revisions(&state.db, &key).await?))
}
