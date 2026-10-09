//! ACP per-operation approval: approver resolution + delegation + audit.
//!
//! See docs/arch/ACP_APPROVAL_FLOW.md. The default approver is the bot owner
//! (`bot_accounts.created_by`); the owner may delegate the right to resolve
//! approvals to other channel members (`approval_delegations`) and revoke it at
//! any time. Every approval-related event is appended to `approval_audit` —
//! that audit trail is the core of this feature.

use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

/// Resolve the bot's owner (the implicit, always-valid approver).
pub async fn bot_owner(db: &PgPool, bot_id: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
    let row = sqlx::query!(
        "SELECT created_by FROM bot_accounts WHERE bot_id = $1",
        bot_id.to_string(),
    )
    .fetch_optional(db)
    .await?;
    Ok(row
        .and_then(|r| r.created_by.clone())
        .and_then(|s| s.parse::<Uuid>().ok()))
}

/// True when `user_id` may resolve approvals for `bot_id` in `channel_id` for an
/// operation of `kind`: the bot owner, or an active (un-revoked) delegate scoped
/// to that `kind` or to the `*` catch-all. Pass `"*"` to match any delegation.
pub async fn is_approver(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: Uuid,
    user_id: Uuid,
    kind: &str,
) -> Result<bool, sqlx::Error> {
    if bot_owner(db, bot_id).await? == Some(user_id) {
        return Ok(true);
    }
    let row = sqlx::query!(
        "SELECT EXISTS(
            SELECT 1 AS present FROM approval_delegations
            WHERE bot_id = $1 AND channel_id = $2 AND user_id = $3
              AND (operation_kind = $4 OR operation_kind = '*')
              AND revoked_at IS NULL
        ) AS ok",
        bot_id.to_string(),
        channel_id.to_string(),
        user_id.to_string(),
        kind,
    )
    .fetch_one(db)
    .await?;
    Ok(row.ok.clone().unwrap_or(false))
}

/// Grant (or re-activate) approver rights for one `operation_kind` (`"*"` = any).
/// Idempotent upsert: a revoked row is re-activated by clearing `revoked_at`.
pub async fn grant_approver(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: Uuid,
    target_user: Uuid,
    operation_kind: &str,
    granted_by: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO approval_delegations
            (id, bot_id, channel_id, user_id, operation_kind, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (bot_id, channel_id, user_id, operation_kind)
         DO UPDATE SET revoked_at = NULL, revoked_by = NULL,
                       granted_by = EXCLUDED.granted_by, granted_at = NOW()",
        Uuid::new_v4().to_string(),
        bot_id.to_string(),
        channel_id.to_string(),
        target_user.to_string(),
        operation_kind,
        granted_by.to_string(),
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Revoke approver rights for one `operation_kind` (`"*"` = the catch-all row).
/// Returns true if an active delegation was revoked.
pub async fn revoke_approver(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: Uuid,
    target_user: Uuid,
    operation_kind: &str,
    revoked_by: Uuid,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query!(
        "UPDATE approval_delegations
         SET revoked_at = NOW(), revoked_by = $5
         WHERE bot_id = $1 AND channel_id = $2 AND user_id = $3
           AND operation_kind = $4 AND revoked_at IS NULL",
        bot_id.to_string(),
        channel_id.to_string(),
        target_user.to_string(),
        operation_kind,
        revoked_by.to_string(),
    )
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// List active delegates for a (bot, channel), each with its `operation_kind`.
pub async fn list_approvers(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: Uuid,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query!(
        "SELECT user_id, operation_kind, granted_by, granted_at
         FROM approval_delegations
         WHERE bot_id = $1 AND channel_id = $2 AND revoked_at IS NULL
         ORDER BY granted_at DESC",
        bot_id.to_string(),
        channel_id.to_string(),
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "user_id": r.user_id.clone(),
                "operation_kind": r.operation_kind.clone(),
                "granted_by": r.granted_by.clone(),
                "granted_at": Some(r.granted_at.clone())
                    .map(|t| t.to_rfc3339()).unwrap_or_default(),
            })
        })
        .collect())
}

/// One append-only audit event. Construct with `..Default::default()` and fill
/// only the relevant fields per event type.
#[derive(Default)]
pub struct AuditEvent {
    pub event_type: &'static str,
    pub bot_id: Option<Uuid>,
    pub channel_id: Uuid,
    pub request_id: Option<String>,
    pub msg_id: Option<Uuid>,
    pub actor_id: Option<Uuid>,
    pub target_user_id: Option<Uuid>,
    pub decision: Option<String>,
    pub option_id: Option<String>,
    pub detail: Option<Value>,
}

/// Append an audit event. Best-effort callers should log on error but never let
/// an audit-write failure block the user-visible action.
pub async fn record_audit(db: &PgPool, ev: AuditEvent) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "INSERT INTO approval_audit
            (id, event_type, bot_id, channel_id, request_id, msg_id,
             actor_id, target_user_id, decision, option_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        Uuid::new_v4().to_string(),
        ev.event_type,
        ev.bot_id.map(|v| v.to_string()),
        ev.channel_id.to_string(),
        ev.request_id,
        ev.msg_id.map(|v| v.to_string()),
        ev.actor_id.map(|v| v.to_string()),
        ev.target_user_id.map(|v| v.to_string()),
        ev.decision,
        ev.option_id,
        ev.detail,
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Read the audit log for a channel, newest first.
///
/// A permission's `requested` row (carries the content: title/tool) and its
/// terminal `resolved`/`timeout` row (carries who acted + the decision) are two
/// separate INSERTs sharing one `request_id` — merge them into a single entry
/// here so callers see one complete record ("who approved what") instead of two
/// half-populated rows. `access_requested`/`access_granted`/`access_revoked` are
/// a different fact (approver-rights changes) and stay standalone even if they
/// happen to reference the same `request_id`.
pub async fn list_audit(
    db: &PgPool,
    channel_id: Uuid,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    const MERGEABLE: [&str; 3] = ["requested", "resolved", "timeout"];
    // Over-fetch: a resolved/timed-out request writes two rows that collapse
    // into one below, so ask for headroom to still return `limit` entries.
    let rows = sqlx::query!(
        "SELECT event_type, bot_id, request_id, msg_id, actor_id, target_user_id,
                decision, option_id, detail, created_at
         FROM approval_audit
         WHERE channel_id = $1
         ORDER BY created_at DESC
         LIMIT $2",
        channel_id.to_string(),
        limit.saturating_mul(2),
    )
    .fetch_all(db)
    .await?;

    let mut merged: Vec<Value> = Vec::new();
    let mut index_by_request: HashMap<String, usize> = HashMap::new();

    for r in rows {
        let event_type: String = r.event_type.clone();
        let request_id: Option<String> = r.request_id.clone();
        let bot_id: Option<String> = r.bot_id.clone();
        let detail: Option<Value> = r.detail.clone();

        if MERGEABLE.contains(&event_type.as_str()) {
            if let Some(rid) = &request_id {
                if let Some(&idx) = index_by_request.get(rid) {
                    // Rows arrive newest-first, so a repeat request_id here is the
                    // earlier sibling of the resolved/timeout row we already
                    // recorded. Only `requested` carries the permission content
                    // (title/tool) — a terminal row's own `detail` (e.g. timeout's
                    // `{via}`) is auxiliary, not content, so the `requested` row's
                    // detail always wins once seen. Either way, drop the duplicate.
                    if event_type == "requested" {
                        if let Some(existing) = merged[idx].as_object_mut() {
                            let mut d = detail.unwrap_or(Value::Null);
                            if d.is_object() {
                                crate::domain::tool_request::normalize_audit_detail(&mut d);
                            }
                            existing.insert("detail".into(), d);
                            if existing.get("bot_id").is_none_or(Value::is_null) {
                                existing.insert("bot_id".into(), json!(bot_id));
                            }
                        }
                    }
                    continue;
                }
                index_by_request.insert(rid.clone(), merged.len());
            }
        }

        let mut detail_out = detail.unwrap_or(Value::Null);
        if detail_out.is_object() {
            crate::domain::tool_request::normalize_audit_detail(&mut detail_out);
        }

        merged.push(json!({
            "event_type": event_type,
            "bot_id": bot_id,
            "request_id": request_id,
            "msg_id": r.msg_id.clone(),
            "actor_id": r.actor_id.clone(),
            "target_user_id": r.target_user_id.clone(),
            "decision": r.decision.clone(),
            "option_id": r.option_id.clone(),
            "detail": detail_out,
            "created_at": Some(r.created_at.clone())
                .map(|t| t.to_rfc3339()).unwrap_or_default(),
        }));
    }
    merged.truncate(limit.max(0) as usize);
    Ok(merged)
}

/// A pending ACP permission message, looked up by its ACP `request_id`.
pub struct PendingPermission {
    pub msg_id: Uuid,
    pub channel_id: Uuid,
    pub bot_id: Uuid,
    pub channel_seq: Option<i64>,
    pub content: String,
    pub content_data: Value,
}

fn row_to_pending(r: crate::infra::db::query_rows::PermissionRow) -> Option<PendingPermission> {
    let msg_id = Some(r.msg_id.clone()).and_then(|s| s.parse::<Uuid>().ok())?;
    let channel_id = Some(r.channel_id.clone()).and_then(|s| s.parse::<Uuid>().ok())?;
    let bot_id = Some(r.sender_id.clone()).and_then(|s| s.parse::<Uuid>().ok())?;
    Some(PendingPermission {
        msg_id,
        channel_id,
        bot_id,
        channel_seq: r.channel_seq.clone(),
        content: r.content.clone(),
        content_data: r.content_data.clone().unwrap_or(Value::Null),
    })
}

/// Find the permission message carrying `request_id` in `channel_id`.
pub async fn find_pending(
    db: &PgPool,
    channel_id: Uuid,
    request_id: &str,
) -> Result<Option<PendingPermission>, sqlx::Error> {
    let row = sqlx::query_as!(
        crate::infra::db::query_rows::PermissionRow,
        r###"SELECT msg_id, channel_id, sender_id, channel_seq, content, content_data
         FROM messages
         WHERE channel_id = $1 AND msg_type = 'permission'
           AND content_data->>'request_id' = $2
         LIMIT 1"###,
        channel_id.to_string(),
        request_id,
    )
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(row_to_pending))
}

/// Still-pending permission cards older than `ttl_secs` that no one ever
/// resolved — orphaned when the connector died **before** its own timeout could
/// send `permission_cancel`. The TTL is a server-side backstop *above* the
/// connector's request timeout (the connector's cancel is the primary path; this
/// only catches the dead-connector case). Oldest first; bounded per sweep so one
/// tick can't stall on a huge backlog (the rest drain on the next tick).
pub async fn find_expired_pending(
    db: &PgPool,
    ttl_secs: u64,
) -> Result<Vec<PendingPermission>, sqlx::Error> {
    let rows = sqlx::query_as!(
        crate::infra::db::query_rows::PermissionRow,
        r###"SELECT msg_id, channel_id, sender_id, channel_seq, content, content_data
         FROM messages
         WHERE msg_type = 'permission'
           AND created_at < NOW() - make_interval(secs => $1)
           AND (content_data->>'resolved' IS NULL OR content_data->>'resolved' = 'false')
         ORDER BY created_at ASC
         LIMIT 200"###,
        ttl_secs as f64,
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().filter_map(row_to_pending).collect())
}

/// Find the permission message by `request_id` alone (request_id is a globally
/// unique UUID). Used by the bridge path (timeout/cancel) which has no channel.
pub async fn find_pending_by_request_id(
    db: &PgPool,
    request_id: &str,
) -> Result<Option<PendingPermission>, sqlx::Error> {
    find_pending_by_request_id_of_type(db, request_id, "permission").await
}

/// Same as [`find_pending_by_request_id`] for an arbitrary interactive `msg_type`
/// (e.g. `auth_required`).
pub async fn find_pending_by_request_id_of_type(
    db: &PgPool,
    request_id: &str,
    msg_type: &str,
) -> Result<Option<PendingPermission>, sqlx::Error> {
    let row = sqlx::query_as!(
        crate::infra::db::query_rows::PermissionRow,
        r###"SELECT msg_id, channel_id, sender_id, channel_seq, content, content_data
         FROM messages
         WHERE msg_type = $2 AND content_data->>'request_id' = $1
         LIMIT 1"###,
        request_id,
        msg_type,
    )
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(row_to_pending))
}

/// Find a channel-scoped interactive card (`permission` / `auth_required`).
pub async fn find_pending_of_type(
    db: &PgPool,
    channel_id: Uuid,
    request_id: &str,
    msg_type: &str,
) -> Result<Option<PendingPermission>, sqlx::Error> {
    let row = sqlx::query_as!(
        crate::infra::db::query_rows::PermissionRow,
        r###"SELECT msg_id, channel_id, sender_id, channel_seq, content, content_data
         FROM messages
         WHERE channel_id = $1 AND msg_type = $3
           AND content_data->>'request_id' = $2
         LIMIT 1"###,
        channel_id.to_string(),
        request_id,
        msg_type,
    )
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(row_to_pending))
}

/// Merge `patch` into the permission message's `content_data` (top-level keys).
pub async fn patch_content_data(
    db: &PgPool,
    msg_id: Uuid,
    patch: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "UPDATE messages
         SET content_data = COALESCE(content_data, '{}'::jsonb) || $2::text::jsonb
         WHERE msg_id = $1",
        msg_id.to_string(),
        patch.to_string(),
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Atomic compare-and-set finalize: merge `patch` only if the card is not yet
/// resolved. Returns `true` iff this caller won (row updated). The two finalizers
/// — a human `resolve_permission` (HTTP) and a connector `permission_cancel`
/// (WS, timeout) — race on independent tasks; without this guard both could pass
/// a read-side `resolved` check and write contradictory `content_data` + dual
/// audit/trace rows. The `resolved` flag is the single atomic arbiter.
pub async fn patch_content_data_if_unresolved(
    db: &PgPool,
    msg_id: Uuid,
    patch: Value,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query!(
        "UPDATE messages
         SET content_data = COALESCE(content_data, '{}'::jsonb) || $2::text::jsonb
         WHERE msg_id = $1
           AND (content_data->>'resolved' IS NULL OR content_data->>'resolved' = 'false')",
        msg_id.to_string(),
        patch.to_string(),
    )
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Look up an option's `kind` by its `optionId` within a permission message's
/// `content_data.options`. Returns None when the option_id isn't offered.
pub fn option_kind<'a>(content_data: &'a Value, option_id: &str) -> Option<&'a str> {
    content_data
        .get("options")?
        .as_array()?
        .iter()
        .find(|o| {
            o.get("option_id").and_then(Value::as_str) == Some(option_id)
                || o.get("optionId").and_then(Value::as_str) == Some(option_id)
        })?
        .get("kind")
        .and_then(Value::as_str)
}
