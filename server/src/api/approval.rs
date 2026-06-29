//! REST surface for the ACP per-operation approval flow.
//!
//! See docs/arch/ACP_APPROVAL_FLOW.md. Default approver = bot owner; the owner
//! delegates/revokes approver rights to channel members; every event is audited.

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
    api::middleware::Claims,
    app_state::AppState,
    domain::{
        approval::{self, AuditEvent},
        bot_event_policy::{self, Capability},
    },
    errors::AppError,
    gateway::realtime::frame::WireFrame,
    infra::db::models::MESSAGE_SCHEMA_VERSION,
};

fn user_id(claims: &Claims) -> Result<Uuid, AppError> {
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))
}

/// The caller's channel role for the event-policy `SEE` matrix (default `member`).
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

/// Read-time SEE filter (docs/arch/ACP_EVENT_TAXONOMY.md): drop the trace rows whose
/// bot's event policy denies this user `SEE` for the row's class. A row's class is
/// `permission_request` for `kind="approval"`, else `tool_call` (the execution-detail
/// class). Rows with no `bot_id` (system traces) pass. Platform admins bypass.
async fn filter_traces_by_see(
    state: &AppState,
    channel_id: Uuid,
    uid: Uuid,
    claims_role: &str,
    events: Vec<Value>,
) -> Vec<Value> {
    if matches!(claims_role, "system_admin" | "admin") {
        return events;
    }
    let role = channel_role(state, channel_id, uid).await;
    let uid_s = uid.to_string();
    let chan_s = channel_id.to_string();
    // Load each referenced bot's rules once.
    let mut rules_by_bot: HashMap<String, Vec<bot_event_policy::Rule>> = HashMap::new();
    for ev in &events {
        if let Some(bid) = ev.get("bot_id").and_then(Value::as_str) {
            if !rules_by_bot.contains_key(bid) {
                let rules = bot_event_policy::load_rules(&state.db, bid)
                    .await
                    .unwrap_or_default();
                rules_by_bot.insert(bid.to_string(), rules);
            }
        }
    }
    events
        .into_iter()
        .filter(|ev| {
            let Some(bid) = ev.get("bot_id").and_then(Value::as_str) else {
                return true; // non-bot trace: no policy
            };
            let Some(rules) = rules_by_bot.get(bid) else {
                return true;
            };
            let class = match ev.get("kind").and_then(Value::as_str) {
                Some("approval") => bot_event_policy::EV_PERMISSION_REQUEST,
                _ => bot_event_policy::EV_TOOL_CALL,
            };
            bot_event_policy::resolve_access(rules, &chan_s, &uid_s, &role, class, Capability::See)
        })
        .collect()
}

/// Channel-membership gate (system_admin/admin bypass), mirroring messages.rs.
async fn ensure_member(
    state: &AppState,
    channel_id: Uuid,
    uid: Uuid,
    role: &str,
) -> Result<(), AppError> {
    if matches!(role, "system_admin" | "admin") {
        return Ok(());
    }
    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(channel_id.to_string())
    .bind(uid.to_string())
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(AppError::Forbidden("not a channel member".into()))
    }
}

/// Bot-owner gate (system_admin bypass) for delegation management.
async fn require_bot_owner(state: &AppState, bot_id: Uuid, uid: Uuid, role: &str) -> Result<(), AppError> {
    if role == "system_admin" {
        return Ok(());
    }
    match approval::bot_owner(&state.db, bot_id).await? {
        Some(owner) if owner == uid => Ok(()),
        Some(_) => Err(AppError::Forbidden("only the bot owner can manage approvers".into())),
        None => Err(AppError::NotFound),
    }
}

// ── POST /channels/:cid/permissions/:request_id/resolve ─────────────────────

#[derive(Deserialize)]
pub struct ResolveRequest {
    pub option_id: String,
}

pub async fn resolve_permission(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, request_id)): Path<(Uuid, String)>,
    Json(body): Json<ResolveRequest>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    let pending = approval::find_pending(&state.db, channel_id, &request_id)
        .await?
        .ok_or(AppError::NotFound)?;

    if pending.content_data.get("resolved").and_then(Value::as_bool) == Some(true) {
        return Err(AppError::Conflict("approval already resolved".into()));
    }
    // The operation_kind being approved (opaque ACP toolCall.kind) scopes which
    // delegates may resolve it; the owner may always resolve. Default '*'.
    let op_kind = pending
        .content_data
        .get("tool")
        .and_then(|t| t.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("*");
    // Who may answer a permission_request = bot owner OR a per-kind approver
    // (approval_delegations) OR a RESPOND grant in the event-policy matrix. All three
    // compose; default is owner/approver-only (no loosening). See ACP_EVENT_TAXONOMY.md.
    let may_respond = approval::is_approver(&state.db, pending.bot_id, channel_id, uid, op_kind)
        .await?
        || {
            let role = channel_role(&state, channel_id, uid).await;
            crate::domain::acp_policy::allows(
                &state.db,
                &pending.bot_id.to_string(),
                &channel_id.to_string(),
                &uid.to_string(),
                &role,
                "session/request_permission",
                Capability::Respond,
            )
            .await
            .unwrap_or(false)
        };
    if !may_respond {
        return Err(AppError::Forbidden("not authorized to resolve this bot's permission".into()));
    }

    let kind = approval::option_kind(&pending.content_data, &body.option_id)
        .ok_or_else(|| AppError::BadRequest("unknown option_id".into()))?
        .to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let option_id = body.option_id.clone();

    // Atomic finalize FIRST: the `resolved` flag is the single arbiter between
    // this human resolve (HTTP) and a racing connector timeout/cancel (WS) — they
    // run on independent tasks. Decide the winner before any audit/trace/dispatch
    // side effects, so a loser writes no contradictory rows. (The read-side check
    // above is just a fast path; this compare-and-set is authoritative.)
    let patch = json!({
        "resolved": true,
        "resolved_by": uid.to_string(),
        "resolved_at": now,
        "chosen_option_id": option_id,
        "chosen_kind": kind,
    });
    if !approval::patch_content_data_if_unresolved(&state.db, pending.msg_id, patch.clone()).await? {
        return Err(AppError::Conflict("approval already resolved".into()));
    }

    // Legal audit log — we won the finalize, so this is authoritative.
    approval::record_audit(
        &state.db,
        AuditEvent {
            event_type: "resolved",
            bot_id: Some(pending.bot_id),
            channel_id,
            request_id: Some(request_id.clone()),
            msg_id: Some(pending.msg_id),
            actor_id: Some(uid),
            decision: Some(kind.clone()),
            option_id: Some(option_id.clone()),
            ..Default::default()
        },
    )
    .await?;

    // Sibling trace-timeline row for the resolution, anchored to the bot turn
    // (source_msg_id) so it interleaves with that turn's traces. Best-effort.
    let resolve_anchor = pending
        .content_data
        .get("source_msg_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| pending.msg_id.to_string());
    if let Err(err) = crate::domain::trace::record(
        &state.db,
        crate::domain::trace::TraceEvent {
            msg_id: resolve_anchor,
            channel_id: channel_id.to_string(),
            bot_id: Some(pending.bot_id.to_string()),
            kind: "approval",
            phase: "approval".to_string(),
            status: Some(
                if kind.starts_with("allow") {
                    "approved"
                } else {
                    "denied"
                }
                .to_string(),
            ),
            request_id: Some(request_id.clone()),
            approval_kind: Some("resolved".to_string()),
            decision: Some(kind.clone()),
            option_id: Some(option_id.clone()),
            actor_id: Some(uid.to_string()),
            ..Default::default()
        },
    )
    .await
    {
        tracing::warn!(error = %err, "resolve_permission: trace write failed");
    }

    // Push the decision to the bot's connector (control frame → ACP outcome).
    let resolution = if kind.starts_with("allow") { "allow" } else { "reject" };
    let frame = json!({
        "type": "permission_resolution",
        "v": 1,
        "request_id": request_id,
        "message_id": pending.msg_id.to_string(),
        "resolution": resolution,
        "option_id": option_id,
        "resolved_by": uid.to_string(),
        "resolved_at": now,
    });
    let delivered = state.bot_locator.dispatch_task(pending.bot_id, frame).await;

    // Broadcast the resolved card so every client clears the pending state.
    let mut content_data = pending.content_data.clone();
    if let (Value::Object(target), Value::Object(src)) = (&mut content_data, &patch) {
        for (k, v) in src {
            target.insert(k.clone(), v.clone());
        }
    }
    let wire = WireFrame::channel(
        channel_id,
        "message",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": pending.msg_id,
            "channel_id": channel_id,
            "channel_seq": pending.channel_seq,
            "sender_type": "bot",
            "sender_id": pending.bot_id,
            "content": pending.content,
            "msg_type": "permission",
            "is_partial": false,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
            "content_data": content_data,
        }),
    );
    state.fanout.broadcast_channel(channel_id, wire).await;

    Ok(Json(json!({ "ok": true, "delivered": delivered, "decision": kind })))
}

// ── POST /channels/:cid/permissions/:request_id/request-access ──────────────

pub async fn request_access(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, request_id)): Path<(Uuid, String)>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    ensure_member(&state, channel_id, uid, &claims.role).await?;
    let pending = approval::find_pending(&state.db, channel_id, &request_id)
        .await?
        .ok_or(AppError::NotFound)?;

    approval::record_audit(
        &state.db,
        AuditEvent {
            event_type: "access_requested",
            bot_id: Some(pending.bot_id),
            channel_id,
            request_id: Some(request_id),
            msg_id: Some(pending.msg_id),
            actor_id: Some(uid),
            target_user_id: Some(uid),
            ..Default::default()
        },
    )
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ── GET /channels/:cid/permissions/audit ────────────────────────────────────

#[derive(Deserialize)]
pub struct AuditQuery {
    #[serde(default = "default_audit_limit")]
    pub limit: i64,
}

fn default_audit_limit() -> i64 {
    100
}

pub async fn list_audit(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    ensure_member(&state, channel_id, uid, &claims.role).await?;
    let limit = q.limit.clamp(1, 500);
    let events = approval::list_audit(&state.db, channel_id, limit).await?;
    Ok(Json(json!({ "events": events })))
}

// ── GET /channels/:cid/messages/:msg_id/trace ───────────────────────────────
// Durable per-turn agent trace (incl. interleaved approval events) for one bot
// message. The optional/later frontend timeline reads this; approval_audit
// (GET .../permissions/audit) stays the separate legal log.

pub async fn list_message_trace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, msg_id)): Path<(Uuid, String)>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    ensure_member(&state, channel_id, uid, &claims.role).await?;
    let limit = q.limit.clamp(1, 1000);
    let events = crate::domain::trace::list_for_message(&state.db, &msg_id, limit).await?;
    let events = filter_traces_by_see(&state, channel_id, uid, &claims.role, events).await;
    Ok(Json(json!({ "events": events })))
}

// ── GET /channels/:cid/traces?kind=&limit ───────────────────────────────────

#[derive(Deserialize)]
pub struct ChannelTraceQuery {
    #[serde(default = "default_audit_limit")]
    pub limit: i64,
    pub kind: Option<String>,
}

pub async fn list_channel_trace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<ChannelTraceQuery>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    ensure_member(&state, channel_id, uid, &claims.role).await?;
    let limit = q.limit.clamp(1, 500);
    let events = crate::domain::trace::list_for_channel(
        &state.db,
        &channel_id.to_string(),
        q.kind.as_deref(),
        limit,
    )
    .await?;
    let events = filter_traces_by_see(&state, channel_id, uid, &claims.role, events).await;
    Ok(Json(json!({ "events": events })))
}

// ── GET/POST /bots/:bid/approvers, DELETE /bots/:bid/approvers/:uid ──────────

#[derive(Deserialize)]
pub struct ApproversQuery {
    pub channel_id: Uuid,
}

pub async fn list_approvers(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<Uuid>,
    Query(q): Query<ApproversQuery>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    ensure_member(&state, q.channel_id, uid, &claims.role).await?;
    let owner = approval::bot_owner(&state.db, bot_id).await?;
    let approvers = approval::list_approvers(&state.db, bot_id, q.channel_id).await?;
    Ok(Json(json!({
        "owner_id": owner.map(|o| o.to_string()),
        "delegates": approvers,
    })))
}

/// Default ACP operation_kind when a caller doesn't scope the grant/revoke: the
/// `*` catch-all (preserves the pre-per-operation behavior).
fn any_kind() -> String {
    "*".into()
}

#[derive(Deserialize)]
pub struct GrantRequest {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    /// ACP operation_kind this delegate may approve; `*` = any. Defaults to `*`.
    #[serde(default = "any_kind")]
    pub operation_kind: String,
}

pub async fn grant_approver(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<Uuid>,
    Json(body): Json<GrantRequest>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    require_bot_owner(&state, bot_id, uid, &claims.role).await?;
    // A non-member can't usefully approve; keep the delegation meaningful.
    ensure_member(&state, body.channel_id, body.user_id, "member").await?;

    approval::grant_approver(
        &state.db,
        bot_id,
        body.channel_id,
        body.user_id,
        &body.operation_kind,
        uid,
    )
    .await?;
    approval::record_audit(
        &state.db,
        AuditEvent {
            event_type: "access_granted",
            bot_id: Some(bot_id),
            channel_id: body.channel_id,
            actor_id: Some(uid),
            target_user_id: Some(body.user_id),
            detail: Some(json!({ "operation_kind": body.operation_kind })),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RevokeQuery {
    pub channel_id: Uuid,
    #[serde(default = "any_kind")]
    pub operation_kind: String,
}

pub async fn revoke_approver(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, target_user)): Path<(Uuid, Uuid)>,
    Query(q): Query<RevokeQuery>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    require_bot_owner(&state, bot_id, uid, &claims.role).await?;

    let revoked = approval::revoke_approver(
        &state.db,
        bot_id,
        q.channel_id,
        target_user,
        &q.operation_kind,
        uid,
    )
    .await?;
    if !revoked {
        return Err(AppError::NotFound);
    }
    approval::record_audit(
        &state.db,
        AuditEvent {
            event_type: "access_revoked",
            bot_id: Some(bot_id),
            channel_id: q.channel_id,
            actor_id: Some(uid),
            target_user_id: Some(target_user),
            detail: Some(json!({ "operation_kind": q.operation_kind })),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}
