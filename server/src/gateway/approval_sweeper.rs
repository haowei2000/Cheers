//! Server-side TTL sweeper for orphaned ACP approval cards.
//!
//! A pending permission card is normally finalized one of two ways: a human
//! resolves it (HTTP), or the connector's own permission timeout fires and sends
//! a `permission_cancel` frame (see `ws::agent_bridge::handle_permission_cancel_frame`).
//! Both are connector-/human-driven. If the **connector process dies before its
//! timeout fires** (crash, network loss), neither path runs and the card hangs
//! pending forever — there is no server-side expiry.
//!
//! This periodic sweep is the backstop: cards older than `ttl_secs` with no
//! resolution are finalized as `expired`. `ttl_secs` is set well above the
//! connector's request timeout so the connector's own cancel stays the primary
//! path; this only catches the dead-connector case.
//!
//! Both the cancel-frame handler and this sweeper finalize through the shared
//! [`finalize_expired`] so they behave identically (atomic CAS finalize + audit
//! + trace + broadcast), and can never write contradictory state for one card.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::domain::approval::{self, PendingPermission};
use crate::domain::trace;
use crate::gateway::realtime::fanout::Fanout;
use crate::gateway::realtime::frame::WireFrame;
use crate::infra::db::models::MESSAGE_SCHEMA_VERSION;

/// Finalize a still-pending approval card as `expired` and broadcast the resolved
/// card. Atomic: returns `false` (no audit/trace/broadcast) if a human resolve
/// already won the CAS, so it never writes contradictory `content_data` or dual
/// audit/trace rows. `reason` is recorded as `resolved_reason` and in the audit
/// `detail.via`, distinguishing a connector timeout from a server-side sweep.
///
/// Shared by the connector timeout/cancel path and the TTL sweeper so both
/// finalizers stay byte-for-byte identical.
pub(crate) async fn finalize_expired(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    pending: &PendingPermission,
    reason: &str,
) -> bool {
    let request_id = pending
        .content_data
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let patch = json!({
        "resolved": true,
        "resolved_kind": "expired",
        "resolved_reason": reason,
        "resolved_at": chrono::Utc::now().to_rfc3339(),
    });
    // Atomic finalize: bail if a human resolve already won (independent task).
    match approval::patch_content_data_if_unresolved(db, pending.msg_id, patch.clone()).await {
        Ok(false) => return false, // already resolved by a human — skip everything
        Ok(true) => {}
        Err(e) => {
            tracing::warn!(error = %e, request_id, "finalize_expired: patch failed");
            return false;
        }
    }

    let _ = approval::record_audit(
        db,
        approval::AuditEvent {
            event_type: "timeout",
            bot_id: Some(pending.bot_id),
            channel_id: pending.channel_id,
            request_id: Some(request_id.clone()),
            msg_id: Some(pending.msg_id),
            detail: Some(json!({ "via": reason })),
            ..Default::default()
        },
    )
    .await;

    // Sibling trace-timeline row for the expiry, anchored to the bot turn.
    let anchor = pending
        .content_data
        .get("source_msg_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| pending.msg_id.to_string());
    let _ = trace::record(
        db,
        trace::TraceEvent {
            msg_id: anchor,
            channel_id: pending.channel_id.to_string(),
            bot_id: Some(pending.bot_id.to_string()),
            kind: "approval",
            phase: "approval".to_string(),
            status: Some("cancelled".to_string()),
            request_id: Some(request_id.clone()),
            approval_kind: Some("expired".to_string()),
            decision: Some("expired".to_string()),
            ..Default::default()
        },
    )
    .await;

    let mut content_data = pending.content_data.clone();
    if let (Value::Object(target), Value::Object(src)) = (&mut content_data, &patch) {
        for (k, v) in src {
            target.insert(k.clone(), v.clone());
        }
    }
    let wire = WireFrame::channel(
        pending.channel_id,
        "message",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": pending.msg_id,
            "channel_id": pending.channel_id,
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
    fanout.broadcast_channel(pending.channel_id, wire).await;
    true
}

/// One sweep: finalize every pending card older than `ttl_secs` as `expired`.
/// Returns how many cards this pass actually finalized (CAS winners).
pub async fn sweep_once(db: &PgPool, fanout: &Arc<dyn Fanout>, ttl_secs: u64) -> usize {
    let expired = match approval::find_expired_pending(db, ttl_secs).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, ctx = "approval sweeper: select expired", "sweeper db error");
            return 0;
        }
    };
    let batch = expired.len();
    let mut swept = 0usize;
    for pending in &expired {
        if finalize_expired(db, fanout, pending, "server_ttl_expired").await {
            swept += 1;
        }
    }
    if swept > 0 {
        tracing::info!(
            count = swept,
            ttl_secs,
            "approval sweeper: finalized orphaned permission cards as expired"
        );
    }
    // The query is bounded (LIMIT 200); a full batch means more may remain — the
    // next tick drains them. Surface it so it doesn't read as "fully swept".
    if batch >= 200 {
        tracing::warn!(
            batch,
            "approval sweeper: hit batch cap; remaining cards sweep next tick"
        );
    }
    swept
}

/// Start the background sweeper: one sweep at startup (clears cards orphaned
/// while the process was down), then every `interval_secs`. `interval_secs == 0`
/// runs only the startup sweep.
pub fn spawn(db: PgPool, fanout: Arc<dyn Fanout>, interval_secs: u64, ttl_secs: u64) {
    tokio::spawn(async move {
        sweep_once(&db, &fanout, ttl_secs).await;

        if interval_secs == 0 {
            return;
        }

        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs));
        tick.tick().await; // first tick is immediate — skip (startup sweep done).
        loop {
            tick.tick().await;
            sweep_once(&db, &fanout, ttl_secs).await;
        }
    });
}
