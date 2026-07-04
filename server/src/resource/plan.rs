//! `channel.plan.read` — ① plan board read side. Returns each bot's latest plan
//! in the channel (from `bot_session_plans`).
//!
//! Params: `{ channel_id, session_id? }`. With `session_id` the result is scoped to
//! that session (the ViewBoard follows the channel's selected session); omit it for
//! all sessions.
//!
//! Response shape:
//! ```json
//! { "channel_id": "...",
//!   "plans": [ { "bot_id", "session_id",
//!                "entries": [ {content, priority?, status?} ],
//!                "total", "completed", "updated_at" } ] }
//! ```
//! Ordered by `updated_at DESC` (freshest plan first).
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{authorize_channel_read, Principal, ResourceResult};

/// `resource_req { resource: "channel.plan.read", params: { channel_id } }`
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;
    authorize_channel_read(db, principal, channel_id).await?;

    // Optional session scope: NULL → all sessions; else only that session.
    let session_id = params.get("session_id").and_then(|v| v.as_str());

    let rows = sqlx::query(
        "SELECT bot_id, session_id, entries, total, completed, updated_at
         FROM bot_session_plans
         WHERE channel_id = $1
           AND ($2::text IS NULL OR session_id = $2::text)
         ORDER BY updated_at DESC",
    )
    .bind(channel_id.to_string())
    .bind(session_id)
    .fetch_all(db)
    .await
    .map_err(super::db_err("plan.read: select bot_session_plans"))?;

    let plans: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            // entries is a jsonb array of {content, priority?, status?}; pass it
            // through verbatim (agent-authored text is inert on the client).
            let entries: Value = row
                .try_get::<Value, _>("entries")
                .unwrap_or_else(|_| json!([]));
            json!({
                "bot_id": row.try_get::<String, _>("bot_id").unwrap_or_default(),
                "session_id": row.try_get::<String, _>("session_id").unwrap_or_default(),
                "entries": entries,
                "total": row.try_get::<i32, _>("total").unwrap_or(0),
                "completed": row.try_get::<i32, _>("completed").unwrap_or(0),
                "updated_at": row
                    .try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
                    .ok(),
            })
        })
        .collect();

    Ok(json!({ "channel_id": channel_id, "plans": plans }))
}
