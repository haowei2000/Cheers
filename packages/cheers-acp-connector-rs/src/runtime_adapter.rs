#![allow(dead_code)]

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::bridge::{ConfigStatusRejectedField, ConnectorControlSettings, PermissionOption};

#[derive(Debug, Clone)]
pub struct SessionStartOptions {
    /// The session's primary working directory. Absolute, immutable for the
    /// session's lifetime, and resupplied identically on `session/load`
    /// (ACP: session-setup#working-directory).
    pub cwd: Option<String>,
    /// Extra roots the session may access beyond `cwd`. Together with `cwd` they
    /// form the effective root set `[cwd, ...additional_dirs]`. Resent in full on
    /// every load (no implicit restoration); may vary across loads while `cwd`
    /// stays fixed.
    pub additional_dirs: Vec<String>,
    pub mcp_servers: Value,
}

#[derive(Debug, Clone)]
pub struct SessionStartResult {
    pub session_id: String,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct SessionLoadResult {
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct PromptResult {
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConfigApplyResult {
    pub applied: Vec<String>,
    pub rejected: Vec<ConfigStatusRejectedField>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionOutcome {
    Selected { option_id: String },
    Cancelled,
}

// The ACP wire form of a permission outcome is produced in `acp_adapter` from
// the official `RequestPermissionResponse`/`RequestPermissionOutcome` types
// (`write_permission_response`), so this enum no longer hand-serializes itself.

#[derive(Debug)]
pub enum RuntimeEvent {
    SessionUpdate {
        acp_session_id: String,
        update: Value,
    },
    PermissionRequest {
        acp_session_id: String,
        params: Value,
        respond_to: oneshot::Sender<PermissionOutcome>,
    },
    AdapterError {
        message: String,
    },
    /// Injected into the adapter event channel by run_task immediately after
    /// load_session() returns. The forwarding task forwards it to runtime_tx
    /// strictly after all preceding history-replay notifications, so run_loop
    /// sees the fence only after every history chunk has been discarded.
    LoadSessionFence {
        acp_session_id: String,
    },
}

#[async_trait]
pub trait RuntimeAdapter: Send {
    async fn start(&mut self) -> anyhow::Result<Value>;
    async fn stop(&mut self) -> anyhow::Result<()>;
    async fn restart(&mut self) -> anyhow::Result<Value>;
    /// Re-run ACP `authenticate` using the method advertised at initialize.
    /// No-op when the agent advertised no authMethods.
    async fn authenticate(&mut self) -> anyhow::Result<()>;
    async fn new_session(
        &mut self,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionStartResult>;
    async fn load_session(
        &mut self,
        session_id: &str,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionLoadResult>;
    async fn prompt(
        &mut self,
        session_id: &str,
        prompt: Vec<Value>,
        timeout_ms: u64,
    ) -> anyhow::Result<PromptResult>;
    async fn cancel(&mut self, session_id: &str) -> anyhow::Result<()>;
    async fn set_config_option(
        &mut self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> anyhow::Result<Value>;
    /// Set the session mode via ACP `session/set_mode` (session-targeted).
    async fn set_mode(&mut self, session_id: &str, mode: &str) -> anyhow::Result<()>;
    /// Select the session model via the ACP native model-state API
    /// (`session/set_model`). Fallback for agents (e.g. older codex-acp) that
    /// expose models only through `models`/`session/set_model` rather than a
    /// `configOptions` entry with id "model".
    async fn set_model(&mut self, session_id: &str, model_id: &str) -> anyhow::Result<()>;
    async fn apply_settings(
        &mut self,
        settings: &ConnectorControlSettings,
    ) -> anyhow::Result<ConfigApplyResult>;
    fn permission_options(&self, params: &Value) -> Vec<PermissionOption>;
}
