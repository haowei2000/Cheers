//! Periodic reaper for spent/expired installation pairing codes.
//!
//! The per-bot / per-owner caps in `api::pairing` count only **live** codes
//! (`redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()`), so a paired,
//! revoked, or expired row stops counting but is otherwise never deleted — the
//! table would grow without bound under repeated mint→redeem cycles. This sweep
//! is the backstop, mirroring `approval_sweeper`: it periodically deletes codes
//! that are terminal and older than a short retention window (kept briefly so a
//! just-redeemed code's audit trail is still inspectable).
//!
//! Codes are also CASCADE-deleted when their bot is removed (migration 0024);
//! this handles the far more common case of dead codes for still-existing bots.

use std::time::Duration;

use sqlx::PgPool;

/// Delete terminal codes older than `retention_secs`. A code is terminal once it
/// is redeemed, revoked, or past its TTL; the retention grace keeps a
/// just-finished code around briefly for inspection before it is reaped.
async fn reap_once(db: &PgPool, retention_secs: i64) {
    // Pending installations contain no credential and are useful only while
    // their bound pairing code is live. Delete them first; the FK cascades the matching
    // code and prevents abandoned device rows from accumulating.
    let pending = sqlx::query(
        "DELETE FROM terminal_installations i
         USING enrollment_codes e
         WHERE e.installation_id = i.installation_id
           AND i.status = 'pending'
           AND (e.redeemed_at IS NOT NULL OR e.revoked OR e.expires_at < NOW())
           AND e.created_at < NOW() - make_interval(secs => $1)",
    )
    .bind(retention_secs as f64)
    .execute(db)
    .await;
    if let Err(e) = pending {
        tracing::warn!(error = %e, "pending installation reaper failed");
        return;
    }
    let res = sqlx::query(
        "DELETE FROM enrollment_codes
         WHERE (redeemed_at IS NOT NULL OR revoked OR expires_at < NOW())
           AND created_at < NOW() - make_interval(secs => $1)",
    )
    .bind(retention_secs as f64)
    .execute(db)
    .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => {
            tracing::info!(deleted = r.rows_affected(), "reaped spent pairing codes");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "pairing code reaper failed"),
    }
}

/// Spawn the periodic reaper. `interval_secs == 0` runs a single startup sweep
/// and stops (mirrors `approval_sweeper::spawn`).
pub fn spawn(db: PgPool, interval_secs: u64, retention_secs: i64) {
    tokio::spawn(async move {
        reap_once(&db, retention_secs).await;

        if interval_secs == 0 {
            return;
        }

        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs));
        tick.tick().await; // first tick is immediate — skip (startup sweep done).
        loop {
            tick.tick().await;
            reap_once(&db, retention_secs).await;
        }
    });
}
