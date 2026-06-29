//! Periodic reaper for spent/expired bot-onboarding enrollment codes.
//!
//! The per-bot / per-owner caps in `api::enrollment` count only **live** codes
//! (`redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()`), so a redeemed,
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
            tracing::info!(deleted = r.rows_affected(), "reaped spent enrollment codes");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "enrollment code reaper failed"),
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
