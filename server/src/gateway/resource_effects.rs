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
//! Not covered: `workspace.read`, which is an alternate *dispatch* (brokering a read of
//! another bot's machine) rather than a post-dispatch effect, and stays at the bot-bridge
//! boundary. It fails loudly (`UNKNOWN_RESOURCE`) elsewhere rather than silently.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    app_state::AppState,
    gateway::{realtime::frame::WireFrame, stream::broadcast_and_trigger_created_message},
    resource::{self, Principal},
};

/// Dispatch a `resource_req` frame and apply the post-write effects the db-only
/// resource layer can't. Returns the `resource_res` frame verbatim from
/// [`resource::dispatch`] — effects never change the reply, and never fail it.
pub async fn dispatch_with_effects(state: &AppState, principal: Principal, frame: &Value) -> Value {
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
        Some("fs.write" | "fs.edit" | "fs.append" | "fs.rm" | "fs.mv") => {
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
        _ => {}
    }
    resp
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
        // plus Web Push when configured. Already off the critical path here.
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
            for user_id in human_mentions {
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
                }
                if let Some(sender) = web_push.as_ref() {
                    crate::infra::web_push::push_to_user(&db, sender, &user_id, payload.clone())
                        .await;
                }
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
