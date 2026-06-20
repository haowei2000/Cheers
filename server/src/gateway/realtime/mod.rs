pub mod fanout;
pub mod frame;
pub mod manager;
// Parked for a future multi-instance / HA deployment (roadmap R1-B / M4).
// Not wired in `main.rs` — single-instance uses InProcessFanout (R1-A).
#[allow(dead_code)]
pub mod redis_fanout;
