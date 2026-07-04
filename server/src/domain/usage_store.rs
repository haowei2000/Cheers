//! ② Cost dashboard storage — append-only per-turn usage snapshots, aggregated at
//! read time. Source events parse through [`crate::domain::acp_session_updates`];
//! this module owns the `bot_usage_events` table (migration 0036). Read side lives
//! in `resource/usage.rs`.
//!
//! Each [`record`] call appends ONE immutable snapshot row; the read side
//! (`resource/usage.rs`) does the SUM / latest aggregation per bot.
use crate::domain::acp_session_updates::Usage;
use sqlx::PgPool;
use uuid::Uuid;

/// Best-effort insert of one usage snapshot. Never disrupts the live turn — any
/// write failure is logged and swallowed; the call site treats this as fire-and-forget.
///
/// Skips entirely when there is nothing keyable/aggregatable: no `channel_id`
/// (the row is keyed by channel for the dashboard read) AND every usage field is
/// `None` (an empty snapshot carries no signal).
pub async fn record(
    db: &PgPool,
    channel_id: Option<&str>,
    bot_id: &str,
    session_id: Option<&str>,
    usage: &Usage,
) {
    // Cannot key the dashboard row without a channel; nor is an all-empty snapshot
    // worth persisting. Either condition alone is fine (e.g. channel present but a
    // sparse snapshot still records the event), so we only skip when BOTH hold.
    let all_empty = usage.input_tokens.is_none()
        && usage.output_tokens.is_none()
        && usage.total_tokens.is_none()
        && usage.context_window.is_none()
        && usage.cost_usd.is_none();
    let channel_id = match channel_id {
        Some(c) => c,
        None => return,
    };
    if all_empty {
        return;
    }

    let id = Uuid::new_v4().to_string();
    let res = sqlx::query(
        "INSERT INTO bot_usage_events \
            (id, channel_id, bot_id, session_id, \
             input_tokens, output_tokens, total_tokens, context_window, cost_usd) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id)
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(session_id.map(|s| s.to_string()))
    .bind(usage.input_tokens)
    .bind(usage.output_tokens)
    .bind(usage.total_tokens)
    .bind(usage.context_window)
    .bind(usage.cost_usd)
    .execute(db)
    .await;

    if let Err(e) = res {
        tracing::warn!(
            error = %e,
            channel_id = channel_id,
            bot_id = bot_id,
            "usage_store::record: insert bot_usage_events failed (swallowed)"
        );
    }
}
