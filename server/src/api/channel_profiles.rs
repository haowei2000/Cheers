//! HTTP surface for generic channel workflow profiles.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::{channels::ensure_channel_admin, middleware::Claims},
    app_state::AppState,
    domain::{
        channel_profiles::{
            self, CodeExecutionTarget, CodeProfileConfig, CodeProfileStatus, CodeRemoteSource,
        },
        integrations::{bindings, github::api as github},
    },
    errors::AppError,
};

#[derive(Debug, Deserialize)]
pub struct PutCodeProfileRequest {
    #[serde(default)]
    pub remote_source: Option<PutCodeRemoteSource>,
    #[serde(default)]
    pub execution_target: Option<PutCodeExecutionTarget>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PutCodeRemoteSource {
    Github {
        installation_id: String,
        repository: String,
        branch: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct PutCodeExecutionTarget {
    pub bot_id: String,
    pub host_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PutCodeStatusRequest {
    pub state: String,
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
    let mut profile = channel_profiles::get(&state.db, &channel_id).await?;
    if let Some(profile) = profile.as_mut() {
        enrich_execution_target_state(&state, profile).await?;
    }
    Ok(Json(profile))
}

async fn enrich_execution_target_state(
    state: &AppState,
    profile: &mut channel_profiles::ChannelProfile,
) -> Result<(), AppError> {
    let Some(target) = profile.config.get("execution_target") else {
        return Ok(());
    };
    let Some(bot_id) = target.get("bot_id").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(host_id) = target.get("host_id").and_then(Value::as_str) else {
        return Ok(());
    };
    let row = sqlx::query(
        "SELECT h.device_name, h.status, h.revoked_at,
                COALESCE(b.display_name, b.username) AS bot_name
           FROM connector_hosts h
           JOIN bot_accounts b ON b.bot_id = h.bot_id
          WHERE h.host_id = $1 AND h.bot_id = $2",
    )
    .bind(host_id)
    .bind(bot_id)
    .fetch_optional(&state.db)
    .await?;
    let parsed_bot = Uuid::parse_str(bot_id).ok();
    let online = match (&row, parsed_bot) {
        (Some(row), Some(bot_id)) => {
            row.try_get::<String, _>("status").ok().as_deref() == Some("active")
                && row
                    .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("revoked_at")
                    .ok()
                    .flatten()
                    .is_none()
                && state.bot_locator.is_online(bot_id).await
        }
        _ => false,
    };
    let status = profile
        .status
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("Code profile status must be a JSON object".into()))?;
    status.insert("target_online".into(), Value::Bool(online));
    if let Some(row) = row {
        status.insert(
            "target_device".into(),
            json!(row.try_get::<String, _>("device_name").unwrap_or_default()),
        );
        status.insert(
            "target_bot_name".into(),
            json!(row.try_get::<String, _>("bot_name").unwrap_or_default()),
        );
    }
    Ok(())
}

pub async fn put_code_profile(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<PutCodeProfileRequest>,
) -> Result<Json<channel_profiles::ChannelProfile>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let remote_source = match body.remote_source {
        Some(PutCodeRemoteSource::Github {
            installation_id,
            repository,
            branch,
        }) => {
            if branch.trim().is_empty() || branch.len() > 255 {
                return Err(AppError::BadRequest(
                    "branch is required and must be at most 255 characters".into(),
                ));
            }
            if !github::valid_full_name(&repository) {
                return Err(AppError::BadRequest("repository must be owner/repo".into()));
            }
            let binding = bindings::for_channel(&state.db, &channel_id)
                .await
                .map_err(|error| AppError::Internal(error.to_string()))?
                .ok_or_else(|| {
                    AppError::BadRequest(
                        "bind the GitHub repository before setting the remote source".into(),
                    )
                })?;
            if binding.integration_id != "github"
                || binding.installation_id != installation_id
                || binding.external_id != repository
            {
                return Err(AppError::BadRequest(
                    "remote source must match this channel's GitHub binding".into(),
                ));
            }
            Some(CodeRemoteSource::Github {
                installation_id,
                repository,
                branch: branch.trim().to_owned(),
            })
        }
        None => None,
    };

    let execution_target = if let Some(target) = body.execution_target {
        let is_bot: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM channel_memberships WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot')",
        )
        .bind(&channel_id)
        .bind(&target.bot_id)
        .fetch_one(&state.db)
        .await?;
        if !is_bot {
            return Err(AppError::BadRequest(
                "execution target Bot must be a member of this channel".into(),
            ));
        }
        let host_is_active: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM connector_hosts
              WHERE host_id = $1 AND bot_id = $2 AND status = 'active' AND revoked_at IS NULL)",
        )
        .bind(&target.host_id)
        .bind(&target.bot_id)
        .fetch_one(&state.db)
        .await?;
        if !host_is_active {
            return Err(AppError::BadRequest(
                "execution target must be the Bot's active Host".into(),
            ));
        }
        let checkout_id: Option<String> = sqlx::query_scalar(
            "SELECT b.session_id
               FROM cheers_session_bindings b
              WHERE b.bot_id = $1 AND b.scope_type = 'channel' AND b.scope_id = $2
                AND b.role = 'primary' AND b.detached_at IS NULL",
        )
        .bind(&target.bot_id)
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await?;
        Some(CodeExecutionTarget {
            bot_id: target.bot_id,
            host_id: target.host_id,
            checkout_id: checkout_id.ok_or_else(|| {
                AppError::BadRequest("execution target has no primary checkout session".into())
            })?,
        })
    } else {
        None
    };
    let profile = channel_profiles::put_code(
        &state.db,
        &channel_id,
        &CodeProfileConfig {
            remote_source,
            execution_target,
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
        "unconfigured" | "pending" | "importing" | "ready" | "syncing" | "error"
    ) {
        return Err(AppError::BadRequest(
            "unsupported Code profile state".into(),
        ));
    }
    if body
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
            head_commit: body.head_commit,
            last_error: body.last_error,
        },
    )
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(profile))
}
