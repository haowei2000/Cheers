//! `channel.sessions.read` — Sessions inspector ViewBoard read side. Lists every
//! live session bound to the channel, across all bots (primary + "other"), with
//! status + mode/config — the channel-wide view behind the composer's SessionSwitcher.
//!
//! This is a ViewBoard verb (read-only projection of Class-1 session state); writes
//! (create/close/set_mode) go through the session-control endpoints, not here.
//!
//! Params: `{ channel_id }`. Response:
//! ```json
//! { "channel_id": "...",
//!   "sessions": [ { "session_id", "bot_id", "bot_name", "role", "is_primary",
//!                   "status", "created_at", "last_used_at", "session_config" } ] }
//! ```
//! Ordered by bot, then primary-first, then most-recently-used.
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{authorize_channel_read, Principal, ResourceResult};

/// `resource_req { resource: "channel.sessions.read", params: { channel_id } }`
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;
    authorize_channel_read(db, principal, channel_id).await?;

    // All sessions bound to this channel (every bot). Same liveness rule as the
    // switcher (domain::sessions::list_channel_sessions): no detached_at filter —
    // an idle session stays addressable; exclude only truly-closed sessions.
    let rows = sqlx::query(
        "SELECT s.session_id, b.bot_id, b.role, s.status, s.last_used_at, s.created_at,
                s.metadata, COALESCE(ba.display_name, ba.username) AS bot_name
         FROM cheers_session_bindings b
         JOIN cheers_sessions s ON s.session_id = b.session_id
         LEFT JOIN bot_accounts ba ON ba.bot_id = b.bot_id
         WHERE b.scope_type = 'channel' AND b.scope_id = $1
           AND s.status NOT IN ('terminated', 'revoked', 'expired')
         ORDER BY b.bot_id, (b.role = 'primary') DESC, s.last_used_at DESC",
    )
    .bind(channel_id.to_string())
    .fetch_all(db)
    .await
    .map_err(super::db_err("sessions.read: select channel sessions"))?;

    let sessions: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let role: String = r.try_get("role").unwrap_or_default();
            let metadata = r.try_get::<Option<Value>, _>("metadata").ok().flatten();
            // Per-session mode/config override (set via set_mode / set_config_option).
            let session_config = metadata
                .as_ref()
                .and_then(|m| m.get("session_config").cloned())
                .unwrap_or_else(|| json!({}));
            // Per-session ACP root set (cwd + additional_dirs); absent → default cwd.
            let workspace = metadata
                .as_ref()
                .and_then(|m| m.get("workspace").cloned())
                .unwrap_or_else(|| json!({}));
            json!({
                "session_id": r.try_get::<String, _>("session_id").unwrap_or_default(),
                "bot_id": r.try_get::<String, _>("bot_id").unwrap_or_default(),
                "bot_name": r.try_get::<Option<String>, _>("bot_name").ok().flatten(),
                "role": role.clone(),
                "is_primary": role == "primary",
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
                "created_at": r
                    .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_default(),
                "last_used_at": r
                    .try_get::<chrono::DateTime<chrono::Utc>, _>("last_used_at")
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_default(),
                "session_config": session_config,
                "workspace": workspace,
            })
        })
        .collect();

    Ok(json!({ "channel_id": channel_id, "sessions": sessions }))
}
