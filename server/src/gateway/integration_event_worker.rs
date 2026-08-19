//! Polling worker that turns stored webhook events into channel messages.
//!
//! Split from ingress on purpose: `api::integrations::receive` answers `202` as
//! soon as the event is verified and stored, because a provider that waits on
//! our fan-out would time out and start redelivering. The mapping work happens
//! here instead.

use crate::{app_state::AppState, domain::integrations::delivery};

/// Fast enough that a push shows up while the pusher is still looking at the
/// channel, slow enough to be a cheap indexed query against an empty queue.
const TICK_SECONDS: u64 = 5;

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(TICK_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tracing::info!("integration event worker started ({TICK_SECONDS}s cadence)");
        loop {
            ticker.tick().await;
            match delivery::drain_once(&state).await {
                Ok(report) if report == delivery::DrainReport::default() => {}
                Ok(report) => tracing::info!(
                    posted = report.posted,
                    already_delivered = report.already_delivered,
                    ignored = report.ignored,
                    unbound = report.unbound,
                    failed = report.failed,
                    "integration events drained"
                ),
                Err(error) => tracing::warn!(%error, "integration event drain failed"),
            }
        }
    });
}
