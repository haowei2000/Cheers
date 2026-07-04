//! Periodic reaper for old bot bridge connection-history rows.
//!
//! `bot_connection_events` gets a row per control/data connect/disconnect, so a
//! flapping connector could grow the table without bound. The history exists for
//! recent-uptime inspection, not long-term audit — delete rows past the retention
//! window. Mirrors `enrollment_reaper`.

use std::time::Duration;

use sqlx::PgPool;

async fn reap_once(db: &PgPool, retention_secs: i64) {
    let res = sqlx::query(
        "DELETE FROM bot_connection_events
         WHERE created_at < NOW() - make_interval(secs => $1)",
    )
    .bind(retention_secs as f64)
    .execute(db)
    .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => {
            tracing::info!(deleted = r.rows_affected(), "reaped old bot connection events");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "bot connection event reaper failed"),
    }
}

/// Spawn the periodic reaper. `interval_secs == 0` runs a single startup sweep
/// and stops (mirrors `enrollment_reaper::spawn`).
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
