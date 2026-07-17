//! Fleet view: `GET /workspaces/:workspace_id/fleet` (docs/design/FLEET_VIEW.md).
//!
//! One workspace-level aggregation answering "who is waiting on me?" (pending
//! approvals the caller may see, flagged with whether they may answer) and
//! "what is my fleet doing?" (bot roster with liveness, session counts, status
//! line, and today's cost).
//!
//! SECURITY: unlike the in-channel live fanout (`allowed_seers`, which fails
//! open by design), this aggregation surface fails CLOSED — any per-row policy
//! error drops the row. A DB hiccup must not reveal every pending approval in
//! the workspace to every member.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use std::collections::HashMap;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::{
        acp_policy, approval,
        bot_event_policy::{self, Capability},
        fleet,
    },
    errors::AppError,
};

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

    // ── Zone A: pending approvals (SEE-gated, flagged with may-answer) ──────
    let pending = fleet::find_pending_for_user(&state.db, workspace_id, uid).await?;
    // Batch-load policy rules/groups once per bot, then resolve each row in memory.
    let (rules_by_bot, groups_by_bot) = load_policy_caches(&state, &pending, uid).await;
    // Channel roles are shared by both policy checks below; resolve each once.
    let mut roles: HashMap<Uuid, String> = HashMap::new();
    let mut approvals: Vec<Value> = Vec::with_capacity(pending.len());
    let mut pending_counts: HashMap<(Uuid, Uuid), i64> = HashMap::new();
    for p in pending {
        let role = match roles.get(&p.channel_id) {
            Some(r) => r.clone(),
            None => {
                let r = channel_role(&state, p.channel_id, uid).await;
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
        let (may_see, actionable) = see_and_answer(&state, &p, uid, &role, rules, groups).await;
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
    let bots = fleet::list_fleet_bots(&state.db, workspace_id, uid).await?;
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
