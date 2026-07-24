#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol_schema::v1::{
    ClientCapabilities, Implementation, RequestPermissionOutcome, RequestPermissionResponse,
    SelectedPermissionOutcome,
};
use anyhow::{anyhow, Context};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;

use crate::bridge::{ConfigStatusRejectedField, ConnectorControlSettings, PermissionOption};
use crate::config::StdioAgentConfig;
use crate::runtime_adapter::{
    ConfigApplyResult, PermissionOutcome, PromptResult, RuntimeAdapter, RuntimeEvent,
    SessionLoadResult, SessionStartOptions, SessionStartResult,
};

type PendingMap = Arc<Mutex<BTreeMap<u64, oneshot::Sender<JsonRpcReply>>>>;
type SharedWriter = Arc<Mutex<Option<ChildStdin>>>;

/// ACP major protocol version this connector implements. Per the ACP
/// initialization spec the version is bumped only on breaking changes;
/// non-breaking additions are negotiated through capabilities, so a single
/// supported major is all we advertise.
/// <https://agentclientprotocol.com/protocol/v1/initialization>
pub(crate) const ACP_PROTOCOL_VERSION: u16 = 1;

/// The outcome of ACP protocol-version negotiation given the version the agent
/// echoed in its `initialize` response.
#[derive(Debug, PartialEq, Eq)]
enum VersionDecision {
    /// The agent agreed on a version we implement.
    Ok,
    /// The agent returned a version we do not implement — the client SHOULD
    /// close the connection rather than speak a mismatched protocol.
    Unsupported(u64),
    /// The agent omitted `protocolVersion` (spec-violating); proceed leniently.
    Missing,
}

/// Decide how to react to the agent's negotiated `protocolVersion`. Per the ACP
/// initialization spec the agent echoes our version when it supports it, else
/// returns the latest IT supports; if that isn't a major we implement the client
/// SHOULD close the connection. <https://agentclientprotocol.com/protocol/v1/initialization>
fn negotiate_protocol_version(returned: Option<u64>) -> VersionDecision {
    match returned {
        Some(version) if version == u64::from(ACP_PROTOCOL_VERSION) => VersionDecision::Ok,
        Some(version) => VersionDecision::Unsupported(version),
        None => VersionDecision::Missing,
    }
}

/// Prefer `cursor_login` when advertised (Cursor CLI ACP); otherwise the first
/// `authMethods[].id`. Empty / missing methods → no authenticate call (Claude /
/// Codex / OpenCode typically don't require one after initialize).
pub(crate) fn preferred_auth_method_id(initialize_response: &Value) -> Option<String> {
    let methods = initialize_response.get("authMethods")?.as_array()?;
    let ids: Vec<&str> = methods
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .collect();
    if ids.is_empty() {
        return None;
    }
    if ids.iter().any(|id| *id == "cursor_login") {
        return Some("cursor_login".into());
    }
    Some(ids[0].to_string())
}

/// The single source of truth for the `clientCapabilities` Cheers advertises in
/// `initialize`. Cheers is a headless relay: the only agent→client method it
/// serves is `session/request_permission` (see `peer_method_supported`), so
/// every `fs/*` and `terminal` capability is advertised as `false`. `config.rs`
/// reuses THIS function so the configured value and the in-code fallback can
/// never silently diverge.
pub(crate) fn default_client_capabilities() -> Value {
    // The locked-down posture (no fs, no terminal) IS the official
    // `ClientCapabilities::default()` — a type-asserted invariant rather than
    // hand-written JSON, so it cannot silently drift across a crate upgrade.
    // Both `ClientCapabilities` and `FileSystemCapabilities` are
    // `#[skip_serializing_none]`, so this serializes to exactly
    // `{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}`.
    serde_json::to_value(ClientCapabilities::default())
        .expect("serializing default ACP client capabilities is infallible")
}

#[derive(Debug)]
enum JsonRpcReply {
    Result(Value),
    Error(JsonRpcErrorPayload),
}

#[derive(Debug, Clone)]
struct JsonRpcErrorPayload {
    code: i64,
    message: String,
    data: Option<Value>,
}

pub struct AcpAdapter {
    account_id: String,
    config: StdioAgentConfig,
    event_tx: mpsc::Sender<RuntimeEvent>,
    child: Option<Child>,
    writer: SharedWriter,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
    initialize_response: Option<Value>,
}

impl AcpAdapter {
    pub fn new(
        account_id: impl Into<String>,
        config: StdioAgentConfig,
        event_tx: mpsc::Sender<RuntimeEvent>,
    ) -> Self {
        Self {
            account_id: account_id.into(),
            config,
            event_tx,
            child: None,
            writer: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(BTreeMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            initialize_response: None,
        }
    }

    pub fn initialize_response(&self) -> Option<&Value> {
        self.initialize_response.as_ref()
    }

    /// Injects a LoadSessionFence marker into the adapter event channel.
    /// Because this channel is the same FIFO through which load_session history-replay
    /// notifications flow, the fence is guaranteed to arrive in runtime_tx only after
    /// all preceding notifications have been forwarded.
    pub async fn inject_fence(&self, acp_session_id: impl Into<String>) {
        let _ = self
            .event_tx
            .send(RuntimeEvent::LoadSessionFence {
                acp_session_id: acp_session_id.into(),
            })
            .await;
    }

    pub fn supports_load_session(&self) -> bool {
        self.agent_capabilities()
            .and_then(|value| value.get("loadSession"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn agent_capabilities(&self) -> Option<&Value> {
        self.initialize_response
            .as_ref()
            .and_then(|value| value.get("agentCapabilities"))
    }

    /// Whether the agent accepts image content blocks in a prompt
    /// (`agentCapabilities.promptCapabilities.image`). Defaults to `false`: the
    /// spec says the client must not send a modality the agent never advertised,
    /// so we degrade images to a text summary instead of pushing blocks blindly.
    pub fn supports_prompt_image(&self) -> bool {
        self.agent_capabilities()
            .and_then(|value| value.get("promptCapabilities"))
            .and_then(|value| value.get("image"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Whether the agent accepts audio content blocks in a prompt
    /// (`agentCapabilities.promptCapabilities.audio`). Same default-deny rule
    /// as images: never push a modality the agent didn't advertise.
    pub fn supports_prompt_audio(&self) -> bool {
        self.agent_capabilities()
            .and_then(|value| value.get("promptCapabilities"))
            .and_then(|value| value.get("audio"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Whether the agent supports the optional HTTP MCP transport
    /// (`agentCapabilities.mcpCapabilities.http`). stdio MCP is the ACP baseline
    /// and needs no capability; only the `http`/`sse` transports are gated.
    pub fn supports_mcp_http(&self) -> bool {
        self.agent_capabilities()
            .and_then(|value| value.get("mcpCapabilities"))
            .and_then(|value| value.get("http"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// Whether the agent supports the optional SSE MCP transport
    /// (`agentCapabilities.mcpCapabilities.sse`).
    pub fn supports_mcp_sse(&self) -> bool {
        self.agent_capabilities()
            .and_then(|value| value.get("mcpCapabilities"))
            .and_then(|value| value.get("sse"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    async fn spawn_peer(&mut self) -> anyhow::Result<()> {
        if self.child.is_some() {
            return Ok(());
        }

        let mut command = Command::new(&self.config.command);
        command
            .args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !self.config.inherit_env {
            command.env_clear();
        }
        if let Some(cwd) = &self.config.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &self.config.env {
            command.env(key, value);
        }

        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to start ACP agent account={} command={}",
                self.account_id, self.config.command
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
        let stderr = child.stderr.take();

        *self.writer.lock().await = Some(stdin);
        spawn_stdout_reader(
            self.account_id.clone(),
            stdout,
            self.writer.clone(),
            self.pending.clone(),
            self.event_tx.clone(),
        );
        if let Some(stderr) = stderr {
            spawn_stderr_reader(self.account_id.clone(), stderr);
        }

        self.child = Some(child);
        Ok(())
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> anyhow::Result<Value> {
        self.ensure_peer_alive()
            .await
            .with_context(|| format!("ACP peer is not running before request method={method}"))?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        tracing::debug!(account = %self.account_id, method, id, "ACP client→peer request");
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(err) = write_json_line(&self.writer, &request).await {
            self.pending.lock().await.remove(&id);
            return Err(err);
        }

        let reply = match timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                return Err(anyhow!(
                    "ACP peer closed before response method={method} id={id}"
                ));
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err(anyhow!("ACP request timeout method={method} id={id}"));
            }
        };
        match reply {
            JsonRpcReply::Result(value) => Ok(value),
            JsonRpcReply::Error(error) => Err(anyhow!(
                "ACP request failed method={} id={} code={} message={}{}",
                method,
                id,
                error.code,
                error.message,
                error
                    .data
                    .as_ref()
                    .map(|data| format!(" data={data}"))
                    .unwrap_or_default()
            )),
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> anyhow::Result<()> {
        self.ensure_peer_alive()
            .await
            .with_context(|| format!("ACP peer is not running before notify method={method}"))?;
        write_json_line(
            &self.writer,
            &json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }),
        )
        .await
    }

    fn request_timeout_ms(&self) -> u64 {
        self.config.request_timeout_ms
    }

    /// A cheap, cloneable handle for issuing ACP JSON-RPC requests WITHOUT
    /// holding the `AcpAdapter` Mutex across the await. The transport state
    /// (`writer`, `pending`, `next_id`) is already `Arc`-shared, so a turn can
    /// issue `session/prompt` and await its (possibly minutes-long,
    /// approval-gated) response concurrently with other sessions' turns. This is
    /// what lets one bot serve multiple sessions without a long-held adapter lock
    /// (per-session ordering is still enforced by `run_task`'s `session_lock`).
    pub(crate) fn requester(&self) -> AcpRequester {
        AcpRequester {
            account_id: self.account_id.clone(),
            writer: self.writer.clone(),
            pending: self.pending.clone(),
            next_id: self.next_id.clone(),
        }
    }

    /// Temporary stopgap: if a permission mode is configured, push it to the
    /// agent via ACP `session/set_mode`. Best-effort — a rejected/unknown mode
    /// is logged, not fatal. The full design stores this in platform bot config.
    async fn apply_permission_mode(&mut self, session_id: &str) {
        let Some(mode) = self.config.agent_native_permission_mode.clone() else {
            tracing::info!(
                account = %self.account_id,
                session = %session_id,
                "permission_mode not configured; skipping session/set_mode — agent keeps its \
                 native approval policy (e.g. a danger-full-access codex self-approves and never \
                 sends session/request_permission, so no approval card is produced)"
            );
            return;
        };
        if mode.trim().is_empty() {
            tracing::info!(
                account = %self.account_id,
                session = %session_id,
                "permission_mode is blank; skipping session/set_mode"
            );
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
            Ok(_) => {
                tracing::info!(account = %self.account_id, mode = %mode, "applied ACP session mode");
            }
            Err(err) => {
                tracing::warn!(
                    account = %self.account_id,
                    mode = %mode,
                    "session/set_mode failed (unknown modeId or agent rejected?): {err}"
                );
            }
        }
    }

    /// Pushes the backend-desired ACP config options to the agent via
    /// `session/set_config_option` (best-effort), the `set_config_option`
    /// analogue of [`apply_permission_mode`]. Values are opaque strings
    /// (ACP-generic); the map was already clamped to `allowed_config_options`
    /// at the `config_update` boundary.
    async fn apply_config_options(&mut self, session_id: &str) {
        let Some(map) = self
            .config
            .config_options
            .as_ref()
            .and_then(|v| v.as_object())
            .cloned()
        else {
            return;
        };
        for (config_id, value) in map {
            let Some(value) = value.as_str() else {
                continue;
            };
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
                    "applied ACP config option"
                ),
                // "model" has a native ACP twin: agents that predate the
                // config-options extension (e.g. older codex-acp) only accept
                // `session/set_model` — retry there before giving up.
                Err(err) if config_id == "model" => {
                    match self
                        .request(
                            "session/set_model",
                            json!({ "sessionId": session_id, "modelId": value }),
                            self.request_timeout_ms(),
                        )
                        .await
                    {
                        Ok(_) => tracing::info!(
                            account = %self.account_id,
                            session = %session_id,
                            value = %value,
                            "applied model via native session/set_model fallback"
                        ),
                        Err(err2) => tracing::warn!(
                            account = %self.account_id,
                            "model rejected by both set_config_option ({err}) and set_model ({err2})"
                        ),
                    }
                }
                Err(err) => tracing::warn!(
                    account = %self.account_id,
                    config_id = %config_id,
                    "session/set_config_option failed (unknown id/value or agent rejected?): {err}"
                ),
            }
        }
    }

    async fn ensure_peer_alive(&mut self) -> anyhow::Result<()> {
        let Some(child) = self.child.as_mut() else {
            return Err(anyhow!("ACP peer is not started"));
        };
        if let Some(status) = child.try_wait().context("failed to poll ACP peer status")? {
            *self.writer.lock().await = None;
            fail_all_pending(&self.pending, "ACP peer exited").await;
            self.child = None;
            self.initialize_response = None;
            return Err(anyhow!("ACP peer exited status={status}"));
        }
        Ok(())
    }
}

/// Lock-free issuer of ACP JSON-RPC requests, obtained via
/// [`AcpAdapter::requester`]. Holds only the `Arc`-shared transport, never the
/// `AcpAdapter` Mutex, so `request`/`prompt` can be awaited concurrently across
/// sessions. Peer liveness needs no `child.try_wait()` here: when the peer
/// exits, the stdout reader nulls `writer` (→ `write_json_line` errors) and
/// `fail_all_pending` resolves every in-flight request with an error.
#[derive(Clone)]
pub(crate) struct AcpRequester {
    account_id: String,
    writer: SharedWriter,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
}

impl AcpRequester {
    async fn request(&self, method: &str, params: Value, timeout_ms: u64) -> anyhow::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        tracing::debug!(account = %self.account_id, method, id, "ACP client→peer request (lock-free)");
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(err) = write_json_line(&self.writer, &request).await {
            self.pending.lock().await.remove(&id);
            return Err(err);
        }
        let reply = match timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                return Err(anyhow!(
                    "ACP peer closed before response method={method} id={id}"
                ));
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err(anyhow!("ACP request timeout method={method} id={id}"));
            }
        };
        match reply {
            JsonRpcReply::Result(value) => Ok(value),
            JsonRpcReply::Error(error) => Err(anyhow!(
                "ACP request failed method={} id={} code={} message={}{}",
                method,
                id,
                error.code,
                error.message,
                error
                    .data
                    .as_ref()
                    .map(|data| format!(" data={data}"))
                    .unwrap_or_default()
            )),
        }
    }

    pub(crate) async fn prompt(
        &self,
        session_id: &str,
        prompt: Vec<Value>,
        timeout_ms: u64,
    ) -> anyhow::Result<PromptResult> {
        let result = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": prompt,
                }),
                timeout_ms,
            )
            .await?;
        Ok(PromptResult {
            stop_reason: result
                .get("stopReason")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
    }
}

#[async_trait]
impl RuntimeAdapter for AcpAdapter {
    async fn start(&mut self) -> anyhow::Result<Value> {
        self.spawn_peer().await?;
        // clientInfo built from the official `Implementation` type instead of
        // hand-written JSON. (protocolVersion stays `ACP_PROTOCOL_VERSION` — the
        // connector's single-source-of-truth const, equal to ProtocolVersion::V1.)
        let mut client_info = Implementation::new("cce-acp-connector", env!("CARGO_PKG_VERSION"));
        client_info.title = Some("Cheers ACP Connector".to_string());
        let response = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientCapabilities": self
                        .config
                        .client_capabilities
                        .clone()
                        .unwrap_or_else(default_client_capabilities),
                    "clientInfo": client_info,
                }),
                self.request_timeout_ms(),
            )
            .await?;
        // Version negotiation (ACP initialization spec): if the agent returns a
        // major we don't implement, close rather than speak a mismatched
        // protocol; a missing version is spec-violating but tolerated.
        match negotiate_protocol_version(response.get("protocolVersion").and_then(Value::as_u64)) {
            VersionDecision::Ok => {}
            VersionDecision::Unsupported(version) => {
                let _ = self.stop().await;
                return Err(anyhow!(
                    "ACP agent negotiated unsupported protocolVersion={version}; \
                     connector implements {ACP_PROTOCOL_VERSION}. Closing connection."
                ));
            }
            VersionDecision::Missing => {
                tracing::warn!(
                    account = %self.account_id,
                    "ACP initialize response omitted protocolVersion; proceeding as \
                     {ACP_PROTOCOL_VERSION} (spec requires the agent to echo it)"
                );
            }
        }
        if let Some(method_id) = preferred_auth_method_id(&response) {
            self.request(
                "authenticate",
                json!({ "methodId": method_id }),
                self.request_timeout_ms(),
            )
            .await
            .with_context(|| {
                format!(
                    "ACP authenticate with methodId={method_id} failed \
                     (for Cursor: run `agent login` or set CURSOR_API_KEY)"
                )
            })?;
            tracing::info!(
                account = %self.account_id,
                method_id = %method_id,
                "authenticated ACP agent"
            );
        }
        tracing::info!(
            account = %self.account_id,
            agent = %response
                .get("agentInfo")
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
            "initialized ACP agent"
        );
        self.initialize_response = Some(response.clone());
        Ok(response)
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        *self.writer.lock().await = None;
        fail_all_pending(&self.pending, "ACP adapter stopped").await;
        if let Some(child) = &mut self.child {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        self.child = None;
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
                json!({
                    "cwd": options.cwd,
                    "additionalDirectories": options.additional_dirs,
                    "mcpServers": options.mcp_servers,
                }),
                self.request_timeout_ms(),
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("ACP session/new did not return sessionId"))?
            .to_string();
        tracing::info!(
            account = %self.account_id,
            session = %session_id,
            modes = %result.get("modes").cloned().unwrap_or(serde_json::Value::Null),
            "ACP session/new established (modes lists the valid session/set_mode modeIds)"
        );
        tracing::debug!(
            account = %self.account_id,
            session = %session_id,
            response = %result,
            "ACP session/new full response"
        );
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
                json!({
                    "sessionId": session_id,
                    "cwd": options.cwd,
                    "additionalDirectories": options.additional_dirs,
                    "mcpServers": options.mcp_servers,
                }),
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
                json!({
                    "sessionId": session_id,
                    "prompt": prompt,
                }),
                timeout_ms,
            )
            .await?;
        Ok(PromptResult {
            stop_reason: result
                .get("stopReason")
                .and_then(Value::as_str)
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
            json!({
                "sessionId": session_id,
                "configId": config_id,
                "value": value,
            }),
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

    async fn set_model(&mut self, session_id: &str, model_id: &str) -> anyhow::Result<()> {
        self.request(
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": model_id }),
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
            self.config.cwd = Some(PathBuf::from(cwd));
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
                applied.retain(|field| !restart_fields.iter().any(|restart| restart == field));
                rejected.push(ConfigStatusRejectedField {
                    field: restart_fields.join(","),
                    reason: format!("ACP agent restart failed after config update: {err}"),
                });
            }
        }

        Ok(ConfigApplyResult { applied, rejected })
    }

    fn permission_options(&self, params: &Value) -> Vec<PermissionOption> {
        // Pure transform — delegates to the free function so the permission
        // handler can build options WITHOUT locking this adapter (see
        // `permission_options_from_params`).
        permission_options_from_params(params)
    }
}

/// Parse the ACP `session/request_permission` params' `options` array into the
/// connector's [`PermissionOption`] shape.
///
/// Deliberately a free function, NOT an `AcpAdapter` method: the permission
/// handler runs in a task spawned mid-turn while `prompt()` holds the adapter
/// `Mutex` for the whole turn. If building the options required `adapter.lock()`,
/// the handler would block on that lock while `prompt()` blocks waiting for the
/// permission answer the handler is trying to produce — a deadlock that hangs
/// the turn until the permission timeout. Keeping this stateless lets the card
/// be built without touching the adapter. (See `bridge_runtime/permission.rs`.)
pub(crate) fn permission_options_from_params(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let obj = item.as_object()?;
                    Some(PermissionOption {
                        option_id: obj
                            .get("optionId")
                            .or_else(|| obj.get("option_id"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: obj
                            .get("kind")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        name: obj
                            .get("name")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                        description: obj
                            .get("description")
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                })
                .filter(|option| !option.option_id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn spawn_stdout_reader(
    account_id: String,
    stdout: tokio::process::ChildStdout,
    writer: SharedWriter,
    pending: PendingMap,
    event_tx: mpsc::Sender<RuntimeEvent>,
) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_acp_message(&mut reader).await {
                Ok(Some(message)) => match serde_json::from_str::<Value>(&message) {
                    Ok(value) => {
                        if let Err(err) =
                            handle_peer_message(&account_id, &writer, &pending, &event_tx, value)
                                .await
                        {
                            let _ = event_tx
                                .send(RuntimeEvent::AdapterError {
                                    message: err.to_string(),
                                })
                                .await;
                        }
                    }
                    Err(err) => {
                        let _ = event_tx
                            .send(RuntimeEvent::AdapterError {
                                message: format!("invalid ACP stdout JSON: {err}: {message}"),
                            })
                            .await;
                    }
                },
                Ok(None) => break,
                Err(err) => {
                    let _ = event_tx
                        .send(RuntimeEvent::AdapterError {
                            message: format!("ACP stdout read error: {err}"),
                        })
                        .await;
                    break;
                }
            }
        }
        *writer.lock().await = None;
        fail_all_pending(&pending, "ACP stdout closed").await;
        tracing::warn!(account = %account_id, "ACP stdout reader stopped");
    });
}

fn spawn_stderr_reader(account_id: String, stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::info!(account = %account_id, "[acp stderr] {}", line);
        }
    });
}

async fn handle_peer_message(
    account_id: &str,
    writer: &SharedWriter,
    pending: &PendingMap,
    event_tx: &mpsc::Sender<RuntimeEvent>,
    value: Value,
) -> anyhow::Result<()> {
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        if value.get("method").is_some() {
            // Spawn instead of awaiting inline: session/request_permission parks on a
            // human approval (rx.await, potentially minutes). Awaiting it here would
            // stall the ONLY consumer of this agent child's stdout — freezing every
            // other concurrent session's streaming output and stranding pending
            // JSON-RPC responses. Responses are id-correlated, so replying from a task
            // (out of order) is protocol-correct; notifications keep forwarding inline.
            let account_id = account_id.to_string();
            let writer = writer.clone();
            let event_tx = event_tx.clone();
            tokio::spawn(async move {
                if let Err(err) =
                    handle_peer_request(&account_id, &writer, &event_tx, id, value).await
                {
                    let _ = event_tx
                        .send(RuntimeEvent::AdapterError {
                            message: err.to_string(),
                        })
                        .await;
                }
            });
            return Ok(());
        }
        let reply = if let Some(error) = value.get("error") {
            JsonRpcReply::Error(JsonRpcErrorPayload {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(-32000),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("ACP request failed")
                    .to_string(),
                data: error.get("data").cloned(),
            })
        } else {
            JsonRpcReply::Result(value.get("result").cloned().unwrap_or(Value::Null))
        };
        if let Some(tx) = pending.lock().await.remove(&id) {
            let _ = tx.send(reply);
        }
        return Ok(());
    }

    if value.get("method").is_some() {
        handle_peer_notification(account_id, event_tx, value).await?;
    }
    Ok(())
}

async fn handle_peer_notification(
    account_id: &str,
    event_tx: &mpsc::Sender<RuntimeEvent>,
    mut value: Value,
) -> anyhow::Result<()> {
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "session/update" {
        tracing::debug!(account = %account_id, method, "ACP peer notification (not session/update; ignored)");
        return Ok(());
    }
    // Read only the small sessionId out of the borrowed value...
    let acp_session_id = value
        .get("params")
        .and_then(|params| params.get("sessionId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if acp_session_id.is_empty() {
        return Ok(());
    }
    // ...then MOVE the (potentially large) update subtree out of the owned value
    // instead of deep-cloning it — session/update is the highest-frequency event
    // and tool_call_update carries the bulky tool output.
    let update = value
        .get_mut("params")
        .and_then(|params| params.get_mut("update"))
        .map(Value::take)
        .unwrap_or(Value::Null);
    tracing::debug!(
        account = %account_id,
        session = %acp_session_id,
        kind = update.get("sessionUpdate").and_then(serde_json::Value::as_str).unwrap_or("?"),
        "ACP session/update (a tool_call/tool_call_update kind here without a preceding \
         request_permission means the agent is auto-executing tools)"
    );
    event_tx
        .send(RuntimeEvent::SessionUpdate {
            acp_session_id,
            update,
        })
        .await
        .context("failed to forward ACP session/update")?;
    Ok(())
}

/// The single allow-list for ACP **agent→client** methods this connector serves.
///
/// Cheers is a headless relay client: it deliberately advertises
/// `clientCapabilities.fs.*` and `terminal` as `false`
/// (`default_client_capabilities()`),
/// so a spec-compliant agent never calls `fs/read_text_file`, `fs/write_text_file`,
/// or any `terminal/*`. The ONLY agent→client method we implement is
/// `session/request_permission`; everything else is answered with JSON-RPC
/// `-32601`. This is intentional, not an oversight — see
/// docs/arch/ACP_FS_PROXY.md (why ACP fs is not proxied) and
/// docs/arch/ACP_APPROVAL_FLOW.md §0.5 (the permission model). Do NOT flip a
/// capability to `true` without first implementing the corresponding handler
/// here, or the connector would advertise a capability it cannot serve.
fn peer_method_supported(method: &str) -> bool {
    matches!(method, "session/request_permission")
}

async fn handle_peer_request(
    account_id: &str,
    writer: &SharedWriter,
    event_tx: &mpsc::Sender<RuntimeEvent>,
    id: u64,
    value: Value,
) -> anyhow::Result<()> {
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    tracing::info!(account = %account_id, method, id, "ACP peer→client request received");
    if !peer_method_supported(method) {
        tracing::warn!(
            account = %account_id,
            method,
            id,
            "ACP peer→client method unsupported; replying JSON-RPC -32601 \
             (only session/request_permission is served — if you expected an approval card, \
             the agent is asking for something else, e.g. terminal/* or fs/*)"
        );
        write_json_line(
            writer,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("ACP client method is not supported: {method}")
                }
            }),
        )
        .await?;
        return Ok(());
    }

    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let acp_session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if acp_session_id.is_empty() {
        tracing::warn!(
            account = %account_id,
            id,
            "session/request_permission missing sessionId; replying cancelled"
        );
        write_permission_response(writer, id, RequestPermissionOutcome::Cancelled).await?;
        return Ok(());
    }

    tracing::info!(
        account = %account_id,
        session = %acp_session_id,
        "forwarding session/request_permission to bridge runtime (→ approval card)"
    );
    tracing::debug!(
        account = %account_id,
        raw = %params,
        "session/request_permission raw params (what codex sent; shows what we could forward)"
    );
    let (tx, rx) = oneshot::channel();
    event_tx
        .send(RuntimeEvent::PermissionRequest {
            acp_session_id: acp_session_id.clone(),
            params,
            respond_to: tx,
        })
        .await
        .with_context(|| {
            format!("failed to forward ACP permission request account={account_id}")
        })?;
    let outcome = rx.await.unwrap_or(PermissionOutcome::Cancelled);
    tracing::info!(
        account = %account_id,
        session = %acp_session_id,
        outcome = ?outcome,
        "ACP permission resolved; replying outcome to agent"
    );
    let acp_outcome = match outcome {
        PermissionOutcome::Selected { option_id } => {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
        }
        PermissionOutcome::Cancelled => RequestPermissionOutcome::Cancelled,
    };
    write_permission_response(writer, id, acp_outcome).await?;
    Ok(())
}

/// Writes a JSON-RPC success reply carrying an ACP `RequestPermissionResponse`.
///
/// The response shape is owned by the official `agent-client-protocol-schema`
/// types (`{"outcome":{"outcome":"selected","optionId":...}}` /
/// `{"outcome":{"outcome":"cancelled"}}`) rather than hand-written JSON — see the
/// `permission_response_is_wire_compatible` test pinning the exact bytes.
async fn write_permission_response(
    writer: &SharedWriter,
    id: u64,
    outcome: RequestPermissionOutcome,
) -> anyhow::Result<()> {
    let result = serde_json::to_value(RequestPermissionResponse::new(outcome))
        .context("failed to serialize ACP permission response")?;
    write_json_line(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }),
    )
    .await
}

async fn write_json_line(writer: &SharedWriter, value: &Value) -> anyhow::Result<()> {
    let mut guard = writer.lock().await;
    let Some(stdin) = guard.as_mut() else {
        return Err(anyhow!("ACP peer stdin is closed"));
    };
    let mut text = serde_json::to_string(value)?;
    text.push('\n');
    stdin.write_all(text.as_bytes()).await?;
    stdin.flush().await?;
    Ok(())
}

async fn read_acp_message<R>(reader: &mut R) -> anyhow::Result<Option<String>>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let mut first_line = String::new();
        let bytes = reader
            .read_line(&mut first_line)
            .await
            .context("failed to read ACP stdout")?;
        if bytes == 0 {
            return Ok(None);
        }
        if first_line.trim().is_empty() {
            continue;
        }
        if let Some(length) = parse_content_length(&first_line) {
            loop {
                let mut header = String::new();
                let bytes = reader
                    .read_line(&mut header)
                    .await
                    .context("failed to read ACP Content-Length header")?;
                if bytes == 0 {
                    return Err(anyhow!("ACP Content-Length frame ended before body"));
                }
                if header.trim().is_empty() {
                    break;
                }
            }
            let mut body = vec![0_u8; length];
            reader
                .read_exact(&mut body)
                .await
                .context("failed to read ACP Content-Length body")?;
            return String::from_utf8(body)
                .map(Some)
                .context("ACP Content-Length body is not UTF-8");
        }
        return Ok(Some(first_line));
    }
}

fn parse_content_length(line: &str) -> Option<usize> {
    let (name, value) = line.split_once(':')?;
    if !name.trim().eq_ignore_ascii_case("content-length") {
        return None;
    }
    value.trim().parse::<usize>().ok()
}

async fn fail_all_pending(pending: &PendingMap, reason: &str) {
    let entries = std::mem::take(&mut *pending.lock().await);
    for (_, tx) in entries {
        let _ = tx.send(JsonRpcReply::Error(JsonRpcErrorPayload {
            code: -32099,
            message: reason.to_string(),
            data: None,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn only_request_permission_is_a_supported_peer_method() {
        // Regression guard: Cheers advertises fs/terminal capabilities as false,
        // so these agent->client methods MUST stay unsupported (-32601). Flipping
        // any to supported requires implementing its handler first.
        assert!(peer_method_supported("session/request_permission"));
        assert!(!peer_method_supported("fs/read_text_file"));
        assert!(!peer_method_supported("fs/write_text_file"));
        assert!(!peer_method_supported("terminal/create"));
        assert!(!peer_method_supported("terminal/output"));
        assert!(!peer_method_supported("terminal/wait_for_exit"));
        assert!(!peer_method_supported("terminal/kill"));
        assert!(!peer_method_supported("terminal/release"));
    }

    #[test]
    fn prefers_cursor_login_when_advertised() {
        assert_eq!(
            preferred_auth_method_id(&json!({
                "authMethods": [
                    { "id": "other" },
                    { "id": "cursor_login", "name": "Cursor" }
                ]
            })),
            Some("cursor_login".into())
        );
        assert_eq!(
            preferred_auth_method_id(&json!({
                "authMethods": [{ "id": "token" }]
            })),
            Some("token".into())
        );
        assert_eq!(preferred_auth_method_id(&json!({})), None);
        assert_eq!(
            preferred_auth_method_id(&json!({ "authMethods": [] })),
            None
        );
    }

    fn test_adapter(initialize_response: Option<Value>) -> AcpAdapter {
        let (tx, _rx) = mpsc::channel(4);
        let mut adapter = AcpAdapter::new(
            "acct",
            StdioAgentConfig {
                command: "fake".to_string(),
                args: Vec::new(),
                model: None,
                cwd: None,
                env: BTreeMap::new(),
                inherit_env: true,
                request_timeout_ms: 1000,
                prompt_timeout_ms: 1000,
                agent_native_permission_mode: None,
                config_options: None,
                mcp_servers: Value::Array(Vec::new()),
                client_capabilities: None,
            },
            tx,
        );
        adapter.initialize_response = initialize_response;
        adapter
    }

    #[test]
    fn capability_accessors_parse_agent_capabilities() {
        let adapter = test_adapter(Some(json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "audio": false },
                "mcpCapabilities": { "http": true, "sse": false }
            }
        })));
        assert!(adapter.supports_load_session());
        assert!(adapter.supports_prompt_image());
        assert!(adapter.supports_mcp_http());
        assert!(!adapter.supports_mcp_sse());
    }

    #[test]
    fn capability_accessors_default_false_when_absent() {
        // No initialize response, and an empty one, must both deny every
        // optional capability — we never send a modality/transport unprompted.
        for init in [None, Some(json!({ "agentCapabilities": {} }))] {
            let adapter = test_adapter(init);
            assert!(!adapter.supports_load_session());
            assert!(!adapter.supports_prompt_image());
            assert!(!adapter.supports_mcp_http());
            assert!(!adapter.supports_mcp_sse());
        }
    }

    #[test]
    fn protocol_version_negotiation_closes_on_mismatch_only() {
        // Agent echoed the version we implement → proceed.
        assert_eq!(
            negotiate_protocol_version(Some(u64::from(ACP_PROTOCOL_VERSION))),
            VersionDecision::Ok
        );
        // Agent returned a version we don't implement → close the connection.
        assert_eq!(
            negotiate_protocol_version(Some(99)),
            VersionDecision::Unsupported(99)
        );
        assert_eq!(
            negotiate_protocol_version(Some(0)),
            VersionDecision::Unsupported(0)
        );
        // Spec-violating omission → tolerate (proceed leniently).
        assert_eq!(negotiate_protocol_version(None), VersionDecision::Missing);
    }

    #[test]
    fn default_client_capabilities_advertise_no_fs_or_terminal() {
        // The single source of truth config.rs delegates to: Cheers serves no
        // fs/* or terminal, so all must be false. Now backed by the official
        // `ClientCapabilities::default()` — this test fails the day a crate
        // upgrade makes that default permissive, guarding the locked-down posture
        // cemented in docs/arch/ACP_FS_PROXY.md.
        let caps = default_client_capabilities();
        assert_eq!(caps["fs"]["readTextFile"], false);
        assert_eq!(caps["fs"]["writeTextFile"], false);
        assert_eq!(caps["terminal"], false);
        // The typed default must serialize to exactly the locked-down wire shape
        // config.rs exact-compares against (no stray `_meta`/extra keys).
        assert_eq!(
            caps,
            json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false})
        );
    }

    #[test]
    fn permission_response_is_wire_compatible() {
        // The typed schema response must serialize to the exact ACP wire shape the
        // connector emitted before adopting `agent-client-protocol-schema`
        // (replacing the removed `PermissionOutcome::to_acp_value` helper).
        let selected = serde_json::to_value(RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                "allow-1".to_string(),
            )),
        ))
        .unwrap();
        assert_eq!(
            selected,
            json!({"outcome": {"outcome": "selected", "optionId": "allow-1"}})
        );

        let cancelled = serde_json::to_value(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ))
        .unwrap();
        assert_eq!(cancelled, json!({"outcome": {"outcome": "cancelled"}}));
    }

    #[test]
    fn permission_options_normalize_acp_option_ids() {
        let adapter = test_adapter(None);
        let options = adapter.permission_options(&json!({
            "options": [
                {"optionId": "allow-1", "kind": "allow", "name": "Allow"},
                {"option_id": "deny-1", "kind": "reject", "description": "Deny"}
            ]
        }));
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].option_id, "allow-1");
        assert_eq!(options[1].option_id, "deny-1");
    }

    #[tokio::test]
    async fn reads_content_length_framed_acp_message() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let (mut writer, reader) = tokio::io::duplex(1024);
        writer.write_all(frame.as_bytes()).await.unwrap();
        drop(writer);

        let mut reader = BufReader::new(reader);
        let message = read_acp_message(&mut reader)
            .await
            .unwrap()
            .expect("message");
        assert_eq!(message, body);
    }

    #[tokio::test]
    async fn reads_line_delimited_acp_message() {
        let body = r#"{"jsonrpc":"2.0","method":"session/update"}"#;
        let (mut writer, reader) = tokio::io::duplex(1024);
        writer
            .write_all(format!("{body}\n").as_bytes())
            .await
            .unwrap();
        drop(writer);

        let mut reader = BufReader::new(reader);
        let message = read_acp_message(&mut reader)
            .await
            .unwrap()
            .expect("message");
        assert_eq!(message.trim_end(), body);
    }
}
