//! Transport-neutral ACP runtime contracts.
//!
//! [`RuntimeAdapter`] owns agent lifecycle, sessions, authentication, and
//! configuration. [`PromptClient`] is a separately cloneable handle so long
//! prompts can run concurrently without holding the adapter lifecycle lock.

#![allow(dead_code)]

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::oneshot;

use crate::bridge::{ConfigStatusRejectedField, ConnectorControlSettings, PermissionOption};

#[derive(Debug, Clone, PartialEq, Eq)]
/// Trusted Cheers context attached to one client→agent JSON-RPC request.
pub struct RequestRoute {
    /// Channel in which the originating operation was initiated.
    pub channel_id: String,
    /// Connector task that owns the operation.
    pub task_id: String,
    /// Placeholder/source message used to anchor the interaction card.
    pub msg_id: String,
    /// Original human message whose persisted sender proves the initiating identity.
    pub origin_msg_id: Option<String>,
    /// Optional persisted Cheers session identifier.
    pub session_id: Option<String>,
    /// Verified human who initiated the operation; absent for bot/system work.
    pub initiating_user_id: Option<String>,
}

#[derive(Debug, Clone)]
/// Inputs shared by `session/new` and `session/load`.
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
    /// Opaque ACP MCP server definitions to preserve vendor extension fields.
    pub mcp_servers: Value,
    /// Route registered against the actual ACP JSON-RPC request ID while the
    /// session setup request is outstanding.
    pub request_route: Option<RequestRoute>,
}

#[derive(Debug, Clone)]
/// Result of creating an ACP session.
pub struct SessionStartResult {
    /// Agent-issued ACP session identifier.
    pub session_id: String,
    /// Complete response payload, including agent extension metadata.
    pub metadata: Value,
}

#[derive(Debug, Clone)]
/// Result of loading an existing ACP session.
pub struct SessionLoadResult {
    /// Complete response payload, including agent extension metadata.
    pub metadata: Value,
}

#[derive(Debug, Clone)]
/// Terminal result of one ACP prompt turn.
pub struct PromptResult {
    /// Agent-provided ACP stop reason, when one was returned.
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
/// Immutable capability snapshot derived from the initialize response.
pub struct AgentCapabilities {
    /// Whether the agent supports `session/load`.
    pub load_session: bool,
    /// Whether image content blocks may be included in prompts.
    pub prompt_image: bool,
    /// Whether audio content blocks may be included in prompts.
    pub prompt_audio: bool,
    /// Whether the agent accepts HTTP MCP server definitions.
    pub mcp_http: bool,
    /// Whether the agent accepts legacy SSE MCP server definitions.
    pub mcp_sse: bool,
}

impl AgentCapabilities {
    /// Extracts known capabilities, treating absent or malformed flags as disabled.
    pub fn from_initialize(initialize: Option<&Value>) -> Self {
        let caps = initialize.and_then(|value| value.get("agentCapabilities"));
        let enabled = |path: &[&str]| {
            caps.and_then(|root| path.iter().try_fold(root, |value, key| value.get(*key)))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        Self {
            load_session: enabled(&["loadSession"]),
            prompt_image: enabled(&["promptCapabilities", "image"]),
            prompt_audio: enabled(&["promptCapabilities", "audio"]),
            mcp_http: enabled(&["mcpCapabilities", "http"]),
            mcp_sse: enabled(&["mcpCapabilities", "sse"]),
        }
    }
}

#[derive(Debug, Clone)]
/// Outcome of applying gateway-controlled settings to a runtime.
pub struct ConfigApplyResult {
    /// Setting names accepted by the local policy and runtime.
    pub applied: Vec<String>,
    /// Setting names rejected with operator-facing reasons.
    pub rejected: Vec<ConfigStatusRejectedField>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Locally resolved answer to an ACP permission request.
pub enum PermissionOutcome {
    /// Select the agent-advertised permission option with this identifier.
    Selected { option_id: String },
    /// Cancel the permission request without selecting an option.
    Cancelled,
}

// The ACP wire form of a permission outcome is produced in `acp_adapter` from
// the official `RequestPermissionResponse`/`RequestPermissionOutcome` types
// (`write_permission_response`), so this enum no longer hand-serializes itself.

#[derive(Debug)]
/// Events emitted by a runtime toward the Bridge orchestration layer.
pub enum RuntimeEvent {
    /// Opaque ACP session update associated with an agent session.
    SessionUpdate {
        /// Agent-issued ACP session identifier used for routing.
        acp_session_id: String,
        /// Unmodified update payload, including unknown variants and `_meta`.
        update: Value,
    },
    /// Permission request that requires a local or gateway decision.
    PermissionRequest {
        /// Agent-issued ACP session identifier used for routing.
        acp_session_id: String,
        /// Unmodified ACP permission request parameters.
        params: Value,
        /// One-shot channel used to return the resolved permission outcome.
        respond_to: oneshot::Sender<PermissionOutcome>,
    },
    /// ACP v1 form or URL elicitation requiring an authenticated user response.
    ElicitationRequest {
        /// Session used for ordinary session-scoped routing, when present.
        acp_session_id: Option<String>,
        /// Trusted route matched from a request-scoped `requestId`, when present.
        request_route: Option<RequestRoute>,
        /// Unmodified `elicitation/create` parameters, including `_meta`.
        params: Value,
        /// One-shot channel carrying the ACP response object.
        respond_to: oneshot::Sender<Value>,
    },
    /// Signals that an accepted URL elicitation completed externally.
    ElicitationComplete {
        /// Opaque ACP elicitation identifier.
        elicitation_id: String,
    },
    /// Fatal or asynchronous runtime error for operator-visible reporting.
    AdapterError {
        /// Human-readable error description.
        message: String,
    },
    /// Injected into the adapter event channel by run_task immediately after
    /// load_session() returns. The forwarding task forwards it to runtime_tx
    /// strictly after all preceding history-replay notifications, so run_loop
    /// sees the fence only after every history chunk has been discarded.
    LoadSessionFence {
        /// Session whose replay stream is now fully drained.
        acp_session_id: String,
    },
}

#[async_trait]
/// Cloneable, concurrency-safe issuer for long-running ACP prompt turns.
pub trait PromptClient: Send + Sync {
    /// Sends one prompt without holding the lifecycle adapter lock.
    async fn prompt(
        &self,
        session_id: &str,
        prompt: Vec<Value>,
        timeout_ms: u64,
    ) -> anyhow::Result<PromptResult>;
}

#[async_trait]
/// Transport-neutral lifecycle and session API implemented by ACP runtimes.
pub trait RuntimeAdapter: Send {
    /// Starts the agent process and performs ACP initialization.
    async fn start(&mut self) -> anyhow::Result<Value>;
    /// Stops the runtime and its supervised agent process.
    async fn stop(&mut self) -> anyhow::Result<()>;
    /// Restarts the runtime and returns the new initialize response.
    async fn restart(&mut self) -> anyhow::Result<Value>;
    /// Re-run ACP `authenticate` using the preferred method advertised at initialize.
    /// Agent-to-client elicitation emitted while the request is active is routed
    /// through the supplied trusted request route.
    /// Rejects a method that was not advertised by the Agent.
    async fn authenticate(
        &mut self,
        method_id: &str,
        request_route: Option<RequestRoute>,
    ) -> anyhow::Result<()>;
    /// Creates a new ACP session with the supplied workspace and MCP context.
    async fn new_session(
        &mut self,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionStartResult>;
    /// Loads a previously persisted ACP session.
    async fn load_session(
        &mut self,
        session_id: &str,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionLoadResult>;
    /// Cancels the active operation for a session.
    async fn cancel(&mut self, session_id: &str) -> anyhow::Result<()>;
    /// Applies one agent-advertised session configuration option.
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
    /// Applies policy-clamped gateway settings and performs required restarts.
    async fn apply_settings(
        &mut self,
        settings: &ConnectorControlSettings,
    ) -> anyhow::Result<ConfigApplyResult>;
    /// Extracts agent-advertised permission choices without transport knowledge.
    fn permission_options(&self, params: &Value) -> Vec<PermissionOption>;
    /// Returns a cloneable issuer for concurrent prompt turns.
    fn prompt_client(&self) -> Arc<dyn PromptClient>;
    /// Returns the immutable capability snapshot from initialization.
    fn capabilities(&self) -> AgentCapabilities;
    /// Returns the raw initialize response for auth and diagnostics.
    fn initialize_response(&self) -> Option<Value>;
    /// Enqueues a marker behind all preceding replay updates for this session.
    async fn inject_fence(&self, acp_session_id: String);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn capabilities_are_an_immutable_snapshot_of_initialize() {
        let initialize = json!({
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": {"image": true, "audio": false},
                "mcpCapabilities": {"http": true, "sse": false}
            }
        });
        assert_eq!(
            AgentCapabilities::from_initialize(Some(&initialize)),
            AgentCapabilities {
                load_session: true,
                prompt_image: true,
                prompt_audio: false,
                mcp_http: true,
                mcp_sse: false,
            }
        );
        assert_eq!(
            AgentCapabilities::from_initialize(None),
            AgentCapabilities::default()
        );
    }
}
