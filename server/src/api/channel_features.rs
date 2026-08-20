use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Serialize;
use serde_json::json;

use crate::{
    api::{channels::ensure_channel_admin, middleware::Claims},
    app_state::AppState,
    domain::channel_features,
    errors::AppError,
};

#[derive(Serialize)]
pub struct ChannelFeaturesResponse {
    pub channel_id: String,
    pub features: Vec<String>,
}

pub async fn enable_feature(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, feature)): Path<(String, String)>,
) -> Result<Json<ChannelFeaturesResponse>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    if !channel_features::supported(&feature) {
        return Err(AppError::BadRequest("unsupported channel feature".into()));
    }
    channel_features::enable(&state.db, &channel_id, &feature, &json!({})).await?;
    Ok(Json(ChannelFeaturesResponse {
        channel_id: channel_id.clone(),
        features: channel_features::list(&state.db, &channel_id).await?,
    }))
}

pub async fn disable_feature(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, feature)): Path<(String, String)>,
) -> Result<Json<ChannelFeaturesResponse>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    if !channel_features::supported(&feature) {
        return Err(AppError::BadRequest("unsupported channel feature".into()));
    }
    if feature == channel_features::VOICE {
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM voice_sessions
              WHERE channel_id = $1 AND ended_at IS NULL)",
        )
        .bind(&channel_id)
        .fetch_one(&state.db)
        .await?;
        if active {
            return Err(AppError::Conflict(
                "end the active voice session before disabling Voice".into(),
            ));
        }
    }
    channel_features::disable(&state.db, &channel_id, &feature).await?;
    Ok(Json(ChannelFeaturesResponse {
        channel_id: channel_id.clone(),
        features: channel_features::list(&state.db, &channel_id).await?,
    }))
}
