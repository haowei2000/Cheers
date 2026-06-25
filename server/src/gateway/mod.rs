pub mod dispatcher;
pub mod realtime;
pub mod reclaimer;
// Parked for a future multi-instance / HA deployment (roadmap R1-B / M4).
// Not wired in `main.rs` — single-instance uses InProcessBotLocator (R1-A).
#[allow(dead_code)]
pub mod redis_registry;
pub mod registry;
pub mod stream;
pub mod workspace_rpc;
pub mod ws;

/// Log the real cause of an internal failure, return the opaque "db error"
/// string these gateway helpers surface. Same client-visible string as before.
pub(crate) fn log_db_err<E: std::fmt::Display>(
    ctx: &'static str,
) -> impl FnOnce(E) -> &'static str {
    move |e| {
        tracing::error!(error = %e, ctx = ctx, "gateway db error");
        "db error"
    }
}
