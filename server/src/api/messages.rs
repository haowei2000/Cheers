use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use tracing::info;

use crate::{
    app_state::AppState,
    domain::messages::{self, CreateMessageParams},
    errors::AppError,
    api::middleware::Claims,
};

// ── POST /api/v1/channels/{channel_id}/messages ────────────────────────────

#[derive(Deserialize)]
pub struct SendMessageRequest {
    pub content: String,
    pub msg_type: Option<String>,
    pub reply_to_msg_id: Option<Uuid>,
    #[serde(default)]
    pub file_ids: Vec<String>,
}

pub async fn send_message(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Json(body): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, AppError> {
    info!(path = "POST /api/v1/channels/:channel_id/messages", channel_id = %channel_id, "handling send_message");

    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;

    info!(
        user_id = %user_id,
        msg_type = body.msg_type.as_deref().unwrap_or("text"),
        has_reply_to = body.reply_to_msg_id.is_some(),
        attachment_file_count = body.file_ids.len(),
        content_len = body.content.len(),
        "send_message request validated"
    );

    if body.content.trim().is_empty() {
        return Err(AppError::BadRequest("content cannot be empty".into()));
    }

    let dto = messages::create_message(
        &state.db,
        &state.fanout,
        &state.stream_registry,
        &state.bot_locator,
        CreateMessageParams {
            user_id,
            channel_id,
            content: body.content,
            msg_type: body.msg_type,
            reply_to_msg_id: body.reply_to_msg_id,
            file_ids: body.file_ids,
        },
    )
    .await?;

    info!(
        message_id = %dto.msg_id,
        channel_id = %channel_id,
        "send_message persisted and broadcasted"
    );

    Ok((StatusCode::CREATED, Json(dto)))
}

// ── GET /api/v1/channels/{channel_id}/messages ─────────────────────────────

#[derive(Deserialize)]
pub struct ListMessagesQuery {
    pub before: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 { 50 }

pub async fn list_messages(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<ListMessagesQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    info!(path = "GET /api/v1/channels/:channel_id/messages", channel_id = %channel_id, "handling list_messages");

    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;

    let limit = q.limit.clamp(1, 200);
    let msgs = messages::list_messages(&state.db, user_id, channel_id, q.before, limit).await?;
    info!(
        user_id = %user_id,
        channel_id = %channel_id,
        return_count = msgs.len(),
        "list_messages returned"
    );

    Ok(Json(serde_json::json!({ "messages": msgs, "count": msgs.len() })))
}
