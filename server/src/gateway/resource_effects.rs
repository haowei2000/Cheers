//! Transport-neutral resource dispatch and postcommit publication.
//!
//! Message creation commits its dispatch intents with the message and receipt.
//! [`resource::dispatch`] receives the live locator for readiness admission; it
//! cannot lose downstream work if publication is interrupted. This layer shares
//! browser fan-out, notification and immediate delivery effects across transports.
//! Receipt replay does not repeat those effects, and the durable worker can
//! deliver committed intents independently of this publication path.
//!
//! `workspace.read` is an alternate dispatch rather than a post-dispatch effect.
//! Bot MCP workspace reads are brokered here through the owner's live Connector,
//! with the requesting bot's resource authorization.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    gateway::{realtime::frame::WireFrame, stream::broadcast_created_message},
    resource::{self, Principal},
};

fn direct_message_notification_payload(channel_id: Uuid, sender_name: &str) -> Value {
    json!({
        "kind": "dm",
        "channel_id": channel_id,
        "sender_name": sender_name,
        "title": sender_name,
        "body": "New direct message",
    })
}

/// Dispatch a `resource_req` frame and apply post-write publication. Returns the
/// `resource_res` frame verbatim from
/// [`resource::dispatch`] — effects never change the reply, and never fail it.
pub async fn dispatch_with_effects(state: &AppState, principal: Principal, frame: &Value) -> Value {
    if frame.get("resource").and_then(Value::as_str) == Some("workspace.read") {
        return broker_workspace_read(state, principal, frame).await;
    }
    let resp = match principal.principal_type {
        resource::PrincipalType::User => {
            resource::dispatch_user(&state.db, principal.principal_id, frame, &state.bot_locator)
                .await
        }
        resource::PrincipalType::Bot => {
            resource::dispatch(&state.db, principal, frame, &state.bot_locator).await
        }
    };

    // Effects run only for a write that actually landed.
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        return resp;
    }
    // A write replayed for a reused idempotency key ran its effects the first time.
    if resp
        .get("data")
        .and_then(|data| data.get(resource::idempotency::REPLAY_FLAG))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return resp;
    }
    match frame.get("resource").and_then(Value::as_str) {
        Some("channel.messages.create") => {
            if let Some(created) = resp.get("data") {
                spawn_created_message_effects(state, principal.principal_id, created.clone());
            }
        }
        Some("channel.messages.suggestions.write") => {
            if let Some(data) = resp.get("data") {
                if let Some(channel_id) = data
                    .get("channel_id")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<Uuid>().ok())
                {
                    state
                        .fanout
                        .broadcast_channel(
                            channel_id,
                            WireFrame::channel(channel_id, "suggestions_updated", data.clone()),
                        )
                        .await;
                }
            }
        }
        Some("channel.messages.cards.write") => {
            if let Some(data) = resp.get("data") {
                if data.get("staged").and_then(Value::as_bool) == Some(true) {
                    return resp;
                }
                if let Some(channel_id) = data
                    .get("channel_id")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<Uuid>().ok())
                {
                    state
                        .fanout
                        .broadcast_channel(
                            channel_id,
                            WireFrame::channel(channel_id, "cards_updated", data.clone()),
                        )
                        .await;
                }
            }
        }
        Some("channel.task_claims.evaluate") => {
            if let Some(data) = resp.get("data") {
                if let Some(message) = data.get("confirmation_message") {
                    if let Some(channel_id) = message
                        .get("channel_id")
                        .and_then(Value::as_str)
                        .and_then(|v| v.parse::<Uuid>().ok())
                    {
                        state
                            .fanout
                            .broadcast_channel(
                                channel_id,
                                WireFrame::channel(channel_id, "message", message.clone()),
                            )
                            .await;
                    }
                }
                if data.get("status").and_then(Value::as_str) == Some("pending") {
                    if let Some(channel_id) = data
                        .get("channel_id")
                        .and_then(Value::as_str)
                        .and_then(|v| v.parse::<Uuid>().ok())
                    {
                        state
                            .fanout
                            .broadcast_channel(
                                channel_id,
                                WireFrame::channel(channel_id, "task_claim_created", data.clone()),
                            )
                            .await;
                    }
                }
            }
            // An ignored or failed decision does not create a chat message, so
            // explicitly refresh the Activity ViewBoard for every MCP decision.
            if let Some(channel_id) = frame
                .get("params")
                .and_then(|params| params.get("channel_id"))
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<Uuid>().ok())
            {
                state
                    .fanout
                    .broadcast_channel(
                        channel_id,
                        WireFrame::channel(
                            channel_id,
                            "board_signal",
                            json!({ "channel_id": channel_id, "board": "activity" }),
                        ),
                    )
                    .await;
            }
        }
        // A bot left → the member set changed, so re-broadcast the full presence.
        Some("channel.leave") => {
            if let Some(cid) = frame
                .get("params")
                .and_then(|p| p.get("channel_id"))
                .and_then(Value::as_str)
                .and_then(|s| Uuid::parse_str(s).ok())
            {
                crate::gateway::presence::broadcast_presence(state, cid).await;
            }
        }
        // Live Desk: a mutating `fs.*` verb changed the channel's workspace files —
        // nudge any open Desk view to re-pull. Data-free: clients re-fetch through
        // their own authz'd fs.ls/fs.read. Board name "files" is a cross-slice contract.
        Some("fs.write" | "fs.patch" | "fs.edit" | "fs.append" | "fs.rm" | "fs.mv") => {
            if let Some(cid) = resp
                .get("data")
                .and_then(|d| d.get("channel_id"))
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<Uuid>().ok())
            {
                let wire = WireFrame::channel(
                    cid,
                    "board_signal",
                    json!({ "channel_id": cid, "board": "files" }),
                );
                state.fanout.broadcast_channel(cid, wire).await;
            }
        }
        // The agent wrote its own status card (the set_status tool). Persisted by
        // dispatch; the live member_updated push to every channel it's in needs fanout.
        Some("bot.status.write") => {
            let bot_id = principal.principal_id.to_string();
            crate::api::bots::broadcast_bot_member_update(state, &bot_id).await;
            audit_status_write(state, &bot_id, frame).await;
        }
        Some("channel.code.status.write") => {
            if let Some(cid) = resp
                .get("data")
                .and_then(|data| data.get("channel_id"))
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value).ok())
            {
                state
                    .fanout
                    .broadcast_channel(
                        cid,
                        WireFrame::channel(
                            cid,
                            "board_signal",
                            json!({ "channel_id": cid, "board": "github-code" }),
                        ),
                    )
                    .await;
            }
        }
        Some("dm.open") => {
            if let Some(data) = resp.get("data") {
                if data.get("created").and_then(Value::as_bool) == Some(true) {
                    if let Some(user_id) = data
                        .get("target_user_id")
                        .and_then(Value::as_str)
                        .and_then(|value| value.parse::<Uuid>().ok())
                    {
                        state
                            .fanout
                            .broadcast_user(user_id, WireFrame::user("dm_created", data.clone()))
                            .await;
                    }
                }
            }
        }
        _ => {}
    }
    resp
}

/// Resolve another Bot's live workspace reference under the requesting Bot's
/// own membership and workspace-read grant. The owner Connector remains the
/// filesystem authority; no Gateway-local path fallback exists.
async fn broker_workspace_read(state: &AppState, principal: Principal, frame: &Value) -> Value {
    let req_id = frame.get("req_id").and_then(Value::as_str).unwrap_or("");
    if principal.principal_type != crate::resource::PrincipalType::Bot {
        return resource::err_res(
            req_id,
            "PERMISSION_DENIED",
            "workspace.read requires a Bot principal",
        );
    }
    let params = frame.get("params").cloned().unwrap_or(Value::Null);
    let str_param = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_string);
    let uuid_param = |key: &str| str_param(key).and_then(|value| Uuid::parse_str(&value).ok());
    let Some(owner_bot_id) = uuid_param("bot_id") else {
        return resource::err_res(req_id, "INVALID_PARAMS", "bot_id required");
    };
    let Some(channel_id) = uuid_param("channel_id") else {
        return resource::err_res(req_id, "INVALID_PARAMS", "channel_id required");
    };
    let Some(path) = str_param("path") else {
        return resource::err_res(req_id, "INVALID_PARAMS", "path required");
    };
    let session_id = uuid_param("session_id");
    let root = str_param("root");
    match crate::api::workspace::read_workspace_file_as_bot(
        state,
        owner_bot_id,
        principal.principal_id,
        channel_id,
        &path,
        root.as_deref(),
        session_id,
    )
    .await
    {
        Ok(data) => resource::ok_res(req_id, data),
        Err(error) => {
            let (code, message) = workspace_error(&error);
            resource::err_res(req_id, code, &message)
        }
    }
}

/// Preserve the established resource error vocabulary while hiding internals.
fn workspace_error(error: &crate::errors::AppError) -> (&'static str, String) {
    use crate::errors::AppError;
    match error {
        AppError::Forbidden(message) => ("PERMISSION_DENIED", message.clone()),
        AppError::NotFound => ("NOT_FOUND", "not found".to_string()),
        AppError::BadRequest(message) => ("INVALID_PARAMS", message.clone()),
        AppError::Conflict(message) => ("E_CONFLICT", message.clone()),
        AppError::PayloadTooLarge(message) => ("E_TOO_LARGE", message.clone()),
        _ => ("INTERNAL_ERROR", "internal error".to_string()),
    }
}

/// Publish a committed message and accelerate its already-admitted intents off
/// the caller's critical path. The `resource_res` returns without waiting on
/// browser fan-out or the next bot@bot hop. Ordering is safe: the frontend
/// re-sorts incoming `message` frames by `channel_seq` (`ChannelView.upsertMessage`), so
/// a broadcast that lands after the reply cannot misorder the channel.
fn spawn_created_message_effects(state: &AppState, author_bot_id: Uuid, created: Value) {
    let registry = state.stream_registry.clone();
    let fanout = state.fanout.clone();
    let db = state.db.clone();
    let bot_locator = state.bot_locator.clone();
    let web_push = state.web_push.clone();
    let state_for_apns = state.clone();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let _ = broadcast_created_message(&registry, &fanout, &db, &bot_locator, &created).await;
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "post_message publication complete (off critical path)"
        );

        // Out-of-app nudge to the @mentioned humans (kind=mention) — bots
        // mention people via post_message, and those people may be away from
        // the tab: user-scoped WS frame (desktop shell; works without VAPID)
        // plus Web Push when configured, plus APNs for native clients.
        let human_mentions: Vec<String> = created
            .get("mentions")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|m| m.get("member_type").and_then(Value::as_str) == Some("user"))
                    .filter_map(|m| m.get("member_id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let channel_id = created
            .get("channel_id")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<Uuid>().ok());
        let is_dm = if let Some(channel_id) = channel_id {
            sqlx::query_scalar!(
                r#"SELECT EXISTS(SELECT 1 AS present FROM channels WHERE channel_id = $1 AND type = 'dm') AS "value!" "#,
                channel_id.to_string(),
            )
            .fetch_one(&db)
            .await
            .unwrap_or(false)
        } else {
            false
        };
        if is_dm {
            let sender_name: String = sqlx::query_scalar!(
                r#"SELECT COALESCE(display_name, username) AS "value!" FROM bot_accounts WHERE bot_id = $1"#,
                author_bot_id.to_string(),
            )
            .fetch_optional(&db)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "Bot".into());
            if let Some(channel_id) = channel_id {
                let users: Vec<String> = sqlx::query_scalar!(
                    "SELECT member_id FROM channel_memberships
                     WHERE channel_id = $1 AND member_type = 'user'",
                    channel_id.to_string(),
                )
                .fetch_all(&db)
                .await
                .unwrap_or_default();
                let payload = direct_message_notification_payload(channel_id, &sender_name);
                for user_id in &users {
                    if let Ok(uid) = user_id.parse::<Uuid>() {
                        fanout
                            .broadcast_user(uid, WireFrame::user("notification", payload.clone()))
                            .await;
                        crate::notify::push_to_user(
                            &state_for_apns,
                            uid,
                            crate::notify::PushKind::DirectMessage {
                                channel_id,
                                sender_name: sender_name.clone(),
                            },
                        );
                    }
                    if let Some(sender) = web_push.as_ref() {
                        crate::infra::web_push::push_to_user(&db, sender, user_id, payload.clone())
                            .await;
                    }
                }
            }
        }
        if !human_mentions.is_empty() {
            let sender_name: Option<String> = sqlx::query_scalar!(
                r#"SELECT COALESCE(display_name, username) AS "value!" FROM bot_accounts WHERE bot_id = $1"#,
                author_bot_id.to_string(),
            )
            .fetch_optional(&db)
            .await
            .ok()
            .flatten();
            let body: String = created
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect();
            let payload = json!({
                "kind": "mention",
                "channel_id": created.get("channel_id").cloned().unwrap_or(Value::Null),
                "msg_id": created.get("msg_id").cloned().unwrap_or(Value::Null),
                "sender_name": sender_name,
                "body": body,
            });
            let mut mentioned_users = Vec::new();
            for user_id in &human_mentions {
                if let Ok(uid) = user_id.parse::<uuid::Uuid>() {
                    fanout
                        .broadcast_user(
                            uid,
                            crate::gateway::realtime::frame::WireFrame::user(
                                "notification",
                                payload.clone(),
                            ),
                        )
                        .await;
                    mentioned_users.push(uid);
                }
                if let Some(sender) = web_push.as_ref() {
                    crate::infra::web_push::push_to_user(&db, sender, user_id, payload.clone())
                        .await;
                }
            }
            if let Some(cid) = created
                .get("channel_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<uuid::Uuid>().ok())
            {
                crate::notify::push_bot_mentions_apns(
                    &state_for_apns,
                    cid,
                    author_bot_id,
                    mentioned_users,
                );
            }
        }
    });
}

/// Record a self-status write to `acp_event_log` so status changes are auditable
/// alongside every other ACP event. Summary ONLY — which fields were set and their char
/// lengths, NEVER the text itself. `channel_id` is NULL (a self-card write isn't
/// channel-scoped); `session_id` rides the frame if present. Best-effort: a log-write
/// failure must never disrupt the live agent.
async fn audit_status_write(state: &AppState, bot_id: &str, frame: &Value) {
    let params = frame.get("params");
    let field_len = |key: &str| {
        params
            .and_then(|p| p.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().count())
    };
    let audit_payload = json!({
        "status_text_len": field_len("status_text"),
        "status_emoji_len": field_len("status_emoji"),
        "info_len": field_len("info"),
    });
    if let Err(err) = sqlx::query!(
        "INSERT INTO acp_event_log (id, bot_id, channel_id, session_id, name, home, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)",
        Uuid::new_v4().to_string(),
        bot_id,
        Option::<&str>::None,
        frame.get("session_id").and_then(Value::as_str),
        "bot.status.write",
        "cheers",
        audit_payload.to_string(),
    )
    .execute(&state.db)
    .await
    {
        tracing::warn!(bot_id = %bot_id, error = %err, "bot.status.write audit log write failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_dm_web_push_has_display_content() {
        let channel_id = Uuid::new_v4();
        let payload = direct_message_notification_payload(channel_id, "Planner");

        assert_eq!(payload["kind"], "dm");
        assert_eq!(payload["channel_id"], channel_id.to_string());
        assert_eq!(payload["title"], "Planner");
        assert_eq!(payload["body"], "New direct message");
    }
}
