//! HTTP surface for generic channel workflow profiles.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;

use crate::{
    api::{channels::ensure_channel_admin, middleware::Claims},
    app_state::AppState,
    domain::{
        channel_profiles::{self, CodeProfileConfig, CodeProfileStatus},
        integrations::{bindings, github::api as github},
    },
    errors::AppError,
};

#[derive(Debug, Deserialize)]
pub struct PutCodeProfileRequest {
    pub installation_id: String,
    pub repository: String,
    pub branch: String,
    #[serde(default)]
    pub bot_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PutCodeStatusRequest {
    pub state: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

pub async fn get_profile(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Option<channel_profiles::ChannelProfile>>, AppError> {
    let visible: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM channel_memberships WHERE channel_id = $1 AND member_id = $2)",
    )
    .bind(&channel_id)
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?;
    if !visible && !matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Err(AppError::Forbidden("channel membership required".into()));
    }
    Ok(Json(channel_profiles::get(&state.db, &channel_id).await?))
}

pub async fn put_code_profile(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<PutCodeProfileRequest>,
) -> Result<Json<channel_profiles::ChannelProfile>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    if body.branch.trim().is_empty() || body.branch.len() > 255 {
        return Err(AppError::BadRequest(
            "branch is required and must be at most 255 characters".into(),
        ));
    }
    if !github::valid_full_name(&body.repository) {
        return Err(AppError::BadRequest("repository must be owner/repo".into()));
    }
    let binding = bindings::for_channel(&state.db, &channel_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
        .ok_or_else(|| {
            AppError::BadRequest("bind a GitHub repository before creating a Code profile".into())
        })?;
    if binding.integration_id != "github"
        || binding.installation_id != body.installation_id
        || binding.external_id != body.repository
    {
        return Err(AppError::BadRequest(
            "Code profile must match this channel's GitHub binding".into(),
        ));
    }
    if let Some(bot_id) = &body.bot_id {
        let is_bot: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM channel_memberships WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot')",
        )
        .bind(&channel_id)
        .bind(bot_id)
        .fetch_one(&state.db)
        .await?;
        if !is_bot {
            return Err(AppError::BadRequest(
                "bot_id must be a member of this channel".into(),
            ));
        }
    }
    let profile = channel_profiles::put_code(
        &state.db,
        &channel_id,
        &CodeProfileConfig {
            integration_id: "github".into(),
            installation_id: body.installation_id,
            repository: body.repository,
            branch: body.branch.trim().to_owned(),
            bot_id: body.bot_id,
        },
        &claims.sub,
    )
    .await?;
    Ok(Json(profile))
}

pub async fn put_code_status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<PutCodeStatusRequest>,
) -> Result<Json<channel_profiles::ChannelProfile>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    if !matches!(
        body.state.as_str(),
        "pending" | "importing" | "ready" | "syncing" | "error"
    ) {
        return Err(AppError::BadRequest(
            "unsupported Code profile state".into(),
        ));
    }
    if body
        .workspace_path
        .as_ref()
        .is_some_and(|path| path.len() > 4096)
        || body
            .head_commit
            .as_ref()
            .is_some_and(|commit| commit.len() > 128)
        || body
            .last_error
            .as_ref()
            .is_some_and(|error| error.len() > 2000)
    {
        return Err(AppError::BadRequest(
            "Code profile status field is too long".into(),
        ));
    }
    let profile = channel_profiles::update_code_status(
        &state.db,
        &channel_id,
        &CodeProfileStatus {
            state: body.state,
            workspace_path: body.workspace_path,
            head_commit: body.head_commit,
            last_error: body.last_error,
        },
    )
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(profile))
}
