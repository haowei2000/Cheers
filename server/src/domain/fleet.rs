//! Fleet view: workspace-level aggregation queries (docs/design/FLEET_VIEW.md).
//!
//! Read-only SQL for the two Fleet zones — the caller's pending-approval inbox
//! and the bot roster with session/cost rollups. Policy (SEE / may-answer) is
//! deliberately NOT evaluated here: the API layer resolves it per row in Rust,
//! same shape as `api::approval::filter_traces_by_see`. Pending volume is small;
//! pushing policy into SQL isn't worth the coupling.

use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// One unresolved permission card in a channel the user is a member of.
pub struct FleetPending {
    pub msg_id: Uuid,
    pub channel_id: Uuid,
    pub channel_name: String,
    pub bot_id: Uuid,
    pub content_data: Value,
    pub created_at: String,
}

/// Unresolved permission cards across every channel of `workspace_id` that
/// `user_id` is a member of, newest first. Membership is the only gate applied
/// here — the caller must still apply SEE + may-answer per row.
pub async fn find_pending_for_user(
    db: &PgPool,
    workspace_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<FleetPending>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT m.msg_id, m.channel_id, c.name AS channel_name, m.sender_id,
                m.content_data, m.created_at
         FROM messages m
         JOIN channels c ON c.channel_id = m.channel_id
         JOIN channel_memberships cm
           ON cm.channel_id = m.channel_id
          AND cm.member_id = $2 AND cm.member_type = 'user'
         WHERE c.workspace_id = $1
           AND m.msg_type = 'permission'
           AND (m.content_data->>'resolved' IS NULL
                OR m.content_data->>'resolved' = 'false')
         ORDER BY m.created_at DESC
         LIMIT 100",
    )
    .bind(workspace_id.to_string())
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().filter_map(row_to_fleet_pending).collect())
}

fn row_to_fleet_pending(r: sqlx::postgres::PgRow) -> Option<FleetPending> {
    Some(FleetPending {
        msg_id: r
            .try_get::<String, _>("msg_id")
            .ok()
            .and_then(|s| s.parse().ok())?,
        channel_id: r
            .try_get::<String, _>("channel_id")
            .ok()
            .and_then(|s| s.parse().ok())?,
        channel_name: r.try_get("channel_name").unwrap_or_default(),
        bot_id: r
            .try_get::<String, _>("sender_id")
            .ok()
            .and_then(|s| s.parse().ok())?,
        content_data: r
            .try_get::<Option<Value>, _>("content_data")
            .ok()
            .flatten()
            .unwrap_or(Value::Null),
        created_at: r
            .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .map(|t| t.to_rfc3339())
            .unwrap_or_default(),
    })
}

/// Unresolved permission cards across ALL channels `user_id` is a member of
/// (every workspace) — feeds the rail badge, which is workspace-agnostic.
/// Same contract as [`find_pending_for_user`]: membership-gated only.
pub async fn find_pending_for_user_all(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<FleetPending>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT m.msg_id, m.channel_id, c.name AS channel_name, m.sender_id,
                m.content_data, m.created_at
         FROM messages m
         JOIN channels c ON c.channel_id = m.channel_id
         JOIN channel_memberships cm
           ON cm.channel_id = m.channel_id
          AND cm.member_id = $1 AND cm.member_type = 'user'
         WHERE m.msg_type = 'permission'
           AND (m.content_data->>'resolved' IS NULL
                OR m.content_data->>'resolved' = 'false')
         ORDER BY m.created_at DESC
         LIMIT 100",
    )
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().filter_map(row_to_fleet_pending).collect())
}

/// One bot × channel roster row (before liveness/cost/pending decoration).
pub struct FleetBotRow {
    pub bot_id: Uuid,
    pub channel_id: Uuid,
    pub channel_name: String,
    pub bot_name: String,
    pub status_text: Option<String>,
    pub status_emoji: Option<String>,
}

/// Every bot that shares a channel with `user_id` inside `workspace_id`.
pub async fn list_fleet_bots(
    db: &PgPool,
    workspace_id: Uuid,
    user_id: Uuid,
) -> Result<Vec<FleetBotRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT cm.member_id AS bot_id, cm.channel_id, c.name AS channel_name,
                COALESCE(ba.display_name, ba.username) AS bot_name,
                ba.status_text, ba.status_emoji
         FROM channel_memberships cm
         JOIN channels c ON c.channel_id = cm.channel_id
         JOIN channel_memberships me
           ON me.channel_id = cm.channel_id
          AND me.member_id = $2 AND me.member_type = 'user'
         JOIN bot_accounts ba ON ba.bot_id = cm.member_id
         WHERE c.workspace_id = $1 AND cm.member_type = 'bot'
         ORDER BY c.name, bot_name",
    )
    .bind(workspace_id.to_string())
    .bind(user_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            Some(FleetBotRow {
                bot_id: r
                    .try_get::<String, _>("bot_id")
                    .ok()
                    .and_then(|s| s.parse().ok())?,
                channel_id: r
                    .try_get::<String, _>("channel_id")
                    .ok()
                    .and_then(|s| s.parse().ok())?,
                channel_name: r.try_get("channel_name").unwrap_or_default(),
                bot_name: r.try_get("bot_name").unwrap_or_default(),
                status_text: r.try_get::<Option<String>, _>("status_text").ok().flatten(),
                status_emoji: r
                    .try_get::<Option<String>, _>("status_emoji")
                    .ok()
                    .flatten(),
            })
        })
        .collect())
}

/// (busy, idle) live-session counts keyed by `(bot_id, channel_id)`.
/// Same liveness rule as `resource/sessions.rs`: terminated/revoked/expired are
/// closed; of the live ones, `busy` is the connector-reported in-flight status.
pub async fn session_counts(
    db: &PgPool,
    channel_ids: &[String],
) -> Result<std::collections::HashMap<(Uuid, Uuid), (i64, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT b.bot_id, b.scope_id AS channel_id,
                COUNT(*) FILTER (WHERE s.status = 'busy') AS busy,
                COUNT(*) FILTER (WHERE s.status NOT IN
                    ('busy','terminated','revoked','expired','error')) AS idle
         FROM cheers_session_bindings b
         JOIN cheers_sessions s ON s.session_id = b.session_id
         WHERE b.scope_type = 'channel' AND b.scope_id = ANY($1)
         GROUP BY b.bot_id, b.scope_id",
    )
    .bind(channel_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let bot: Uuid = r
                .try_get::<String, _>("bot_id")
                .ok()
                .and_then(|s| s.parse().ok())?;
            let ch: Uuid = r
                .try_get::<String, _>("channel_id")
                .ok()
                .and_then(|s| s.parse().ok())?;
            let busy: i64 = r.try_get("busy").unwrap_or(0);
            let idle: i64 = r.try_get("idle").unwrap_or(0);
            Some(((bot, ch), (busy, idle)))
        })
        .collect())
}

/// Today's (UTC) cost keyed by `(bot_id, channel_id)`.
///
/// `cost_usd` is a cumulative per-session snapshot (see `resource/usage.rs`), so
/// this sums each session's latest snapshot *among today's events*. Sessions
/// spanning midnight therefore attribute their whole cumulative cost to today —
/// a documented P1 approximation, matching the Cost panel's aggregation grain.
pub async fn cost_today(
    db: &PgPool,
    channel_ids: &[String],
) -> Result<std::collections::HashMap<(Uuid, Uuid), f64>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT channel_id, bot_id, SUM(max_cost) AS cost
         FROM (
             SELECT channel_id, bot_id, session_id, MAX(cost_usd) AS max_cost
             FROM bot_usage_events
             WHERE channel_id = ANY($1)
               AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc')
             GROUP BY channel_id, bot_id, session_id
         ) per_session
         GROUP BY channel_id, bot_id",
    )
    .bind(channel_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let bot: Uuid = r
                .try_get::<String, _>("bot_id")
                .ok()
                .and_then(|s| s.parse().ok())?;
            let ch: Uuid = r
                .try_get::<String, _>("channel_id")
                .ok()
                .and_then(|s| s.parse().ok())?;
            let cost: Option<f64> = r.try_get("cost").ok();
            Some(((bot, ch), cost.unwrap_or(0.0)))
        })
        .collect())
}

/// Is `user_id` a member of `workspace_id`? Personal workspaces have no
/// membership rows — their owner is `workspaces.owner_user_id` (see
/// `domain::workspaces::get_or_create_personal_workspace`), so accept either.
pub async fn is_workspace_member(
    db: &PgPool,
    workspace_id: Uuid,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        "SELECT (EXISTS(
            SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2
        ) OR EXISTS(
            SELECT 1 FROM workspaces
            WHERE workspace_id = $1 AND owner_user_id = $2
        )) AS ok",
    )
    .bind(workspace_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(db)
    .await?;
    Ok(row.try_get::<bool, _>("ok").unwrap_or(false))
}
