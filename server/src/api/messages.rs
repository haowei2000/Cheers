use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tracing::info;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::{
        chains,
        messages::{self, CreateMessageParams},
    },
    errors::AppError,
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
    #[serde(rename = "before_id")]
    pub before_id: Option<String>,
    #[serde(rename = "around_id")]
    pub around_id: Option<String>,
    pub after: Option<String>,
    #[serde(rename = "after_id")]
    pub after_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

#[derive(Serialize)]
pub struct CancelChainResponse {
    pub chain_id: String,
    pub status_changed: bool,
    pub cancel_targets: usize,
    pub delivered: usize,
}

fn default_limit() -> i64 {
    50
}

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
    let before = q.before.or(q.before_id).or(q.around_id);
    let after = q.after.or(q.after_id);
    let page =
        messages::list_messages(&state.db, user_id, channel_id, before, after, limit).await?;
    let messages = page.messages;
    let has_more = page.has_more;
    info!(
        user_id = %user_id,
        channel_id = %channel_id,
        return_count = messages.len(),
        "list_messages returned"
    );

    Ok(Json(serde_json::json!({
        "messages": &messages,
        "data": &messages,
        "count": messages.len(),
        "meta": {
            "has_more_before": page.has_more_before,
            "has_more_after": page.has_more_after,
            "has_more": has_more,
            "anchor_found": page.anchor_found,
            "limit": limit,
        },
    })))
}

// ── POST /api/v1/channels/{channel_id}/messages/{msg_id}/cancel-chain ───────

pub async fn cancel_message_chain(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, msg_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<CancelChainResponse>, AppError> {
    info!(
        path = "POST /api/v1/channels/:channel_id/messages/:msg_id/cancel-chain",
        channel_id = %channel_id,
        msg_id = %msg_id,
        "handling cancel_message_chain"
    );

    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;
    ensure_channel_member(&state, channel_id, user_id, &claims.role).await?;

    let chain_id = chains::resolve_chain_id_for_message(&state.db, channel_id, msg_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let cancel_result = chains::cancel(&state.db, chain_id, user_id).await?;

    let mut delivered = 0usize;
    for (placeholder_msg_id, bot_id) in &cancel_result.targets {
        let frame = serde_json::json!({
            "type": "cancel",
            "msg_id": placeholder_msg_id,
            "reason": "chain_cancelled",
            "chain_id": chain_id,
        });
        if state.bot_locator.dispatch_task(*bot_id, frame).await {
            delivered += 1;
        }
    }

    Ok(Json(CancelChainResponse {
        chain_id: chain_id.to_string(),
        status_changed: cancel_result.status_changed,
        cancel_targets: cancel_result.targets.len(),
        delivered,
    }))
}

async fn ensure_channel_member(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> Result<(), AppError> {
    if matches!(role, "system_admin" | "admin") {
        return Ok(());
    }

    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if ok {
        Ok(())
    } else {
        Err(AppError::Forbidden("not a channel member".into()))
    }
}
