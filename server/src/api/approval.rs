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

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::approval::{self, AuditEvent},
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
    if !approval::is_approver(&state.db, pending.bot_id, channel_id, uid).await? {
        return Err(AppError::Forbidden("not an approver for this bot".into()));
    }

    let kind = approval::option_kind(&pending.content_data, &body.option_id)
        .ok_or_else(|| AppError::BadRequest("unknown option_id".into()))?
        .to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // Audit BEFORE side effects so the record exists even if a downstream step fails.
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
            option_id: Some(body.option_id.clone()),
            ..Default::default()
        },
    )
    .await?;

    let patch = json!({
        "resolved": true,
        "resolved_by": uid.to_string(),
        "resolved_at": now,
        "chosen_option_id": body.option_id,
        "chosen_kind": kind,
    });
    approval::patch_content_data(&state.db, pending.msg_id, patch.clone()).await?;

    // Push the decision to the bot's connector (control frame → ACP outcome).
    let resolution = if kind.starts_with("allow") { "allow" } else { "reject" };
    let frame = json!({
        "type": "permission_resolution",
        "v": 1,
        "request_id": request_id,
        "message_id": pending.msg_id.to_string(),
        "resolution": resolution,
        "option_id": body.option_id,
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

#[derive(Deserialize)]
pub struct GrantRequest {
    pub channel_id: Uuid,
    pub user_id: Uuid,
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

    approval::grant_approver(&state.db, bot_id, body.channel_id, body.user_id, uid).await?;
    approval::record_audit(
        &state.db,
        AuditEvent {
            event_type: "access_granted",
            bot_id: Some(bot_id),
            channel_id: body.channel_id,
            actor_id: Some(uid),
            target_user_id: Some(body.user_id),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RevokeQuery {
    pub channel_id: Uuid,
}

pub async fn revoke_approver(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((bot_id, target_user)): Path<(Uuid, Uuid)>,
    Query(q): Query<RevokeQuery>,
) -> Result<Json<Value>, AppError> {
    let uid = user_id(&claims)?;
    require_bot_owner(&state, bot_id, uid, &claims.role).await?;

    let revoked = approval::revoke_approver(&state.db, bot_id, q.channel_id, target_user, uid).await?;
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
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}
