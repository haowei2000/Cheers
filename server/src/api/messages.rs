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
    domain::messages::{self, CreateMessageParams},
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
    #[serde(default)]
    pub mention_ids: Vec<Uuid>,
    /// @mentions by name or group token (`@all`/`@bots`/`@humans`/`@here`),
    /// resolved server-side. Lets a human group-mention the room, mirroring the
    /// bot `post_message` path.
    #[serde(default)]
    pub mention_names: Vec<String>,
    /// Optional: route the prompt to a specific "other" session in this channel
    /// (else the channel's primary session).
    #[serde(default)]
    pub session_id: Option<Uuid>,
    /// Optional resource-context bundle (docs/design/RESOURCE_CONTEXT.md): refs to
    /// Cheers resources (plan / file / message / activity) the sender attached to
    /// this message. Persisted and threaded into any triggered bot's task frame.
    #[serde(default)]
    pub context_bundle: Option<serde_json::Value>,
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

    // Block enforcement on an *existing* DM: create_dm gates opening a DM, but a
    // block placed afterwards must also stop further sends. If this is a 1:1 DM
    // and either side has blocked the other, refuse before persisting.
    if let Some(peer_id) = dm_peer(&state, channel_id, user_id).await? {
        if crate::api::friends::is_blocked(&state.db, &user_id.to_string(), &peer_id).await? {
            return Err(AppError::Forbidden(
                "you can't message a user you've blocked or who has blocked you".into(),
            ));
        }
    }

    // Harden the human-attached context bundle before it is persisted / delivered
    // (docs/design/RESOURCE_CONTEXT.md, no-permission-bypass): read verbs only,
    // origin stamped server-side, caps — then re-verify `workspace/read` on every
    // `workspace.file` snapshot so a pick can't reference (or fabricate) a bot
    // workspace the caller isn't granted. See sanitize_human_bundle.
    let context_bundle = match body.context_bundle {
        Some(raw) => {
            let sanitized = crate::domain::context_bundle::sanitize_human_bundle(&raw);
            authorize_workspace_items(&state, &claims, channel_id, sanitized).await
        }
        None => None,
    };

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
            mention_ids: body.mention_ids,
            mention_names: body.mention_names,
            session_id: body.session_id,
            context_bundle,
        },
    )
    .await?;

    info!(
        message_id = %dto.msg_id,
        channel_id = %channel_id,
        "send_message persisted and broadcasted"
    );

    // Out-of-app nudge to the @mentioned humans (kind=mention): Web Push for
    // browsers/PWA plus a user-scoped WS frame for the desktop shell. The
    // message is already durable + broadcast — both are fire-and-forget.
    let mention_targets: Vec<String> = dto
        .mentions
        .iter()
        .filter(|m| m.member_type == "user" && m.member_id != user_id.to_string())
        .map(|m| m.member_id.clone())
        .collect();
    let nudge = serde_json::json!({
        "kind": "mention",
        "channel_id": channel_id,
        "msg_id": dto.msg_id,
        "sender_name": dto.sender_name,
        "body": dto.content.chars().take(200).collect::<String>(),
    });
    crate::api::notifications::spawn_notify_users_ws(
        &state,
        mention_targets.clone(),
        nudge.clone(),
    );
    crate::infra::web_push::spawn_push_to_users(&state, mention_targets, nudge);

    Ok((StatusCode::CREATED, Json(dto)))
}

/// Drop every `workspace.file` item whose owning bot the caller isn't granted
/// `workspace/read` on — the same gate that guarded browsing it. A snapshot the
/// caller couldn't read (or fabricated) never rides along. Non-workspace items
/// pass through untouched. Returns `None` when nothing survives.
async fn authorize_workspace_items(
    state: &AppState,
    claims: &Claims,
    channel_id: Uuid,
    bundle: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    let mut bundle = bundle?;
    let items = bundle.get("items").and_then(|v| v.as_array())?.clone();
    let mut kept: Vec<serde_json::Value> = Vec::with_capacity(items.len());
    for item in items {
        let is_ws = item.get("verb").and_then(|v| v.as_str()) == Some("workspace.file");
        if is_ws {
            let owner = item
                .get("params")
                .and_then(|p| p.get("bot_id"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<Uuid>().ok());
            match owner {
                Some(bot_id)
                    if crate::api::workspace::resolve_can_read(
                        state, claims, channel_id, bot_id,
                    )
                    .await => {}
                _ => continue, // no grant (or unparseable owner) → drop the snapshot
            }
        }
        kept.push(item);
    }
    if kept.is_empty() {
        return None;
    }
    bundle
        .as_object_mut()
        .map(|o| o.insert("items".into(), serde_json::Value::Array(kept)));
    Some(bundle)
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
    /// `channel_seq`-based catch-up cursor: return terminal messages with
    /// `channel_seq > since_seq` ascending (reconnect/refresh path).
    pub since_seq: Option<i64>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

#[derive(Serialize)]
pub struct CancelMessageResponse {
    pub msg_id: String,
    pub delivered: bool,
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
    let page = if let Some(since_seq) = q.since_seq {
        messages::list_messages_since_seq(&state.db, user_id, channel_id, since_seq, limit).await?
    } else {
        let before = q.before.or(q.before_id).or(q.around_id);
        let after = q.after.or(q.after_id);
        messages::list_messages(&state.db, user_id, channel_id, before, after, limit).await?
    };
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

// ── POST /api/v1/channels/{channel_id}/messages/{msg_id}/cancel ─────────────

pub async fn cancel_message(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, msg_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<CancelMessageResponse>, AppError> {
    info!(
        path = "POST /api/v1/channels/:channel_id/messages/:msg_id/cancel",
        channel_id = %channel_id,
        msg_id = %msg_id,
        "handling cancel_message"
    );

    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;
    ensure_channel_member(&state, channel_id, user_id, &claims.role).await?;

    // 找到还在运行的占位消息，取出 bot_id + chain_id（后者用于整链取消）。
    let clicked = sqlx::query(
        "SELECT sender_id, chain_id FROM messages
         WHERE msg_id = $1 AND channel_id = $2
           AND is_partial = TRUE AND sender_type = 'bot'",
    )
    .bind(msg_id.to_string())
    .bind(channel_id.to_string())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let bot_id = clicked
        .try_get::<String, _>("sender_id")
        .ok()
        .and_then(|raw| raw.parse::<Uuid>().ok())
        .ok_or(AppError::NotFound)?;
    let chain_id = clicked
        .try_get::<Option<String>, _>("chain_id")
        .ok()
        .flatten();

    // INITIATE(cancel) gate (docs/arch/ACP_EVENT_TAXONOMY.md): may this user cancel
    // the bot's running turn here? Default-allow for members; an owner can deny it
    // per role/user via the event matrix. Fail-open on a rules error.
    let role: String = sqlx::query(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get::<Option<String>, _>("role").ok().flatten())
    .unwrap_or_else(|| "member".to_string());
    let may_cancel = crate::domain::acp_policy::allows(
        &state.db,
        &bot_id.to_string(),
        &channel_id.to_string(),
        &user_id.to_string(),
        &role,
        "session/cancel",
        crate::domain::bot_event_policy::Capability::Initiate,
    )
    .await
    .unwrap_or(true);
    if !may_cancel {
        return Err(AppError::Forbidden(
            "not authorized to cancel this bot here".into(),
        ));
    }

    // Chain-aware ⏹ (DECENTRALIZED_MESH §8): if this bot turn is part of a
    // bot@bot cascade, stop the WHOLE chain — flip the chain to `cancelled` (the
    // authoritative dispatch gate then blocks every un-launched hop) and fan the
    // existing per-msg cancel frame out to every still-in-flight bot in it.
    // Otherwise cancel just this one bot's turn (unchanged behavior).
    let (targets, reason): (Vec<(Uuid, Uuid)>, &str) = match &chain_id {
        Some(cid) => {
            let mut inflight = crate::domain::task_chains::cancel_chain(&state.db, cid, user_id)
                .await
                .unwrap_or_default();
            // A just-cancelled active chain always includes the clicked placeholder;
            // if the chain was already terminal (idempotent → empty), still cancel
            // the clicked bot so a double-click isn't a no-op.
            if inflight.is_empty() {
                inflight.push((msg_id, bot_id));
            }
            (inflight, "chain_cancelled")
        }
        None => (vec![(msg_id, bot_id)], "user_cancelled"),
    };

    let mut delivered = false;
    for (placeholder, target_bot) in &targets {
        let frame = crate::gateway::bridge_frames::cancel_frame(*placeholder, reason);
        if state.bot_locator.dispatch_task(*target_bot, frame).await {
            delivered = true;
        }
    }

    Ok(Json(CancelMessageResponse {
        msg_id: msg_id.to_string(),
        delivered,
    }))
}

/// For a 1:1 DM channel, the *other* user member's id (None for non-DM channels
/// or self-DMs/bot-DMs). Used to enforce blocking on ongoing DM sends.
async fn dm_peer(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>, AppError> {
    let peer = sqlx::query(
        "SELECT cm.member_id
         FROM channels c
         JOIN channel_memberships cm ON cm.channel_id = c.channel_id
        WHERE c.channel_id = $1 AND c.type = 'dm'
          AND cm.member_type = 'user' AND cm.member_id <> $2
        LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&state.db)
    .await?
    .and_then(|row| row.try_get::<String, _>("member_id").ok());
    Ok(peer)
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
