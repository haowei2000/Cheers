#![allow(dead_code)]

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::bridge::{ConfigStatusRejectedField, ConnectorControlSettings, PermissionOption};

#[derive(Debug, Clone)]
pub struct SessionStartOptions {
    pub cwd: Option<String>,
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
    async fn apply_settings(
        &mut self,
        settings: &ConnectorControlSettings,
    ) -> anyhow::Result<ConfigApplyResult>;
    fn permission_options(&self, params: &Value) -> Vec<PermissionOption>;
}
