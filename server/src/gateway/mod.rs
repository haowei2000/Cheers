pub mod dispatcher;
pub mod realtime;
// Parked for a future multi-instance / HA deployment (roadmap R1-B / M4).
// Not wired in `main.rs` — single-instance uses InProcessBotLocator (R1-A).
#[allow(dead_code)]
pub mod redis_registry;
pub mod registry;
pub mod stream;
pub mod workspace_rpc;
pub mod ws;
