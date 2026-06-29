//! ACP per-operation approval: approver resolution + delegation + audit.
//!
//! See docs/arch/ACP_APPROVAL_FLOW.md. The default approver is the bot owner
//! (`bot_accounts.created_by`); the owner may delegate the right to resolve
//! approvals to other channel members (`approval_delegations`) and revoke it at
//! any time. Every approval-related event is appended to `approval_audit` —
//! that audit trail is the core of this feature.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Resolve the bot's owner (the implicit, always-valid approver).
pub async fn bot_owner(db: &PgPool, bot_id: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
    let row = sqlx::query("SELECT created_by FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id.to_string())
        .fetch_optional(db)
        .await?;
    Ok(row
        .and_then(|r| r.try_get::<Option<String>, _>("created_by").ok().flatten())
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
    let row = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM approval_delegations
            WHERE bot_id = $1 AND channel_id = $2 AND user_id = $3
              AND (operation_kind = $4 OR operation_kind = '*')
              AND revoked_at IS NULL
        ) AS ok",
    )
    .bind(bot_id.to_string())
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .bind(kind)
    .fetch_one(db)
    .await?;
    Ok(row.try_get::<bool, _>("ok").unwrap_or(false))
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
    sqlx::query(
        "INSERT INTO approval_delegations
            (id, bot_id, channel_id, user_id, operation_kind, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (bot_id, channel_id, user_id, operation_kind)
         DO UPDATE SET revoked_at = NULL, revoked_by = NULL,
                       granted_by = EXCLUDED.granted_by, granted_at = NOW()",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(bot_id.to_string())
    .bind(channel_id.to_string())
    .bind(target_user.to_string())
    .bind(operation_kind)
    .bind(granted_by.to_string())
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
    let res = sqlx::query(
        "UPDATE approval_delegations
         SET revoked_at = NOW(), revoked_by = $5
         WHERE bot_id = $1 AND channel_id = $2 AND user_id = $3
           AND operation_kind = $4 AND revoked_at IS NULL",
    )
    .bind(bot_id.to_string())
    .bind(channel_id.to_string())
    .bind(target_user.to_string())
    .bind(operation_kind)
    .bind(revoked_by.to_string())
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
    let rows = sqlx::query(
        "SELECT user_id, operation_kind, granted_by, granted_at
         FROM approval_delegations
         WHERE bot_id = $1 AND channel_id = $2 AND revoked_at IS NULL
         ORDER BY granted_at DESC",
    )
    .bind(bot_id.to_string())
    .bind(channel_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "user_id": r.try_get::<String, _>("user_id").unwrap_or_default(),
                "operation_kind": r.try_get::<String, _>("operation_kind")
                    .unwrap_or_else(|_| "*".into()),
                "granted_by": r.try_get::<String, _>("granted_by").unwrap_or_default(),
                "granted_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("granted_at")
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
    sqlx::query(
        "INSERT INTO approval_audit
            (id, event_type, bot_id, channel_id, request_id, msg_id,
             actor_id, target_user_id, decision, option_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(ev.event_type)
    .bind(ev.bot_id.map(|v| v.to_string()))
    .bind(ev.channel_id.to_string())
    .bind(ev.request_id)
    .bind(ev.msg_id.map(|v| v.to_string()))
    .bind(ev.actor_id.map(|v| v.to_string()))
    .bind(ev.target_user_id.map(|v| v.to_string()))
    .bind(ev.decision)
    .bind(ev.option_id)
    .bind(ev.detail)
    .execute(db)
    .await?;
    Ok(())
}

/// Read the audit log for a channel, newest first.
pub async fn list_audit(
    db: &PgPool,
    channel_id: Uuid,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT event_type, bot_id, request_id, msg_id, actor_id, target_user_id,
                decision, option_id, detail, created_at
         FROM approval_audit
         WHERE channel_id = $1
         ORDER BY created_at DESC
         LIMIT $2",
    )
    .bind(channel_id.to_string())
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "event_type": r.try_get::<String, _>("event_type").unwrap_or_default(),
                "bot_id": r.try_get::<Option<String>, _>("bot_id").ok().flatten(),
                "request_id": r.try_get::<Option<String>, _>("request_id").ok().flatten(),
                "msg_id": r.try_get::<Option<String>, _>("msg_id").ok().flatten(),
                "actor_id": r.try_get::<Option<String>, _>("actor_id").ok().flatten(),
                "target_user_id": r.try_get::<Option<String>, _>("target_user_id").ok().flatten(),
                "decision": r.try_get::<Option<String>, _>("decision").ok().flatten(),
                "option_id": r.try_get::<Option<String>, _>("option_id").ok().flatten(),
                "detail": r.try_get::<Option<Value>, _>("detail").ok().flatten(),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                    .map(|t| t.to_rfc3339()).unwrap_or_default(),
            })
        })
        .collect())
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

fn row_to_pending(r: sqlx::postgres::PgRow) -> Option<PendingPermission> {
    let msg_id = r
        .try_get::<String, _>("msg_id")
        .ok()
        .and_then(|s| s.parse::<Uuid>().ok())?;
    let channel_id = r
        .try_get::<String, _>("channel_id")
        .ok()
        .and_then(|s| s.parse::<Uuid>().ok())?;
    let bot_id = r
        .try_get::<String, _>("sender_id")
        .ok()
        .and_then(|s| s.parse::<Uuid>().ok())?;
    Some(PendingPermission {
        msg_id,
        channel_id,
        bot_id,
        channel_seq: r.try_get::<Option<i64>, _>("channel_seq").ok().flatten(),
        content: r.try_get::<String, _>("content").unwrap_or_default(),
        content_data: r
            .try_get::<Option<Value>, _>("content_data")
            .ok()
            .flatten()
            .unwrap_or(Value::Null),
    })
}

/// Find the permission message carrying `request_id` in `channel_id`.
pub async fn find_pending(
    db: &PgPool,
    channel_id: Uuid,
    request_id: &str,
) -> Result<Option<PendingPermission>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT msg_id, channel_id, sender_id, channel_seq, content, content_data
         FROM messages
         WHERE channel_id = $1 AND msg_type = 'permission'
           AND content_data->>'request_id' = $2
         LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(request_id)
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
    let rows = sqlx::query(
        "SELECT msg_id, channel_id, sender_id, channel_seq, content, content_data
         FROM messages
         WHERE msg_type = 'permission'
           AND created_at < NOW() - make_interval(secs => $1)
           AND (content_data->>'resolved' IS NULL OR content_data->>'resolved' = 'false')
         ORDER BY created_at ASC
         LIMIT 200",
    )
    .bind(ttl_secs as f64)
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
    let row = sqlx::query(
        "SELECT msg_id, channel_id, sender_id, channel_seq, content, content_data
         FROM messages
         WHERE msg_type = 'permission' AND content_data->>'request_id' = $1
         LIMIT 1",
    )
    .bind(request_id)
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
    sqlx::query(
        "UPDATE messages
         SET content_data = COALESCE(content_data, '{}'::jsonb) || $2::jsonb
         WHERE msg_id = $1",
    )
    .bind(msg_id.to_string())
    .bind(patch.to_string())
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
    let res = sqlx::query(
        "UPDATE messages
         SET content_data = COALESCE(content_data, '{}'::jsonb) || $2::jsonb
         WHERE msg_id = $1
           AND (content_data->>'resolved' IS NULL OR content_data->>'resolved' = 'false')",
    )
    .bind(msg_id.to_string())
    .bind(patch.to_string())
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
