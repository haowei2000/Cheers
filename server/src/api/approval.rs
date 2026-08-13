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
    // Load each referenced bot's rules + the requester's group memberships once.
    let mut rules_by_bot: HashMap<String, Vec<bot_event_policy::Rule>> = HashMap::new();
    let mut groups_by_bot: HashMap<String, Vec<String>> = HashMap::new();
    for ev in &events {
        if let Some(bid) = ev.get("bot_id").and_then(Value::as_str) {
            if !rules_by_bot.contains_key(bid) {
                let rules = bot_event_policy::load_rules(&state.db, bid)
                    .await
                    .unwrap_or_default();
                let groups = bot_event_policy::matched_groups(&state.db, bid, &uid_s, &rules).await;
                rules_by_bot.insert(bid.to_string(), rules);
                groups_by_bot.insert(bid.to_string(), groups);
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
            let groups = groups_by_bot.get(bid).map(Vec::as_slice).unwrap_or(&[]);
            let class = match ev.get("kind").and_then(Value::as_str) {
                Some("approval") => bot_event_policy::EV_PERMISSION_REQUEST,
                _ => bot_event_policy::EV_TOOL_CALL,
            };
            bot_event_policy::resolve_access(
                rules,
                &chan_s,
                &uid_s,
                &role,
                groups,
                class,
                Capability::See,
            )
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
async fn require_bot_owner(
    state: &AppState,
    bot_id: Uuid,
    uid: Uuid,
    role: &str,
) -> Result<(), AppError> {
    if role == "system_admin" {
        return Ok(());
    }
    match approval::bot_owner(&state.db, bot_id).await? {
        Some(owner) if owner == uid => Ok(()),
        Some(_) => Err(AppError::Forbidden(
            "only the bot owner can manage approvers".into(),
        )),
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
    // Authorization gate: a current channel member (or a platform admin) may proceed
    // to the fine-grained approver/RESPOND check below; additionally the bot OWNER may
    // always resolve their own bot's request even without joining the channel ("the
    // owner may always resolve", see below). A REMOVED member is neither a member nor
    // the owner, so this — together with the delegation/RESPOND purge on member removal
    // (remove_channel_member / leave_channel) — stops a stale grant from letting an
    // ex-member resolve.
    if ensure_member(&state, channel_id, uid, &claims.role)
        .await
        .is_err()
        && approval::bot_owner(&state.db, pending.bot_id).await? != Some(uid)
    {
        return Err(AppError::Forbidden(
            "not authorized to resolve this bot's permission".into(),
        ));
    }

    if pending
        .content_data
        .get("resolved")
        .and_then(Value::as_bool)
        == Some(true)
    {
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
    let may_respond =
        approval::is_approver(&state.db, pending.bot_id, channel_id, uid, op_kind).await? || {
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
        return Err(AppError::Forbidden(
            "not authorized to resolve this bot's permission".into(),
        ));
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
    if !approval::patch_content_data_if_unresolved(&state.db, pending.msg_id, patch.clone()).await?
    {
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
    let trace_status = if kind.starts_with("allow") {
        "approved"
    } else {
        "denied"
    };
    let actor_id = uid.to_string();
    let approval_seers = crate::gateway::ws::agent_bridge::allowed_seers(
        &state,
        pending.bot_id,
        channel_id,
        crate::domain::bot_event_policy::EV_PERMISSION_REQUEST,
    )
    .await;
    if let Err(err) = crate::domain::trace::record(
        &state.db,
        crate::domain::trace::TraceEvent {
            msg_id: resolve_anchor.clone(),
            channel_id: channel_id.to_string(),
            bot_id: Some(pending.bot_id.to_string()),
            kind: "approval",
            phase: "approval".to_string(),
            status: Some(trace_status.to_string()),
            request_id: Some(request_id.clone()),
            approval_kind: Some("resolved".to_string()),
            decision: Some(kind.clone()),
            option_id: Some(option_id.clone()),
            actor_id: Some(actor_id.clone()),
            ..Default::default()
        },
    )
    .await
    {
        tracing::warn!(error = %err, "resolve_permission: trace write failed");
    }

    state
        .fanout
        .broadcast_channel_to_users(
            channel_id,
            crate::gateway::approval_sweeper::approval_trace_wire(
                channel_id,
                &resolve_anchor,
                &request_id,
                trace_status,
                "resolved",
                Some(&kind),
                Some(&option_id),
                Some(&actor_id),
            ),
            approval_seers.clone(),
        )
        .await;

    // Push the decision to the bot's connector (control frame → ACP outcome).
    let resolution = if kind.starts_with("allow") {
        "allow"
    } else {
        "reject"
    };
    let frame = crate::gateway::bridge_frames::permission_resolution_frame(
        &request_id,
        &pending.msg_id.to_string(),
        resolution,
        &option_id,
        &uid.to_string(),
        &now,
    );
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
    state
        .fanout
        .broadcast_channel_to_users(channel_id, wire, approval_seers)
        .await;

    Ok(Json(
        json!({ "ok": true, "delivered": delivered, "decision": kind }),
    ))
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

// ── POST /channels/:cid/auth-required/:request_id/ack ───────────────────────

#[derive(Deserialize)]
pub struct AuthAckRequest {
    /// `"retry"` (I've signed in — re-run authenticate) or `"cancel"`.
    pub action: String,
    /// Agent-advertised method selected in Web. Required for `retry`.
    pub method_id: Option<String>,
}

/// Returns true only for a method persisted from the Agent's initialize response.
fn auth_method_is_advertised(content_data: &Value, selected: &str) -> bool {
    content_data
        .get("methods")
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods
                .iter()
                .any(|method| method.get("method_id").and_then(Value::as_str) == Some(selected))
        })
}

/// Acknowledge an ACP agent re-auth card. Only the bot owner may ack.
pub async fn ack_auth_required(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, request_id)): Path<(Uuid, String)>,
    Json(body): Json<AuthAckRequest>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    let action = body.action.trim().to_ascii_lowercase();
    if action != "retry" && action != "cancel" {
        return Err(AppError::BadRequest(
            "action must be 'retry' or 'cancel'".into(),
        ));
    }
    let pending =
        approval::find_pending_of_type(&state.db, channel_id, &request_id, "auth_required")
            .await?
            .ok_or(AppError::NotFound)?;
    if ensure_member(&state, channel_id, uid, &claims.role)
        .await
        .is_err()
        && approval::bot_owner(&state.db, pending.bot_id).await? != Some(uid)
    {
        return Err(AppError::Forbidden(
            "not authorized to acknowledge this bot's auth request".into(),
        ));
    }
    if approval::bot_owner(&state.db, pending.bot_id).await? != Some(uid) {
        return Err(AppError::Forbidden(
            "only the bot owner can acknowledge agent auth".into(),
        ));
    }
    if pending
        .content_data
        .get("resolved")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(AppError::Conflict("auth request already resolved".into()));
    }
    let method_id = body
        .method_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if action == "retry" {
        let selected = method_id.ok_or_else(|| {
            AppError::BadRequest("method_id is required when retrying agent auth".into())
        })?;
        if !auth_method_is_advertised(&pending.content_data, selected) {
            return Err(AppError::BadRequest(
                "method_id was not advertised by the agent".into(),
            ));
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    let patch = json!({
        "resolved": true,
        "resolved_by": uid.to_string(),
        "resolved_at": now,
        "chosen_action": action,
        "chosen_method_id": method_id,
    });
    if !approval::patch_content_data_if_unresolved(&state.db, pending.msg_id, patch.clone()).await?
    {
        return Err(AppError::Conflict("auth request already resolved".into()));
    }

    let frame = crate::gateway::bridge_frames::auth_acknowledged_frame(
        &request_id,
        &pending.msg_id.to_string(),
        &action,
        method_id.map(str::to_string),
        &uid.to_string(),
        &now,
    );
    let delivered = state.bot_locator.dispatch_task(pending.bot_id, frame).await;

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
            "msg_type": "auth_required",
            "is_partial": false,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
            "content_data": content_data,
        }),
    );
    state.fanout.broadcast_channel(channel_id, wire).await;

    Ok(Json(json!({
        "ok": true,
        "delivered": delivered,
        "action": action,
    })))
}

#[derive(Deserialize)]
pub struct ResolveElicitationRequest {
    /// `accept`, `decline`, or `cancel`.
    pub action: String,
    /// Form values for `accept`; omitted for URL mode and terminal actions.
    pub content: Option<Value>,
}

/// Validates the restricted ACP form schema subset without executing arbitrary JSON Schema.
fn validate_elicitation_content(schema: &Value, content: &Value) -> Result<(), AppError> {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::BadRequest("invalid elicitation form schema".into()))?;
    let values = content
        .as_object()
        .ok_or_else(|| AppError::BadRequest("elicitation content must be an object".into()))?;
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for name in required.iter().filter_map(Value::as_str) {
        if !values.contains_key(name) {
            return Err(AppError::BadRequest(format!(
                "missing required field: {name}"
            )));
        }
    }
    for (name, value) in values {
        let field = properties
            .get(name)
            .ok_or_else(|| AppError::BadRequest(format!("unknown form field: {name}")))?;
        let valid_type = match field.get("type").and_then(Value::as_str) {
            Some("string") => value.is_string(),
            Some("number") => value.is_number(),
            Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
            Some("boolean") => value.is_boolean(),
            Some("array") => value.is_array(),
            _ => false,
        };
        if !valid_type {
            return Err(AppError::BadRequest(format!(
                "invalid value for field: {name}"
            )));
        }
        if let Some(allowed) = field.get("enum").and_then(Value::as_array) {
            if !allowed.contains(value) {
                return Err(AppError::BadRequest(format!(
                    "value not allowed for field: {name}"
                )));
            }
        }
        if let (Some(items), Some(values)) = (
            field
                .get("items")
                .and_then(|item| item.get("enum"))
                .and_then(Value::as_array),
            value.as_array(),
        ) {
            if values.iter().any(|value| !items.contains(value)) {
                return Err(AppError::BadRequest(format!(
                    "value not allowed for field: {name}"
                )));
            }
        }
    }
    Ok(())
}

/// Resolves a pending ACP v1 elicitation as the authenticated channel member.
pub async fn resolve_elicitation(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, request_id)): Path<(Uuid, String)>,
    Json(body): Json<ResolveElicitationRequest>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    ensure_member(&state, channel_id, uid, &claims.role).await?;
    let pending = approval::find_pending_of_type(&state.db, channel_id, &request_id, "elicitation")
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(initiating_user_id) = pending
        .content_data
        .get("initiating_user_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        if initiating_user_id != uid.to_string() {
            return Err(AppError::Forbidden(
                "only the user who initiated this agent request may answer it".into(),
            ));
        }
    }
    let role = channel_role(&state, channel_id, uid).await;
    let may_respond = approval::is_approver(&state.db, pending.bot_id, channel_id, uid, "*")
        .await?
        || crate::domain::acp_policy::allows(
            &state.db,
            &pending.bot_id.to_string(),
            &channel_id.to_string(),
            &uid.to_string(),
            &role,
            "session/request_permission",
            Capability::Respond,
        )
        .await
        .unwrap_or(false);
    if !may_respond {
        return Err(AppError::Forbidden(
            "not authorized to answer this agent interaction".into(),
        ));
    }
    let action = body.action.trim().to_ascii_lowercase();
    if !matches!(action.as_str(), "accept" | "decline" | "cancel") {
        return Err(AppError::BadRequest(
            "action must be accept, decline, or cancel".into(),
        ));
    }
    let mode = pending
        .content_data
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if action == "accept" && mode == "form" && !matches!(body.content, Some(Value::Object(_))) {
        return Err(AppError::BadRequest(
            "accepted form elicitation requires object content".into(),
        ));
    }
    if action == "accept" && mode == "form" {
        let schema = pending
            .content_data
            .get("requested_schema")
            .ok_or_else(|| AppError::BadRequest("missing elicitation form schema".into()))?;
        validate_elicitation_content(
            schema,
            body.content.as_ref().expect("form content checked above"),
        )?;
    }
    if mode == "url" && body.content.is_some() {
        return Err(AppError::BadRequest(
            "URL elicitation does not accept form content".into(),
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let patch = json!({
        "resolved": true,
        "status": action,
        "resolved_by": uid.to_string(),
        "resolved_at": now,
        "content": body.content.clone(),
    });
    if !approval::patch_content_data_if_unresolved(&state.db, pending.msg_id, patch.clone()).await?
    {
        return Err(AppError::Conflict("elicitation already resolved".into()));
    }
    if pending
        .content_data
        .get("interaction_kind")
        .and_then(Value::as_str)
        == Some("mcp_oauth")
    {
        if let Some(installation_id) = pending
            .content_data
            .get("installation_id")
            .and_then(Value::as_str)
        {
            let next_state = if action == "accept" {
                "authorizing"
            } else {
                "unconfigured"
            };
            sqlx::query(
                "UPDATE terminal_installations
                 SET mcp_connection_state = $1, mcp_state_updated_at = NOW()
                 WHERE installation_id = $2 AND revoked_at IS NULL
                   AND mcp_connection_state <> 'connected'",
            )
            .bind(next_state)
            .bind(installation_id)
            .execute(&state.db)
            .await?;
        }
    }
    let frame = crate::gateway::bridge_frames::elicitation_resolution_frame(
        &request_id,
        &pending.msg_id.to_string(),
        &action,
        body.content,
        &uid.to_string(),
        &now,
    );
    let delivered = state.bot_locator.dispatch_task(pending.bot_id, frame).await;
    let mut content_data = pending.content_data.clone();
    if let (Value::Object(target), Value::Object(source)) = (&mut content_data, patch) {
        target.extend(source);
    }
    state.fanout.broadcast_channel(channel_id, WireFrame::channel(channel_id, "message", json!({
        "v": MESSAGE_SCHEMA_VERSION, "msg_id":pending.msg_id, "channel_id":channel_id,
        "channel_seq":pending.channel_seq, "sender_type":"bot", "sender_id":pending.bot_id,
        "content":pending.content, "msg_type":"elicitation", "is_partial":false,
        "reply_to_msg_id":null, "file_ids":[], "mentions":[], "files":[],
        "content_data":content_data,
    }))).await;
    Ok(Json(
        json!({"ok":true, "delivered":delivered, "action":action}),
    ))
}

#[cfg(test)]
mod elicitation_tests {
    use super::*;

    #[test]
    fn auth_method_selection_accepts_only_agent_advertised_ids() {
        let content = json!({
            "methods": [
                {"method_id": "chat-gpt-device-code"},
                {"method_id": "api-key"}
            ]
        });
        assert!(auth_method_is_advertised(&content, "api-key"));
        assert!(!auth_method_is_advertised(&content, "chat-gpt"));
        assert!(!auth_method_is_advertised(&json!({}), "api-key"));
    }

    #[test]
    fn restricted_form_validation_accepts_typed_known_fields() {
        let schema = json!({
            "properties": {
                "name": {"type":"string"},
                "count": {"type":"integer"},
                "targets": {"type":"array", "items":{"enum":["a","b"]}}
            },
            "required": ["name"]
        });
        assert!(validate_elicitation_content(
            &schema,
            &json!({"name":"demo", "count":2, "targets":["a"]})
        )
        .is_ok());
    }

    #[test]
    fn restricted_form_validation_rejects_unknown_and_missing_fields() {
        let schema = json!({
            "properties": {"name": {"type":"string"}},
            "required": ["name"]
        });
        assert!(validate_elicitation_content(&schema, &json!({})).is_err());
        assert!(
            validate_elicitation_content(&schema, &json!({"name":"demo", "secret_extra":"x"}))
                .is_err()
        );
    }
}
