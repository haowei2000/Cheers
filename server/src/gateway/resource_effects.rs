//! Transport-neutral resource dispatch — `resource::dispatch` **plus the side effects
//! it structurally cannot perform**.
//!
//! [`resource::dispatch`] is deliberately db-only: it takes a `PgPool` and nothing else.
//! That keeps the resource layer transport-agnostic and easy to test, but it also means
//! a successful write there is only *half* the operation. Creating a message must also
//! push the live `message` frame to the channel and trigger any @mentioned bots; leaving
//! a channel must re-broadcast presence; a workspace write must nudge open Desk views.
//! All of those need `AppState` (fanout / stream_registry / bot_locator), which
//! `dispatch` does not have.
//!
//! Historically each of those effects was patched in at the bot-bridge WS boundary, so
//! the rule "creating a message ⇒ broadcast + trigger" existed only at that one call
//! site. That is a trap for the next transport: a Streamable-HTTP MCP endpoint calling
//! `resource::dispatch` directly would persist the row, return 200, and **silently** skip
//! the broadcast and the bot trigger — no error, just a channel that never updates and an
//! @mentioned bot that never wakes. Bugs of omission don't announce themselves.
//!
//! [`dispatch_with_effects`] is the seam that closes it: **every** transport routes
//! resource frames through here and gets the complete semantics of each verb. Adding a
//! new effect means adding it once, here, rather than in every boundary.
//!
//! `workspace.read` is an alternate dispatch rather than a post-dispatch effect.
//! It is brokered here as well, so Agent Bridge and HTTP MCP share the same live
//! owner-Connector routing and authorization semantics.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    gateway::{realtime::frame::WireFrame, stream::broadcast_and_trigger_created_message},
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

/// Dispatch a `resource_req` frame and apply the post-write effects the db-only
/// resource layer can't. Returns the `resource_res` frame verbatim from
/// [`resource::dispatch`] — effects never change the reply, and never fail it.
pub async fn dispatch_with_effects(state: &AppState, principal: Principal, frame: &Value) -> Value {
    if frame.get("resource").and_then(Value::as_str) == Some("workspace.read") {
        return broker_workspace_read(state, principal, frame).await;
    }
    let resp = resource::dispatch(&state.db, principal, frame).await;

    // Effects run only for a write that actually landed.
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        return resp;
    }
    match frame.get("resource").and_then(Value::as_str) {
        Some("channel.messages.create") => {
            if let Some(created) = resp.get("data") {
                spawn_created_message_effects(state, principal.principal_id, created.clone());
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

/// Broadcast the new message and trigger any @mentioned bots — **off the caller's
/// critical path**. The row is already committed, so the `resource_res` returns without
/// waiting on a Redis PUBLISH or the next bot@bot hop. Ordering is safe: the frontend
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
        let _ = broadcast_and_trigger_created_message(
            &registry,
            &fanout,
            &db,
            &bot_locator,
            author_bot_id,
            &created,
        )
        .await;
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "post_message broadcast+trigger complete (off critical path)"
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
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM channels WHERE channel_id = $1 AND type = 'dm')",
            )
            .bind(channel_id.to_string())
            .fetch_one(&db)
            .await
            .unwrap_or(false)
        } else {
            false
        };
        if is_dm {
            let sender_name: String = sqlx::query_scalar(
                "SELECT COALESCE(display_name, username) FROM bot_accounts WHERE bot_id = $1",
            )
            .bind(author_bot_id.to_string())
            .fetch_optional(&db)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "Bot".into());
            if let Some(channel_id) = channel_id {
                let users: Vec<String> = sqlx::query_scalar(
                    "SELECT member_id FROM channel_memberships
                     WHERE channel_id = $1 AND member_type = 'user'",
                )
                .bind(channel_id.to_string())
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
            let sender_name: Option<String> = sqlx::query_scalar(
                "SELECT COALESCE(display_name, username) FROM bot_accounts WHERE bot_id = $1",
            )
            .bind(author_bot_id.to_string())
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
    if let Err(err) = sqlx::query(
        "INSERT INTO acp_event_log (id, bot_id, channel_id, session_id, name, home, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(bot_id)
    .bind(Option::<&str>::None)
    .bind(frame.get("session_id").and_then(Value::as_str))
    .bind("bot.status.write")
    .bind("cheers")
    .bind(audit_payload.to_string())
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
