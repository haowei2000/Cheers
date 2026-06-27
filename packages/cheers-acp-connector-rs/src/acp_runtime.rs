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
//! Not yet wired into `bridge_runtime::run` (that swap is feature-flagged and
//! lands separately); this module is self-contained and compiled but unselected.
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
                json!({ "cwd": options.cwd, "mcpServers": options.mcp_servers }),
                self.request_timeout_ms(),
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("ACP session/new did not return sessionId"))?
            .to_string();
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
                json!({ "sessionId": session_id, "cwd": options.cwd, "mcpServers": options.mcp_servers }),
                self.request_timeout_ms(),
            )
            .await?;
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

    let result = Client
        .builder()
        .name("cce-acp-connector")
        .on_receive_notification(
            async move |msg: UntypedMessage, cx: ConnectionTo<Agent>| {
                // Only session/update is relayed; decline everything else so it
                // falls through to the runtime's default handling.
                if msg.method != "session/update" {
                    return Ok(Handled::No {
                        message: (msg, cx),
                        retry: false,
                    });
                }
                let acp_session_id = msg
                    .params
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if !acp_session_id.is_empty() {
                    let update = msg.params.get("update").cloned().unwrap_or(Value::Null);
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
                if msg.method != "session/request_permission" {
                    return Ok(Handled::No {
                        message: (msg, responder),
                        retry: false,
                    });
                }
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
                let acp_outcome = match outcome {
                    PermissionOutcome::Selected { option_id } => {
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                            option_id,
                        ))
                    }
                    PermissionOutcome::Cancelled => RequestPermissionOutcome::Cancelled,
                };
                let result = serde_json::to_value(RequestPermissionResponse::new(acp_outcome))
                    .unwrap_or_else(|_| json!({ "outcome": { "outcome": "cancelled" } }));
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
