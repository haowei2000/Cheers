//! Device registration for OS push (docs/arch/MOBILE_APP_DESIGN.md §5.2).
//!
//! The app uploads its APNs device token after the user grants notification
//! permission; logout deletes it. Upsert is idempotent on the token (a token
//! that moves to another account follows the newest login). Dead tokens are
//! pruned by the push path when the transport reports them gone.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

#[derive(Deserialize)]
pub struct RegisterDeviceRequest {
    pub push_token: String,
    #[serde(default = "default_platform")]
    pub platform: String,
    pub device_name: Option<String>,
}

fn default_platform() -> String {
    "ios".into()
}

/// POST /api/v1/users/me/devices — register (or refresh) a push token.
pub async fn register_device(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<RegisterDeviceRequest>,
) -> Result<Json<Value>, AppError> {
    let token = body.push_token.trim();
    if token.is_empty() {
        return Err(AppError::BadRequest("push_token is required".into()));
    }
    sqlx::query(
        "INSERT INTO user_devices (user_id, push_token, platform, device_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (push_token) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                platform = EXCLUDED.platform,
                device_name = EXCLUDED.device_name,
                last_seen_at = now()",
    )
    .bind(&claims.sub)
    .bind(token)
    .bind(body.platform.trim())
    .bind(body.device_name.as_deref())
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/v1/users/me/devices/:push_token — called on logout so a revoked
/// session stops receiving pushes.
pub async fn delete_device(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(push_token): Path<String>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("DELETE FROM user_devices WHERE push_token = $1 AND user_id = $2")
        .bind(&push_token)
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
