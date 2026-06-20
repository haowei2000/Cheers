//! AgentNexus gateway library.
//!
//! Exposes the gateway's modules so both the `server` binary (`src/main.rs`)
//! and the integration tests (`tests/`) link against the same real
//! implementation. The binary is a thin entrypoint over this library.

pub mod api;
pub mod app_state;
pub mod config;
pub mod domain;
pub mod errors;
pub mod gateway;
pub mod infra;
pub mod resource;
pub mod router;

pub use app_state::AppState;
pub use config::Config;
