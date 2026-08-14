//! Fleet view: global `GET /fleet` plus the retained workspace-scoped
//! `GET /workspaces/:workspace_id/fleet` (docs/design/FLEET_VIEW.md).
//!
//! The primary response is user-level and bot-centric: it answers "who is
//! waiting on me?" and "what is my fleet doing?" across every accessible
//! workspace. The retained workspace route uses the same policy checks for
//! consumers that intentionally need one slice.
//!
//! SECURITY: unlike the in-channel live fanout (`allowed_seers`, which fails
//! open by design), this aggregation surface fails CLOSED — any per-row policy
//! error drops the row. A DB hiccup must not reveal every pending approval in
//! the workspace to every member.

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use std::collections::HashMap;

use crate::{
    api::{bots::is_admin, middleware::Claims},
    app_state::AppState,
    domain::{
        acp_policy, approval,
        bot_event_policy::{self, Capability},
        fleet,
    },
    errors::AppError,
};

#[derive(Deserialize)]
pub struct FleetAuditQuery {
    pub cursor: Option<chrono::DateTime<chrono::Utc>>,
    pub bot_id: Option<String>,
    pub installation_id: Option<String>,
    pub event_type: Option<String>,
    pub limit: Option<i64>,
}

fn user_id(claims: &Claims) -> Result<Uuid, AppError> {
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))
}

/// The caller's channel role for the event-policy matrix (default `member`).
async fn channel_role(state: &AppState, channel_id: Uuid, uid: Uuid) -> String {
    sqlx::query(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .bind(uid.to_string())
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get::<Option<String>, _>("role").ok().flatten())
    .unwrap_or_else(|| "member".to_string())
}

/// Resolve (may_see, may_answer) for one pending card — the same SEE gate and
/// 3-way answer compose as `resolve_permission`. Fail-closed on errors.
///
/// `rules`/`groups` are the bot's access rules and the caller's matched groups,
/// batch-loaded ONCE per bot by the caller (see [`get_fleet`]/[`get_fleet_badge`]);
/// both the SEE and RESPOND gates resolve in memory against them, so this does at
/// most one DB round-trip per row (the `is_approver` delegation lookup, which is
/// per-`op_kind` and can't be memoized here). Decision is identical to resolving
/// each gate independently against the DB.
async fn see_and_answer(
    state: &AppState,
    p: &crate::domain::fleet::FleetPending,
    uid: Uuid,
    role: &str,
    rules: &[bot_event_policy::Rule],
    groups: &[String],
) -> (bool, bool) {
    let may_see = acp_policy::allows_with_rules(
        rules,
        &p.channel_id.to_string(),
        &uid.to_string(),
        role,
        groups,
        "session/request_permission",
        Capability::See,
    );
    if !may_see {
        return (false, false);
    }
    let op_kind = p
        .content_data
        .get("tool")
        .and_then(|t| t.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("*");
    let actionable = approval::is_approver(&state.db, p.bot_id, p.channel_id, uid, op_kind)
        .await
        .unwrap_or(false)
        || acp_policy::allows_with_rules(
            rules,
            &p.channel_id.to_string(),
            &uid.to_string(),
            role,
            groups,
            "session/request_permission",
            Capability::Respond,
        );
    (true, actionable)
}

/// Batch-load each distinct bot's access rules and the caller's matched groups
/// ONCE (mirrors `api::approval::filter_traces_by_see`). Keyed by `bot_id` so the
/// per-row SEE/RESPOND gates resolve in memory instead of re-loading the same
/// bot's rules for every pending row (fixes the N+1 policy fanout).
///
/// A bot whose rule load FAILS is deliberately left out of the caches so the
/// caller drops its rows — preserving this surface's fail-closed contract (the
/// previous per-row `acp_policy::allows(...).unwrap_or(false)` did the same on a
/// DB error). A tracked-but-missing bot therefore means "policy unavailable".
async fn load_policy_caches(
    state: &AppState,
    pending: &[crate::domain::fleet::FleetPending],
    uid: Uuid,
) -> (
    HashMap<Uuid, Vec<bot_event_policy::Rule>>,
    HashMap<Uuid, Vec<String>>,
) {
    let uid_s = uid.to_string();
    let mut rules_by_bot: HashMap<Uuid, Vec<bot_event_policy::Rule>> = HashMap::new();
    let mut groups_by_bot: HashMap<Uuid, Vec<String>> = HashMap::new();
    let mut tried: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    for p in pending {
        if !tried.insert(p.bot_id) {
            continue; // already attempted this bot
        }
        let bid = p.bot_id.to_string();
        // Fail-closed: on a rule-load error, leave this bot out so its rows drop.
        let Ok(rules) = bot_event_policy::load_rules(&state.db, &bid).await else {
            continue;
        };
        let groups = bot_event_policy::matched_groups(&state.db, &bid, &uid_s, &rules).await;
        rules_by_bot.insert(p.bot_id, rules);
        groups_by_bot.insert(p.bot_id, groups);
    }
    (rules_by_bot, groups_by_bot)
}

// ── GET /fleet/badge ─────────────────────────────────────────────────────────

/// Workspace-agnostic count of pending approvals the caller may answer —
/// feeds the rail badge. Cheap by construction: pending volume is small.
pub async fn get_fleet_badge(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    let pending = fleet::find_pending_for_user_all(&state.db, uid).await?;
    // Batch-load policy rules/groups once per bot, then resolve each row in memory.
    let (rules_by_bot, groups_by_bot) = load_policy_caches(&state, &pending, uid).await;
    let mut roles: HashMap<Uuid, String> = HashMap::new();
    let mut count: i64 = 0;
    for p in pending {
        let role = match roles.get(&p.channel_id) {
            Some(r) => r.clone(),
            None => {
                let r = channel_role(&state, p.channel_id, uid).await;
                roles.insert(p.channel_id, r.clone());
                r
            }
        };
        // Fail-closed: a bot absent from the cache had a policy-load error → skip.
        let Some(rules) = rules_by_bot.get(&p.bot_id) else {
            continue;
        };
        let groups = groups_by_bot
            .get(&p.bot_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let (_, actionable) = see_and_answer(&state, &p, uid, &role, rules, groups).await;
        if actionable {
            count += 1;
        }
    }
    Ok(Json(json!({ "count": count })))
}

// ── GET /workspaces/:workspace_id/fleet ─────────────────────────────────────

pub async fn get_fleet(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(workspace_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    if !fleet::is_workspace_member(&state.db, workspace_id, uid).await? {
        return Err(AppError::Forbidden("not a workspace member".into()));
    }

    build_fleet(&state, uid, is_admin(&claims), Some(workspace_id)).await
}

/// Workspace-agnostic fleet for the primary Fleet page. Visibility remains
/// channel-membership scoped; this does not expose a global bot directory.
pub async fn get_fleet_all(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    build_fleet(&state, uid, is_admin(&claims), None).await
}

/// Every registered installation belonging to a bot the caller may manage.
/// Shared bots remain visible in the roster, but their device and credential
/// metadata never crosses this owner/admin boundary.
pub async fn list_installations_all(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let admin = is_admin(&claims);
    let rows = sqlx::query(
        "SELECT i.installation_id, i.bot_id,
                COALESCE(b.display_name, b.username) AS bot_name,
                b.username AS bot_username, i.device_name, i.agent_type,
                i.credential_prefix, i.status, i.connector_version,
                i.last_seen_at, i.connected_at, i.created_at, i.revoked_at,
                i.mcp_connection_state, i.mcp_state_updated_at,
                i.mcp_connected_at, i.mcp_last_seen_at
         FROM terminal_installations i
         JOIN bot_accounts b ON b.bot_id = i.bot_id
         WHERE $1 OR b.created_by = $2
         ORDER BY i.created_at DESC",
    )
    .bind(admin)
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;

    let mut installations = Vec::with_capacity(rows.len());
    for row in rows {
        let bot_id: String = row.try_get("bot_id").unwrap_or_default();
        let status: String = row.try_get("status").unwrap_or_else(|_| "standby".into());
        let revoked_at = row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("revoked_at")
            .ok()
            .flatten();
        let online = match Uuid::parse_str(&bot_id) {
            Ok(id) => state.bot_locator.is_online(id).await,
            Err(_) => false,
        } && status == "active"
            && revoked_at.is_none();
        installations.push(json!({
            "installation_id": row.try_get::<String, _>("installation_id").unwrap_or_default(),
            "bot_id": bot_id,
            "bot_name": row.try_get::<String, _>("bot_name").unwrap_or_default(),
            "bot_username": row.try_get::<String, _>("bot_username").unwrap_or_default(),
            "device_name": row.try_get::<String, _>("device_name").unwrap_or_default(),
            "agent_type": row.try_get::<String, _>("agent_type").unwrap_or_else(|_| "generic".into()),
            "credential_prefix": row.try_get::<String, _>("credential_prefix").unwrap_or_default(),
            "status": status,
            "online": online,
            "connector_version": row.try_get::<Option<String>, _>("connector_version").ok().flatten(),
            "last_seen_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_seen_at").ok().flatten(),
            "connected_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("connected_at").ok().flatten(),
            "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            "revoked_at": revoked_at,
            "mcp_connection_state": row.try_get::<String, _>("mcp_connection_state").unwrap_or_else(|_| "unconfigured".into()),
            "mcp_state_updated_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("mcp_state_updated_at").ok().flatten(),
            "mcp_connected_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("mcp_connected_at").ok().flatten(),
            "mcp_last_seen_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("mcp_last_seen_at").ok().flatten(),
        }));
    }
    Ok(Json(json!({ "installations": installations })))
}

/// Owner/admin-only, cursor-paginated audit across every manageable bot.
pub async fn list_audit_all(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(query): Query<FleetAuditQuery>,
) -> Result<Json<Value>, AppError> {
    let limit = query.limit.unwrap_or(100).clamp(1, 250);
    let rows = sqlx::query(
        "SELECT source, event_id, event_type, bot_id, installation_id, actor_id,
                detail, created_at
         FROM (
           SELECT 'management'::text AS source, a.id AS event_id, a.event_type,
                  a.bot_id, a.installation_id, a.actor_id, a.detail, a.created_at
           FROM bot_management_audit a
           WHERE ($1 OR a.actor_id = $2 OR EXISTS (
             SELECT 1 FROM bot_accounts b WHERE b.bot_id = a.bot_id AND b.created_by = $2
           ))
           UNION ALL
           SELECT 'connection', e.id::text, 'connection.' || e.event, e.bot_id,
                  NULL, NULL, jsonb_build_object('stream', e.stream, 'reason', e.reason,
                  'connection_id', e.connection_id), e.created_at
           FROM bot_connection_events e JOIN bot_accounts b ON b.bot_id = e.bot_id
           WHERE $1 OR b.created_by = $2
           UNION ALL
           SELECT 'acp', l.id::text, l.name, l.bot_id, NULL, NULL,
                  jsonb_build_object('home', l.home, 'channel_id', l.channel_id,
                  'session_id', l.session_id, 'payload', l.payload), l.created_at
           FROM acp_event_log l JOIN bot_accounts b ON b.bot_id = l.bot_id
           WHERE $1 OR b.created_by = $2
           UNION ALL
           SELECT 'approval', a.id, 'approval.' || a.event_type, a.bot_id, NULL,
                  a.actor_id, jsonb_build_object('channel_id', a.channel_id,
                  'request_id', a.request_id, 'decision', a.decision, 'detail', a.detail),
                  a.created_at
           FROM approval_audit a JOIN bot_accounts b ON b.bot_id = a.bot_id
           WHERE $1 OR b.created_by = $2
         ) events
         WHERE ($3::timestamptz IS NULL OR created_at < $3)
           AND ($4::text IS NULL OR bot_id = $4)
           AND ($5::text IS NULL OR installation_id = $5)
           AND ($6::text IS NULL OR event_type = $6)
         ORDER BY created_at DESC, event_id DESC
         LIMIT $7",
    )
    .bind(is_admin(&claims))
    .bind(&claims.sub)
    .bind(query.cursor)
    .bind(query.bot_id)
    .bind(query.installation_id)
    .bind(query.event_type)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;

    let has_more = rows.len() as i64 > limit;
    let events: Vec<Value> = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| json!({
            "id": row.try_get::<String, _>("event_id").unwrap_or_default(),
            "source": row.try_get::<String, _>("source").unwrap_or_default(),
            "event_type": row.try_get::<String, _>("event_type").unwrap_or_default(),
            "bot_id": row.try_get::<Option<String>, _>("bot_id").ok().flatten(),
            "installation_id": row.try_get::<Option<String>, _>("installation_id").ok().flatten(),
            "actor_id": row.try_get::<Option<String>, _>("actor_id").ok().flatten(),
            "detail": row.try_get::<Value, _>("detail").unwrap_or(Value::Null),
            "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").map(|v| v.to_rfc3339()).unwrap_or_default(),
        }))
        .collect();
    let next_cursor = if has_more {
        events
            .last()
            .and_then(|event| event.get("created_at"))
            .cloned()
    } else {
        None
    };
    Ok(Json(
        json!({ "events": events, "next_cursor": next_cursor }),
    ))
}

async fn build_fleet(
    state: &AppState,
    uid: Uuid,
    admin: bool,
    workspace_id: Option<Uuid>,
) -> Result<Json<Value>, AppError> {
    // ── Zone A: pending approvals (SEE-gated, flagged with may-answer) ──────
    let pending = match workspace_id {
        Some(workspace_id) => fleet::find_pending_for_user(&state.db, workspace_id, uid).await?,
        None => fleet::find_pending_for_user_all(&state.db, uid).await?,
    };
    // Batch-load policy rules/groups once per bot, then resolve each row in memory.
    let (rules_by_bot, groups_by_bot) = load_policy_caches(state, &pending, uid).await;
    // Channel roles are shared by both policy checks below; resolve each once.
    let mut roles: HashMap<Uuid, String> = HashMap::new();
    let mut approvals: Vec<Value> = Vec::with_capacity(pending.len());
    let mut pending_counts: HashMap<(Uuid, Uuid), i64> = HashMap::new();
    for p in pending {
        let role = match roles.get(&p.channel_id) {
            Some(r) => r.clone(),
            None => {
                let r = channel_role(state, p.channel_id, uid).await;
                roles.insert(p.channel_id, r.clone());
                r
            }
        };
        // Fail-closed: a bot absent from the cache had a policy-load error → drop.
        let Some(rules) = rules_by_bot.get(&p.bot_id) else {
            continue;
        };
        let groups = groups_by_bot
            .get(&p.bot_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        // SEE gate — fail-closed: on error, drop the row (see module docs).
        let (may_see, actionable) = see_and_answer(state, &p, uid, &role, rules, groups).await;
        if !may_see {
            continue;
        }
        *pending_counts.entry((p.bot_id, p.channel_id)).or_insert(0) += 1;
        approvals.push(json!({
            "message_id": p.msg_id.to_string(),
            "channel_id": p.channel_id.to_string(),
            "channel_name": p.channel_name,
            "bot_id": p.bot_id.to_string(),
            "created_at": p.created_at,
            "actionable": actionable,
            "content_data": p.content_data,
        }));
    }

    // ── Zone B: bot roster with liveness / sessions / cost decoration ───────
    let bots = match workspace_id {
        Some(workspace_id) => fleet::list_fleet_bots(&state.db, workspace_id, uid).await?,
        None => fleet::list_fleet_bots_all(&state.db, uid).await?,
    };
    let channel_ids: Vec<String> = {
        let mut ids: Vec<String> = bots.iter().map(|b| b.channel_id.to_string()).collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let sessions = fleet::session_counts(&state.db, &channel_ids).await?;
    let costs = fleet::cost_today(&state.db, &channel_ids).await?;
    // Liveness once per unique bot (a bot may sit in several channels).
    let mut online: HashMap<Uuid, bool> = HashMap::new();
    for b in &bots {
        if let std::collections::hash_map::Entry::Vacant(e) = online.entry(b.bot_id) {
            e.insert(state.bot_locator.is_online(b.bot_id).await);
        }
    }

    // The personal cockpit is bot-centric: include owned bots even before they
    // join a channel and collapse every bot×channel row into one bot summary.
    if workspace_id.is_none() {
        let catalog = sqlx::query(
            "SELECT b.bot_id, COALESCE(b.display_name, b.username) AS bot_name,
                    b.username, b.created_by, b.is_disabled, b.status_text, b.status_emoji
             FROM bot_accounts b
             WHERE $2 OR b.created_by = $1 OR EXISTS (
               SELECT 1 FROM channel_memberships bcm
               JOIN channel_memberships me ON me.channel_id = bcm.channel_id
               WHERE bcm.member_id = b.bot_id AND bcm.member_type = 'bot'
                 AND me.member_id = $1 AND me.member_type = 'user'
             )
             ORDER BY bot_name",
        )
        .bind(uid.to_string())
        .bind(admin)
        .fetch_all(&state.db)
        .await?;
        let installation_counts: HashMap<String, i64> = sqlx::query(
            "SELECT i.bot_id, COUNT(*) FILTER (WHERE i.revoked_at IS NULL) AS count
             FROM terminal_installations i JOIN bot_accounts b ON b.bot_id = i.bot_id
             WHERE $2 OR b.created_by = $1 GROUP BY i.bot_id",
        )
        .bind(uid.to_string())
        .bind(admin)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .filter_map(|row| {
            Some((
                row.try_get("bot_id").ok()?,
                row.try_get("count").unwrap_or(0),
            ))
        })
        .collect();

        let mut bot_rows: HashMap<Uuid, Vec<&crate::domain::fleet::FleetBotRow>> = HashMap::new();
        for row in &bots {
            bot_rows.entry(row.bot_id).or_default().push(row);
        }
        let mut summaries = Vec::with_capacity(catalog.len());
        let mut online_count = 0_i64;
        let mut working_count = 0_i64;
        let mut offline_count = 0_i64;
        for row in catalog {
            let bot_id_s: String = row.try_get("bot_id").unwrap_or_default();
            let Ok(bot_id) = Uuid::parse_str(&bot_id_s) else {
                continue;
            };
            let rows = bot_rows.get(&bot_id).cloned().unwrap_or_default();
            let mut busy = 0_i64;
            let mut idle = 0_i64;
            let mut cost = 0.0_f64;
            let mut pending = 0_i64;
            let mut channels = Vec::new();
            for item in rows {
                let key = (item.bot_id, item.channel_id);
                let counts = sessions.get(&key).copied().unwrap_or((0, 0));
                busy += counts.0;
                idle += counts.1;
                cost += costs.get(&key).copied().unwrap_or(0.0);
                pending += pending_counts.get(&key).copied().unwrap_or(0);
                channels.push(json!({
                    "channel_id": item.channel_id.to_string(),
                    "channel_name": item.channel_name,
                }));
            }
            let is_online = match online.get(&bot_id).copied() {
                Some(value) => value,
                None => state.bot_locator.is_online(bot_id).await,
            };
            if !is_online {
                offline_count += 1;
            } else if busy > 0 {
                working_count += 1;
            } else {
                online_count += 1;
            }
            let can_manage = admin
                || row
                    .try_get::<Option<String>, _>("created_by")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some(uid.to_string().as_str());
            summaries.push(json!({
                "bot_id": bot_id_s,
                "bot_name": row.try_get::<String, _>("bot_name").unwrap_or_default(),
                "username": row.try_get::<String, _>("username").unwrap_or_default(),
                "can_manage": can_manage,
                "relationship": if can_manage { "mine" } else { "shared" },
                "is_disabled": row.try_get::<bool, _>("is_disabled").unwrap_or(false),
                "online": is_online,
                "busy_sessions": busy,
                "idle_sessions": idle,
                "status_text": row.try_get::<Option<String>, _>("status_text").ok().flatten(),
                "status_emoji": row.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
                "cost_today_usd": cost,
                "pending_count": pending,
                "installation_count": installation_counts.get(&bot_id_s).copied().unwrap_or(0),
                "channels": channels,
            }));
        }
        return Ok(Json(json!({
            "summary": {
                "online": online_count,
                "working": working_count,
                "offline": offline_count,
                "waiting": approvals.iter().filter(|item| item.get("actionable") == Some(&Value::Bool(true))).count(),
            },
            "approvals": approvals,
            "bots": summaries,
        })));
    }
    let bots_json: Vec<Value> = bots
        .iter()
        .map(|b| {
            let key = (b.bot_id, b.channel_id);
            let (busy, idle) = sessions.get(&key).copied().unwrap_or((0, 0));
            json!({
                "bot_id": b.bot_id.to_string(),
                "bot_name": b.bot_name,
                "channel_id": b.channel_id.to_string(),
                "channel_name": b.channel_name,
                "online": online.get(&b.bot_id).copied().unwrap_or(false),
                "busy_sessions": busy,
                "idle_sessions": idle,
                "status_text": b.status_text,
                "status_emoji": b.status_emoji,
                "cost_today_usd": costs.get(&key).copied().unwrap_or(0.0),
                "pending_count": pending_counts.get(&key).copied().unwrap_or(0),
            })
        })
        .collect();

    Ok(Json(json!({ "approvals": approvals, "bots": bots_json })))
}
