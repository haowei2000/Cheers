//! ① Plan board storage — the latest agent plan per (channel, bot, session).
//! Source events parse through [`crate::domain::acp_session_updates`]; this module
//! owns the `bot_session_plans` table (migration 0035). Read side lives in
//! `resource/plan.rs`.
//!
//! Best-effort: the upsert is fired from the live ACP turn (`handle_acp_event_frame`),
//! so a write failure must never disrupt the turn — it is logged and swallowed.
use crate::domain::acp_session_updates::Plan;
use sqlx::PgPool;

/// Best-effort upsert of a bot's latest plan in a channel session.
/// Never disrupts the live turn — any write failure is logged and swallowed.
///
/// Keyed by `(channel_id, bot_id, session_id)`. A `None` `channel_id` cannot key
/// the row, so we return early. A `None` `session_id` maps to `""` (the primary /
/// unkeyed session) to keep the PK total, mirroring the migration's column default.
pub async fn record(
    db: &PgPool,
    channel_id: Option<&str>,
    bot_id: &str,
    session_id: Option<&str>,
    plan: &Plan,
) {
    let Some(channel_id) = channel_id else {
        // No channel to key the row against — nothing to persist.
        return;
    };
    let session_id = session_id.unwrap_or("");

    // Latest-wins upsert: a new plan for the same (channel, bot, session) fully
    // replaces the prior entries/progress snapshot.
    let entries_json = serde_json::to_string(&plan.entries).unwrap_or_else(|_| "[]".into());
    let total = plan.total() as i32;
    let completed = plan.completed() as i32;

    let result = sqlx::query(
        "INSERT INTO bot_session_plans
            (channel_id, bot_id, session_id, entries, total, completed, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
         ON CONFLICT (channel_id, bot_id, session_id)
         DO UPDATE SET
            entries    = $4::jsonb,
            total      = $5,
            completed  = $6,
            updated_at = now()",
    )
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(session_id.to_string())
    .bind(entries_json)
    .bind(total)
    .bind(completed)
    .execute(db)
    .await;

    if let Err(e) = result {
        tracing::warn!(
            error = %e,
            channel_id = channel_id,
            bot_id = bot_id,
            session_id = session_id,
            "plan_store::record: failed to upsert plan (swallowed)"
        );
    }
}
