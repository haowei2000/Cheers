//! `channel.usage.read` — ② cost dashboard read side. Returns per-(bot, session)
//! aggregated token/cost totals + latest context window (from `bot_usage_events`), so
//! the ViewBoard can compare multiple sessions side by side.
//!
//! Params: `{ channel_id, session_id? }`. With `session_id` the result is scoped to that
//! one session; omit it to get one row per (bot, session) across all sessions.
//!
//! Aggregation per `(bot_id, session_id)`: SUM the per-turn token deltas; take MAX of the
//! CUMULATIVE `cost_usd`; `context_window` is that pair's most-recent snapshot (latest
//! `created_at`). (Agents like Claude report `cost.amount` cumulatively + a `used`/`size`
//! context snapshot rather than per-turn token counts — see `acp_session_updates`.)
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{authorize_channel_read, Principal, ResourceResult};

/// `resource_req { resource: "channel.usage.read", params: { channel_id } }`
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;
    authorize_channel_read(db, principal, channel_id).await?;

    // Optional session scope: NULL ($2) → all sessions; else only that session.
    let session_id = params.get("session_id").and_then(|v| v.as_str());

    // Per-(bot, session) rollup: SUM tokens + cost across every snapshot for the pair;
    // context_window comes from that pair's latest row (ordered by created_at DESC),
    // joined back so each (bot, session) is one row. The session filter ($2) applies to
    // both the aggregate and the latest-snapshot lookup. `IS NOT DISTINCT FROM` keeps
    // NULL-session events (channel-level, not session-bound) grouped correctly.
    let rows = sqlx::query(
        r#"
        SELECT
            agg.bot_id,
            agg.session_id,
            agg.input_tokens,
            agg.output_tokens,
            agg.total_tokens,
            agg.cost_usd,
            latest.context_window
        FROM (
            SELECT
                bot_id,
                session_id,
                -- SUM(bigint) returns NUMERIC in Postgres; cast back to bigint so
                -- it decodes as i64 (no bigdecimal/rust_decimal sqlx feature enabled).
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens,
                SUM(total_tokens)::bigint  AS total_tokens,
                -- cost is a CUMULATIVE snapshot (Claude ACP `cost.amount` grows over the
                -- session), so take MAX, not SUM, to avoid multiplying it by the event count.
                MAX(cost_usd)              AS cost_usd
            FROM bot_usage_events
            WHERE channel_id = $1
              AND ($2::text IS NULL OR session_id = $2::text)
            GROUP BY bot_id, session_id
        ) agg
        LEFT JOIN LATERAL (
            SELECT context_window
            FROM bot_usage_events e
            WHERE e.channel_id = $1
              AND e.bot_id = agg.bot_id
              AND e.session_id IS NOT DISTINCT FROM agg.session_id
            ORDER BY e.created_at DESC
            LIMIT 1
        ) latest ON TRUE
        ORDER BY agg.bot_id ASC, agg.session_id ASC
        "#,
    )
    .bind(channel_id.to_string())
    .bind(session_id)
    .fetch_all(db)
    .await
    .map_err(super::db_err("usage.read: aggregate bot_usage_events"))?;

    let bots: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "bot_id": row.try_get::<String, _>("bot_id").unwrap_or_default(),
                "session_id": row.try_get::<Option<String>, _>("session_id").ok().flatten(),
                "input_tokens": row.try_get::<Option<i64>, _>("input_tokens").ok().flatten(),
                "output_tokens": row.try_get::<Option<i64>, _>("output_tokens").ok().flatten(),
                "total_tokens": row.try_get::<Option<i64>, _>("total_tokens").ok().flatten(),
                "context_window": row.try_get::<Option<i64>, _>("context_window").ok().flatten(),
                "cost_usd": row.try_get::<Option<f64>, _>("cost_usd").ok().flatten(),
            })
        })
        .collect();

    Ok(json!({ "channel_id": channel_id, "bots": bots }))
}
