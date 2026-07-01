//! Tier B (in progress): a `RuntimeAdapter` backed by the official
//! `agent-client-protocol` runtime crate instead of the hand-rolled JSON-RPC
//! transport in [`crate::acp_adapter`].
//!
//! Design (see docs/arch/ACP_RUST_SDK_ADOPTION.md §3): a long-lived **actor**
//! task runs `Client.builder()…connect_with(transport, |cx| command_loop)`. The
//! `RuntimeAdapter` surface (Value in / Value out) is unchanged — methods send
//! `Command`s to the actor and await replies. Inbound `session/update` and
//! `session/request_permission` are relayed to the backend **raw** via the
//! `UntypedMessage` hooks (zero-loss opaque relay); every other agent→client
//! method is declined (`Handled::No`) so the runtime answers it with `-32601`,
//! preserving the connector's headless-relay posture.
//!
//! Selected at startup by [`AcpAdapterKind`] when `CHEERS_ACP_RUNTIME=1`; the
//! default stays the hand-rolled transport until the runtime path reaches parity.
#![allow(dead_code)]

use std::process::Stdio;
use std::time::Duration;

use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, Handled, Responder, UntypedMessage,
};
use agent_client_protocol_schema::v1::{
    RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome,
};
use anyhow::{anyhow, Context};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::acp_adapter::{default_client_capabilities, ACP_PROTOCOL_VERSION};
use crate::bridge::{ConfigStatusRejectedField, ConnectorControlSettings, PermissionOption};
use crate::config::StdioAgentConfig;
use crate::runtime_adapter::{
    ConfigApplyResult, PermissionOutcome, PromptResult, RuntimeAdapter, RuntimeEvent,
    SessionLoadResult, SessionStartOptions, SessionStartResult,
};

/// A unit of work sent from the adapter handle to the connection actor.
enum Command {
    Request {
        method: String,
        params: Value,
        timeout_ms: u64,
        reply: oneshot::Sender<anyhow::Result<Value>>,
    },
    Notify {
        method: String,
        params: Value,
    },
}

/// `RuntimeAdapter` whose transport is the official runtime crate. A clone-free
/// handle that forwards method calls to the actor over `cmd_tx`.
pub struct RuntimeAcpAdapter {
    account_id: String,
    config: StdioAgentConfig,
    event_tx: mpsc::Sender<RuntimeEvent>,
    cmd_tx: Option<mpsc::Sender<Command>>,
    actor: Option<JoinHandle<anyhow::Result<()>>>,
    initialize_response: Option<Value>,
}

impl RuntimeAcpAdapter {
    pub fn new(
        account_id: impl Into<String>,
        config: StdioAgentConfig,
        event_tx: mpsc::Sender<RuntimeEvent>,
    ) -> Self {
        Self {
            account_id: account_id.into(),
            config,
            event_tx,
            cmd_tx: None,
            actor: None,
            initialize_response: None,
        }
    }

    pub fn initialize_response(&self) -> Option<&Value> {
        self.initialize_response.as_ref()
    }

    fn request_timeout_ms(&self) -> u64 {
        self.config.request_timeout_ms
    }

    async fn request(&self, method: &str, params: Value, timeout_ms: u64) -> anyhow::Result<Value> {
        let cmd_tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| anyhow!("ACP runtime adapter is not started (method={method})"))?;
        request_via(cmd_tx, method, params, timeout_ms).await
    }

    async fn notify(&self, method: &str, params: Value) -> anyhow::Result<()> {
        let cmd_tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| anyhow!("ACP runtime adapter is not started (method={method})"))?;
        cmd_tx
            .send(Command::Notify {
                method: method.to_string(),
                params,
            })
            .await
            .map_err(|_| anyhow!("ACP runtime actor is gone (method={method})"))
    }

    /// Pushes the configured permission mode to the agent via `session/set_mode`
    /// (best-effort), mirroring the hand-rolled adapter. Without this the agent
    /// keeps its native policy — e.g. codex self-approves and never sends
    /// `session/request_permission`, so no approval card is ever produced.
    async fn apply_permission_mode(&self, session_id: &str) {
        let Some(mode) = self.config.agent_native_permission_mode.clone() else {
            return;
        };
        if mode.trim().is_empty() {
            return;
        }
        match self
            .request(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode }),
                self.request_timeout_ms(),
            )
            .await
        {
            Ok(_) => tracing::info!(
                account = %self.account_id,
                session = %session_id,
                mode = %mode,
                "applied ACP session mode (runtime)"
            ),
            Err(err) => tracing::warn!(
                account = %self.account_id,
                mode = %mode,
                "session/set_mode failed (runtime: unknown modeId or agent rejected?): {err}"
            ),
        }
    }

    /// Pushes the backend-desired ACP config options to the agent via
    /// `session/set_config_option` (best-effort), one id at a time — the
    /// `set_config_option` analogue of [`apply_permission_mode`]. Values are
    /// opaque strings (ACP-generic); the map was already clamped to
    /// `allowed_config_options` at the `config_update` boundary.
    async fn apply_config_options(&self, session_id: &str) {
        let Some(map) = self.config.config_options.as_ref().and_then(|v| v.as_object()) else {
            return;
        };
        for (config_id, value) in map {
            let Some(value) = value.as_str() else { continue };
            match self
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                    self.request_timeout_ms(),
                )
                .await
            {
                Ok(_) => tracing::info!(
                    account = %self.account_id,
                    session = %session_id,
                    config_id = %config_id,
                    value = %value,
                    "applied ACP config option (runtime)"
                ),
                Err(err) => tracing::warn!(
                    account = %self.account_id,
                    config_id = %config_id,
                    "session/set_config_option failed (runtime: unknown id/value or agent rejected?): {err}"
                ),
            }
        }
    }

    // --- Concrete API `bridge_runtime::run` needs beyond the RuntimeAdapter
    // trait (mirrors `AcpAdapter`), so the runtime adapter is a structural
    // drop-in behind `AcpAdapterKind`. ---

    /// A cheap, clone-able issuer for the lock-free concurrent-prompt path
    /// (the runtime-backed equivalent of `AcpAdapter::requester`).
    pub fn requester(&self) -> RuntimeRequester {
        RuntimeRequester {
            cmd_tx: self.cmd_tx.clone(),
        }
    }

    /// Injects a `LoadSessionFence` into the same FIFO as history-replay
    /// `session/update`s, so it arrives only after every preceding update.
    pub async fn inject_fence(&self, acp_session_id: impl Into<String>) {
        let _ = self
            .event_tx
            .send(RuntimeEvent::LoadSessionFence {
                acp_session_id: acp_session_id.into(),
            })
            .await;
    }

    fn agent_capabilities(&self) -> Option<&Value> {
        self.initialize_response
            .as_ref()
            .and_then(|value| value.get("agentCapabilities"))
    }

    pub fn supports_load_session(&self) -> bool {
        self.agent_capability_bool(&["loadSession"])
    }

    pub fn supports_prompt_image(&self) -> bool {
        self.agent_capability_bool(&["promptCapabilities", "image"])
    }

    pub fn supports_mcp_http(&self) -> bool {
        self.agent_capability_bool(&["mcpCapabilities", "http"])
    }

    pub fn supports_mcp_sse(&self) -> bool {
        self.agent_capability_bool(&["mcpCapabilities", "sse"])
    }

    fn agent_capability_bool(&self, path: &[&str]) -> bool {
        let mut node = match self.agent_capabilities() {
            Some(node) => node,
            None => return false,
        };
        for key in path {
            node = match node.get(key) {
                Some(child) => child,
                None => return false,
            };
        }
        node.as_bool().unwrap_or(false)
    }
}

#[async_trait]
impl RuntimeAdapter for RuntimeAcpAdapter {
    async fn start(&mut self) -> anyhow::Result<Value> {
        if self.cmd_tx.is_some() {
            if let Some(resp) = &self.initialize_response {
                return Ok(resp.clone());
            }
        }
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let actor = tokio::spawn(run_actor(
            self.account_id.clone(),
            self.config.clone(),
            self.event_tx.clone(),
            cmd_rx,
        ));
        self.cmd_tx = Some(cmd_tx);
        self.actor = Some(actor);

        // clientCapabilities advertises only what this headless relay can serve
        // (no fs, no terminal); an operator override is relayed verbatim.
        let client_capabilities = self
            .config
            .client_capabilities
            .clone()
            .unwrap_or_else(default_client_capabilities);
        let response = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientCapabilities": client_capabilities,
                    "clientInfo": {
                        "name": "cce-acp-connector",
                        "title": "Cheers ACP Connector",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                }),
                self.request_timeout_ms(),
            )
            .await?;
        tracing::info!(
            account = %self.account_id,
            agent = %response
                .get("agentInfo")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown"),
            "initialized ACP agent (runtime transport)"
        );
        self.initialize_response = Some(response.clone());
        Ok(response)
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        // Dropping cmd_tx ends the actor's command loop → connection closes →
        // the child is killed inside run_actor.
        self.cmd_tx = None;
        if let Some(actor) = self.actor.take() {
            actor.abort();
            let _ = actor.await;
        }
        self.initialize_response = None;
        Ok(())
    }

    async fn restart(&mut self) -> anyhow::Result<Value> {
        self.stop().await?;
        self.start().await
    }

    async fn new_session(
        &mut self,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionStartResult> {
        let result = self
            .request(
                "session/new",
                json!({ "cwd": options.cwd, "additionalDirectories": options.additional_dirs, "mcpServers": options.mcp_servers }),
                self.request_timeout_ms(),
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("ACP session/new did not return sessionId"))?
            .to_string();
        self.apply_permission_mode(&session_id).await;
        self.apply_config_options(&session_id).await;
        Ok(SessionStartResult {
            session_id,
            metadata: result,
        })
    }

    async fn load_session(
        &mut self,
        session_id: &str,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionLoadResult> {
        let result = self
            .request(
                "session/load",
                json!({ "sessionId": session_id, "cwd": options.cwd, "additionalDirectories": options.additional_dirs, "mcpServers": options.mcp_servers }),
                self.request_timeout_ms(),
            )
            .await?;
        self.apply_permission_mode(session_id).await;
        self.apply_config_options(session_id).await;
        Ok(SessionLoadResult { metadata: result })
    }

    async fn prompt(
        &mut self,
        session_id: &str,
        prompt: Vec<Value>,
        timeout_ms: u64,
    ) -> anyhow::Result<PromptResult> {
        let result = self
            .request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": prompt }),
                timeout_ms,
            )
            .await?;
        Ok(PromptResult {
            stop_reason: result
                .get("stopReason")
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
        })
    }

    async fn cancel(&mut self, session_id: &str) -> anyhow::Result<()> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await
    }

    async fn set_config_option(
        &mut self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> anyhow::Result<Value> {
        self.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
            self.request_timeout_ms(),
        )
        .await
    }

    async fn set_mode(&mut self, session_id: &str, mode: &str) -> anyhow::Result<()> {
        self.request(
            "session/set_mode",
            json!({ "sessionId": session_id, "modeId": mode }),
            self.request_timeout_ms(),
        )
        .await
        .map(|_| ())
    }

    async fn apply_settings(
        &mut self,
        settings: &ConnectorControlSettings,
    ) -> anyhow::Result<ConfigApplyResult> {
        let mut applied = Vec::new();
        let mut rejected = Vec::new();
        let previous = self.config.clone();
        let mut restart_fields = Vec::new();

        if settings.permission_mode.is_some() {
            rejected.push(ConfigStatusRejectedField {
                field: "permissionMode".to_string(),
                reason: "channel resource permission is resolved by Backend membership role; ACP permission prompts use permission_resolution".to_string(),
            });
        }
        if let Some(mode) = &settings.agent_native_permission_mode {
            self.config.agent_native_permission_mode = Some(mode.clone());
            applied.push("agentNativePermissionMode".to_string());
        }
        if let Some(value) = settings.request_timeout_ms {
            self.config.request_timeout_ms = value;
            applied.push("requestTimeoutMs".to_string());
        }
        if let Some(value) = settings.prompt_timeout_ms {
            self.config.prompt_timeout_ms = value;
            applied.push("promptTimeoutMs".to_string());
        }
        if let Some(cwd) = &settings.cwd {
            self.config.cwd = Some(std::path::PathBuf::from(cwd));
            applied.push("cwd".to_string());
            restart_fields.push("cwd".to_string());
        }
        if let Some(model) = &settings.model {
            self.config.model = Some(model.clone());
            applied.push("model".to_string());
            restart_fields.push("model".to_string());
        }
        if let Some(config_options) = &settings.config_options {
            // Stored (already L0-clamped); applied per-session via
            // session/set_config_option at session start — no restart needed.
            self.config.config_options = Some(config_options.clone());
            applied.push("configOptions".to_string());
        }
        if !restart_fields.is_empty() {
            if let Err(err) = self.restart().await {
                self.config = previous;
                let _ = self.restart().await;
                applied.retain(|field| !restart_fields.iter().any(|r| r == field));
                rejected.push(ConfigStatusRejectedField {
                    field: restart_fields.join(","),
                    reason: format!("ACP agent restart failed after config update: {err}"),
                });
            }
        }
        Ok(ConfigApplyResult { applied, rejected })
    }

    fn permission_options(&self, params: &Value) -> Vec<PermissionOption> {
        crate::acp_adapter::permission_options_from_params(params)
    }
}

/// The only agent→client *notification* the headless relay serves; every other
/// notification is declined (`Handled::No`) so the runtime applies its default
/// handling. Pure so the opaque-relay routing is unit-testable.
fn runtime_serves_notification(method: &str) -> bool {
    method == "session/update"
}

/// The only agent→client *request* the headless relay serves; every other
/// request is declined so the runtime answers JSON-RPC `-32601` (Cheers
/// advertises no fs/* or terminal capabilities — docs/arch/ACP_FS_PROXY.md).
fn runtime_serves_request(method: &str) -> bool {
    method == "session/request_permission"
}

/// Extract `(sessionId, update)` from a `session/update` notification's params.
/// The `update` value is forwarded to the backend **verbatim** (opaque relay) —
/// no field is dropped, renamed, or normalized. Returns `None` when there is no
/// usable sessionId (nothing to relay).
fn session_update_parts(params: &Value) -> Option<(String, Value)> {
    let session_id = params.get("sessionId").and_then(|v| v.as_str())?;
    if session_id.is_empty() {
        return None;
    }
    let update = params.get("update").cloned().unwrap_or(Value::Null);
    Some((session_id.to_string(), update))
}

/// Serialize a resolved [`PermissionOutcome`] into the exact ACP
/// `RequestPermissionResponse` wire shape the agent expects — a **bare** result
/// (`{"outcome":{"outcome":"selected","optionId":…}}` /
/// `{"outcome":{"outcome":"cancelled"}}`), no JSON-RPC envelope. Uses the typed
/// schema rather than hand-written JSON so a crate upgrade can't silently drift
/// the bytes; the `permission_response_is_wire_compatible` test pins them.
fn permission_response_value(outcome: PermissionOutcome) -> Value {
    let acp_outcome = match outcome {
        PermissionOutcome::Selected { option_id } => {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
        }
        PermissionOutcome::Cancelled => RequestPermissionOutcome::Cancelled,
    };
    serde_json::to_value(RequestPermissionResponse::new(acp_outcome))
        .unwrap_or_else(|_| json!({ "outcome": { "outcome": "cancelled" } }))
}

/// The connection actor: spawns the agent child with full env/cwd control,
/// wraps its stdio in the runtime's `ByteStreams` transport, registers the raw
/// inbound hooks, and drives the outbound command loop until the handle drops.
async fn run_actor(
    account_id: String,
    config: StdioAgentConfig,
    event_tx: mpsc::Sender<RuntimeEvent>,
    cmd_rx: mpsc::Receiver<Command>,
) -> anyhow::Result<()> {
    let mut command = TokioCommand::new(&config.command);
    command
        .args(&config.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !config.inherit_env {
        command.env_clear();
    }
    if let Some(cwd) = &config.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &config.env {
        command.env(key, value);
    }
    let mut child = command.spawn().with_context(|| {
        format!(
            "failed to start ACP agent account={account_id} command={}",
            config.command
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("ACP agent stdin was not piped"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("ACP agent stdout was not piped"))?;
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_reader(account_id.clone(), stderr);
    }
    // ByteStreams takes (outgoing/write, incoming/read) as futures-io streams.
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());

    let event_notif = event_tx.clone();
    let event_req = event_tx;
    let account_req = account_id.clone();

    let result = Client
        .builder()
        .name("cce-acp-connector")
        .on_receive_notification(
            async move |msg: UntypedMessage, cx: ConnectionTo<Agent>| {
                // Only session/update is relayed; decline everything else so it
                // falls through to the runtime's default handling.
                if !runtime_serves_notification(&msg.method) {
                    return Ok(Handled::No {
                        message: (msg, cx),
                        retry: false,
                    });
                }
                if let Some((acp_session_id, update)) = session_update_parts(&msg.params) {
                    let _ = event_notif
                        .send(RuntimeEvent::SessionUpdate {
                            acp_session_id,
                            update,
                        })
                        .await;
                }
                Ok(Handled::Yes)
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |msg: UntypedMessage,
                        responder: Responder<Value>,
                        _cx: ConnectionTo<Agent>| {
                // Only session/request_permission is served; decline everything
                // else so the runtime answers with JSON-RPC -32601 (the headless
                // relay advertises no fs/terminal capabilities).
                if !runtime_serves_request(&msg.method) {
                    return Ok(Handled::No {
                        message: (msg, responder),
                        retry: false,
                    });
                }
                // Observability (mirrors the hand-rolled path): the raw params are
                // exactly what the backend approval card is built from, so log them
                // to see what the agent (e.g. codex) actually sent.
                tracing::debug!(
                    account = %account_req,
                    raw = %msg.params,
                    "session/request_permission raw params (runtime)"
                );
                let acp_session_id = msg
                    .params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let outcome = if acp_session_id.is_empty() {
                    PermissionOutcome::Cancelled
                } else {
                    let (tx, rx) = oneshot::channel();
                    if event_req
                        .send(RuntimeEvent::PermissionRequest {
                            acp_session_id,
                            params: msg.params.clone(),
                            respond_to: tx,
                        })
                        .await
                        .is_err()
                    {
                        PermissionOutcome::Cancelled
                    } else {
                        rx.await.unwrap_or(PermissionOutcome::Cancelled)
                    }
                };
                let result = permission_response_value(outcome);
                responder.respond(result)?;
                Ok(Handled::Yes)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(transport, move |cx: ConnectionTo<Agent>| async move {
            command_loop(cx, cmd_rx).await;
            Ok(())
        })
        .await;

    let _ = child.start_kill();
    let _ = child.wait().await;
    result.map_err(|err| anyhow!("ACP runtime connection ended account={account_id}: {err}"))
}

/// Drains outbound `Command`s onto the connection. Each request runs in its own
/// task (cloning the cheap, lock-free `ConnectionTo`) so concurrent sessions
/// never block one another — and `block_task()` never runs inside a handler.
async fn command_loop(cx: ConnectionTo<Agent>, mut cmd_rx: mpsc::Receiver<Command>) {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            Command::Request {
                method,
                params,
                timeout_ms,
                reply,
            } => {
                let cx = cx.clone();
                tokio::spawn(async move {
                    let result = send_request(&cx, &method, params, timeout_ms).await;
                    let _ = reply.send(result);
                });
            }
            Command::Notify { method, params } => match UntypedMessage::new(&method, params) {
                Ok(notification) => {
                    if let Err(err) = cx.send_notification(notification) {
                        tracing::warn!("ACP notify failed method={method}: {err}");
                    }
                }
                Err(err) => {
                    tracing::warn!("ACP notify serialize failed method={method}: {err}");
                }
            },
        }
    }
}

async fn send_request(
    cx: &ConnectionTo<Agent>,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> anyhow::Result<Value> {
    let request = UntypedMessage::new(method, params)
        .map_err(|err| anyhow!("ACP request serialize failed method={method}: {err}"))?;
    let pending = cx.send_request(request).block_task();
    match timeout(Duration::from_millis(timeout_ms), pending).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(anyhow!("ACP request failed method={method}: {err}")),
        Err(_) => Err(anyhow!("ACP request timeout method={method}")),
    }
}

fn spawn_stderr_reader(account_id: String, stderr: tokio::process::ChildStderr) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::info!(account = %account_id, "[acp stderr] {line}");
        }
    });
}

/// Sends a request `Command` to the actor and awaits the typed reply. Shared by
/// `RuntimeAcpAdapter::request` and `RuntimeRequester::prompt`.
async fn request_via(
    cmd_tx: &mpsc::Sender<Command>,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> anyhow::Result<Value> {
    let (reply_tx, reply_rx) = oneshot::channel();
    cmd_tx
        .send(Command::Request {
            method: method.to_string(),
            params,
            timeout_ms,
            reply: reply_tx,
        })
        .await
        .map_err(|_| anyhow!("ACP runtime actor is gone (method={method})"))?;
    reply_rx
        .await
        .map_err(|_| anyhow!("ACP runtime actor dropped reply (method={method})"))?
}

/// Lock-free issuer for the concurrent-prompt path — the runtime-backed
/// equivalent of [`crate::acp_adapter::AcpRequester`]. Holds only the actor
/// command channel, so `prompt` can be awaited concurrently across sessions.
#[derive(Clone)]
pub struct RuntimeRequester {
    cmd_tx: Option<mpsc::Sender<Command>>,
}

impl RuntimeRequester {
    pub async fn prompt(
        &self,
        session_id: &str,
        prompt: Vec<Value>,
        timeout_ms: u64,
    ) -> anyhow::Result<PromptResult> {
        let cmd_tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| anyhow!("ACP runtime adapter is not started (prompt)"))?;
        let result = request_via(
            cmd_tx,
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": prompt }),
            timeout_ms,
        )
        .await?;
        Ok(PromptResult {
            stop_reason: result
                .get("stopReason")
                .and_then(|v| v.as_str())
                .map(ToString::to_string),
        })
    }
}

/// Whether the official runtime transport (Tier B) is selected. Default off;
/// `CHEERS_ACP_RUNTIME=1` (or `true`) opts in. This is the dev cutover switch
/// while the runtime path reaches parity with the hand-rolled transport.
fn runtime_transport_enabled() -> bool {
    std::env::var("CHEERS_ACP_RUNTIME")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Startup-selected ACP transport. Both variants share the `RuntimeEvent`
/// channel and expose the same surface, so `bridge_runtime::run` is agnostic to
/// which one backs it.
pub enum AcpAdapterKind {
    HandRolled(crate::acp_adapter::AcpAdapter),
    Runtime(RuntimeAcpAdapter),
}

/// The requester counterpart of [`AcpAdapterKind`].
pub enum AcpRequesterKind {
    HandRolled(crate::acp_adapter::AcpRequester),
    Runtime(RuntimeRequester),
}

impl AcpAdapterKind {
    /// Builds the transport selected by `CHEERS_ACP_RUNTIME` (default: hand-rolled).
    pub fn new(
        account_id: impl Into<String>,
        config: StdioAgentConfig,
        event_tx: mpsc::Sender<RuntimeEvent>,
    ) -> Self {
        let account_id = account_id.into();
        if runtime_transport_enabled() {
            tracing::info!(
                account = %account_id,
                "ACP transport: official runtime crate (CHEERS_ACP_RUNTIME)"
            );
            Self::Runtime(RuntimeAcpAdapter::new(account_id, config, event_tx))
        } else {
            Self::HandRolled(crate::acp_adapter::AcpAdapter::new(
                account_id, config, event_tx,
            ))
        }
    }

    pub async fn start(&mut self) -> anyhow::Result<Value> {
        match self {
            Self::HandRolled(a) => a.start().await,
            Self::Runtime(a) => a.start().await,
        }
    }

    pub async fn stop(&mut self) -> anyhow::Result<()> {
        match self {
            Self::HandRolled(a) => a.stop().await,
            Self::Runtime(a) => a.stop().await,
        }
    }

    pub async fn new_session(
        &mut self,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionStartResult> {
        match self {
            Self::HandRolled(a) => a.new_session(options).await,
            Self::Runtime(a) => a.new_session(options).await,
        }
    }

    pub async fn load_session(
        &mut self,
        session_id: &str,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionLoadResult> {
        match self {
            Self::HandRolled(a) => a.load_session(session_id, options).await,
            Self::Runtime(a) => a.load_session(session_id, options).await,
        }
    }

    pub async fn cancel(&mut self, session_id: &str) -> anyhow::Result<()> {
        match self {
            Self::HandRolled(a) => a.cancel(session_id).await,
            Self::Runtime(a) => a.cancel(session_id).await,
        }
    }

    pub async fn set_config_option(
        &mut self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> anyhow::Result<Value> {
        match self {
            Self::HandRolled(a) => a.set_config_option(session_id, config_id, value).await,
            Self::Runtime(a) => a.set_config_option(session_id, config_id, value).await,
        }
    }

    pub async fn set_mode(&mut self, session_id: &str, mode: &str) -> anyhow::Result<()> {
        match self {
            Self::HandRolled(a) => a.set_mode(session_id, mode).await,
            Self::Runtime(a) => a.set_mode(session_id, mode).await,
        }
    }

    pub async fn apply_settings(
        &mut self,
        settings: &ConnectorControlSettings,
    ) -> anyhow::Result<ConfigApplyResult> {
        match self {
            Self::HandRolled(a) => a.apply_settings(settings).await,
            Self::Runtime(a) => a.apply_settings(settings).await,
        }
    }

    pub fn permission_options(&self, params: &Value) -> Vec<PermissionOption> {
        match self {
            Self::HandRolled(a) => a.permission_options(params),
            Self::Runtime(a) => a.permission_options(params),
        }
    }

    pub fn requester(&self) -> AcpRequesterKind {
        match self {
            Self::HandRolled(a) => AcpRequesterKind::HandRolled(a.requester()),
            Self::Runtime(a) => AcpRequesterKind::Runtime(a.requester()),
        }
    }

    pub async fn inject_fence(&self, acp_session_id: impl Into<String>) {
        match self {
            Self::HandRolled(a) => a.inject_fence(acp_session_id).await,
            Self::Runtime(a) => a.inject_fence(acp_session_id).await,
        }
    }

    pub fn supports_load_session(&self) -> bool {
        match self {
            Self::HandRolled(a) => a.supports_load_session(),
            Self::Runtime(a) => a.supports_load_session(),
        }
    }

    pub fn supports_prompt_image(&self) -> bool {
        match self {
            Self::HandRolled(a) => a.supports_prompt_image(),
            Self::Runtime(a) => a.supports_prompt_image(),
        }
    }

    pub fn supports_mcp_http(&self) -> bool {
        match self {
            Self::HandRolled(a) => a.supports_mcp_http(),
            Self::Runtime(a) => a.supports_mcp_http(),
        }
    }

    pub fn supports_mcp_sse(&self) -> bool {
        match self {
            Self::HandRolled(a) => a.supports_mcp_sse(),
            Self::Runtime(a) => a.supports_mcp_sse(),
        }
    }

    pub fn initialize_response(&self) -> Option<&Value> {
        match self {
            Self::HandRolled(a) => a.initialize_response(),
            Self::Runtime(a) => a.initialize_response(),
        }
    }
}

impl AcpRequesterKind {
    pub async fn prompt(
        &self,
        session_id: &str,
        prompt: Vec<Value>,
        timeout_ms: u64,
    ) -> anyhow::Result<PromptResult> {
        match self {
            Self::HandRolled(r) => r.prompt(session_id, prompt, timeout_ms).await,
            Self::Runtime(r) => r.prompt(session_id, prompt, timeout_ms).await,
        }
    }
}

#[cfg(test)]
mod tests {
    //! Tier B opaque-relay P0 regression tests (docs/arch/ACP_RUST_SDK_ADOPTION.md
    //! §3.5). The inbound hooks themselves need a live connection, so we pin the
    //! pure decision logic they delegate to: ① relay verbatim, ② per-method
    //! decline, ③ bare permission-response wire shape.
    use super::*;

    // ── ② per-method decline ─────────────────────────────────────────────────
    #[test]
    fn only_session_update_notification_is_served() {
        // session/update is the sole agent→client notification we relay; every
        // other one is declined so the runtime applies its default handling.
        assert!(runtime_serves_notification("session/update"));
        assert!(!runtime_serves_notification("session/request_permission"));
        assert!(!runtime_serves_notification("fs/read_text_file"));
        assert!(!runtime_serves_notification("terminal/output"));
        assert!(!runtime_serves_notification("something/else"));
    }

    #[test]
    fn only_request_permission_request_is_served() {
        // Mirrors the legacy path's regression guard: Cheers advertises fs/terminal
        // as false, so these agent→client requests MUST stay declined (-32601) on
        // the runtime path too — flipping any to served needs a handler first.
        assert!(runtime_serves_request("session/request_permission"));
        assert!(!runtime_serves_request("fs/read_text_file"));
        assert!(!runtime_serves_request("fs/write_text_file"));
        assert!(!runtime_serves_request("terminal/create"));
        assert!(!runtime_serves_request("terminal/output"));
        assert!(!runtime_serves_request("terminal/wait_for_exit"));
        assert!(!runtime_serves_request("terminal/kill"));
        assert!(!runtime_serves_request("terminal/release"));
        assert!(!runtime_serves_request("session/cancel"));
    }

    // ── ③ bare {optionId} permission-response wire shape ─────────────────────
    #[test]
    fn permission_response_is_wire_compatible() {
        // The runtime path must emit the exact same bare ACP result the legacy
        // path pins (no JSON-RPC envelope, no stray keys), so the agent parses it.
        assert_eq!(
            permission_response_value(PermissionOutcome::Selected {
                option_id: "allow_once".to_string()
            }),
            json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}})
        );
        assert_eq!(
            permission_response_value(PermissionOutcome::Cancelled),
            json!({"outcome": {"outcome": "cancelled"}})
        );
    }

    // ── ① opaque relay: session/update forwarded verbatim ────────────────────
    #[test]
    fn session_update_relay_preserves_nested_meta_verbatim() {
        // The opaque-relay guarantee: the `update` value (including agent-specific
        // _meta such as codex's normalized command/cwd) reaches the backend
        // byte-for-byte — no field dropped, renamed, or normalized.
        let update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call_1",
            "kind": "execute",
            "rawInput": { "command": "printf hi > x.txt" },
            "_meta": { "codex": { "params": {
                "command": "/bin/zsh -lc \"printf hi > x.txt\"",
                "cwd": "/work"
            }}}
        });
        let params = json!({ "sessionId": "s1", "update": update });
        let (session_id, relayed) = session_update_parts(&params).expect("relayed");
        assert_eq!(session_id, "s1");
        assert_eq!(relayed, update); // verbatim — the whole nested _meta survives

        // No usable sessionId → nothing to relay (handler still returns Handled::Yes).
        assert!(session_update_parts(&json!({ "sessionId": "", "update": update })).is_none());
        assert!(session_update_parts(&json!({ "update": update })).is_none());
    }

    // ── ① opaque relay: request_permission option passthrough ────────────────
    #[test]
    fn permission_options_pass_through_codex_option_kinds() {
        // The runtime path delegates option extraction to the shared helper; the
        // agent's option ids + kinds (incl. codex's execpolicy-amendment variant,
        // whose kind is allow_always) must pass through so the backend maps
        // allow/reject correctly.
        let params = json!({
            "sessionId": "s1",
            "options": [
                {"optionId": "allow_once", "kind": "allow_once", "name": "Allow Once"},
                {"optionId": "allow_always", "kind": "allow_always", "name": "Allow for Session"},
                {"optionId": "accept_execpolicy_amendment", "kind": "allow_always", "name": "Allow and Remember Command Pattern"},
                {"optionId": "reject_once", "kind": "reject_once", "name": "Reject"}
            ]
        });
        let options = crate::acp_adapter::permission_options_from_params(&params);
        assert_eq!(options.len(), 4);
        assert_eq!(options[0].option_id, "allow_once");
        assert_eq!(options[0].kind.as_deref(), Some("allow_once"));
        assert_eq!(options[3].option_id, "reject_once");
        assert_eq!(options[3].kind.as_deref(), Some("reject_once"));
    }
}
