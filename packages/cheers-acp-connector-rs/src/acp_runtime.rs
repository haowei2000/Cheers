//! The default `RuntimeAdapter`, backed by the official
//! `agent-client-protocol` runtime crate. The hand-rolled adapter remains only
//! as the 0.1.37 rollback transport.
//!
//! Design (see docs/arch/ACP_RUST_SDK_ADOPTION.md §3): a long-lived **actor**
//! task runs `Client.builder()…connect_with(transport, |cx| command_loop)`. The
//! `RuntimeAdapter` surface (Value in / Value out) is unchanged — methods send
//! `Command`s to the actor and await replies. Inbound `session/update` and
//! `session/request_permission` are relayed to the backend **raw** via the
//! `UntypedMessage` hooks (zero-loss opaque relay). ACP v1 elicitation is also
//! served through those hooks and validated with the official typed schema;
//! every other agent→client
//! method is declined (`Handled::No`) so the runtime answers it with `-32601`,
//! preserving the connector's headless-relay posture.
//!
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AuthenticateRequest, CancelNotification, CreateElicitationRequest, CreateElicitationResponse,
    ElicitationAction, Implementation, InitializeRequest, LoadSessionRequest, NewSessionRequest,
    PromptRequest, RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionConfigValueId, SetSessionConfigOptionRequest, SetSessionModeRequest, AGENT_METHOD_NAMES,
    CLIENT_METHOD_NAMES,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, Handled, Responder, UntypedMessage,
};
use anyhow::{anyhow, Context};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, oneshot, Mutex, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::acp_semantics::{
    apply_settings_to_config, default_client_capabilities, preferred_auth_method,
};
use crate::bridge::{ConfigStatusRejectedField, ConnectorControlSettings, PermissionOption};
use crate::config::StdioAgentConfig;
use crate::runtime_adapter::{
    AgentCapabilities, ConfigApplyResult, PermissionOutcome, PromptClient, PromptResult,
    RequestRoute, RuntimeAdapter, RuntimeEvent, SessionLoadResult, SessionStartOptions,
    SessionStartResult,
};

type RequestRoutes = std::sync::Arc<Mutex<HashMap<String, RequestRoute>>>;
const PROMPT_IN_FLIGHT_LIMIT: usize = 16;
const CONTROL_IN_FLIGHT_LIMIT: usize = 32;
const PROMPT_WORK_QUEUE_CAPACITY: usize = 32;
const CONTROL_WORK_QUEUE_CAPACITY: usize = 64;

/// A unit of work sent from the adapter handle to the connection actor.
enum Command {
    Request {
        method: String,
        params: Value,
        timeout_ms: u64,
        request_route: Option<RequestRoute>,
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
    request_routes: RequestRoutes,
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
            request_routes: Default::default(),
        }
    }

    fn request_timeout_ms(&self) -> u64 {
        self.config.request_timeout_ms
    }

    async fn request(&self, method: &str, params: Value, timeout_ms: u64) -> anyhow::Result<Value> {
        self.request_with_route(method, params, timeout_ms, None)
            .await
    }

    async fn request_with_route(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        request_route: Option<RequestRoute>,
    ) -> anyhow::Result<Value> {
        let cmd_tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| anyhow!("ACP runtime adapter is not started (method={method})"))?;
        request_via(cmd_tx, method, params, timeout_ms, request_route).await
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
                AGENT_METHOD_NAMES.session_set_mode,
                typed_params(SetSessionModeRequest::new(
                    session_id.to_string(),
                    mode.clone(),
                )),
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
    /// `set_config_option` analogue of [`Self::apply_permission_mode`]. Values are
    /// opaque strings (ACP-generic); the map was already clamped to
    /// `allowed_config_options` at the `config_update` boundary.
    async fn apply_config_options(&self, session_id: &str) {
        let Some(map) = self
            .config
            .config_options
            .as_ref()
            .and_then(|v| v.as_object())
        else {
            return;
        };
        for (config_id, value) in map {
            let Some(value) = value.as_str() else {
                continue;
            };
            match self
                .request(
                    AGENT_METHOD_NAMES.session_set_config_option,
                    typed_params(SetSessionConfigOptionRequest::new(
                        session_id.to_string(),
                        config_id.to_string(),
                        SessionConfigValueId::new(value.to_string()),
                    )),
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
                            "applied model via native session/set_model fallback (runtime)"
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
                    "session/set_config_option failed (runtime: unknown id/value or agent rejected?): {err}"
                ),
            }
        }
    }

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
            self.request_routes.clone(),
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
        let mut initialize = typed_params(
            InitializeRequest::new(ProtocolVersion::V1).client_info(
                Implementation::new("cce-acp-connector", env!("CARGO_PKG_VERSION"))
                    .title("Cheers ACP Connector"),
            ),
        );
        // Operator capability extensions are intentionally opaque; the default
        // remains the SDK's false/empty capabilities (no fs or terminal).
        initialize["clientCapabilities"] = client_capabilities;
        let response = self
            .request(
                AGENT_METHOD_NAMES.initialize,
                initialize,
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
        // Advertising authMethods does not mean the agent needs to authenticate
        // now. Existing Codex/Claude subscription sessions are loaded by the
        // agent itself. Defer authenticate until session/new explicitly returns
        // an authentication error, which RuntimeContext already recovers.
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

    async fn authenticate(&mut self, request_route: Option<RequestRoute>) -> anyhow::Result<()> {
        let Some(init) = self.initialize_response.clone() else {
            return Err(anyhow::anyhow!("ACP authenticate called before initialize"));
        };
        let Some(method) = preferred_auth_method(&init, &self.config.env) else {
            return Ok(());
        };
        tracing::info!(
            account = %self.account_id,
            method_id = %method.id,
            "ACP re-authenticate (runtime transport)"
        );
        self.request_with_route(
            AGENT_METHOD_NAMES.authenticate,
            typed_params(AuthenticateRequest::new(method.id.clone())),
            self.config.auth_timeout_ms,
            request_route,
        )
        .await
        .map(|_| ())
        .map_err(|e| {
            let hint = method
                .description
                .as_deref()
                .or(method.name.as_deref())
                .unwrap_or(method.id.as_str());
            anyhow::anyhow!(
                "ACP authenticate({}) failed: {e}. Complete agent auth: {hint}",
                method.id
            )
        })
    }

    async fn new_session(
        &mut self,
        options: SessionStartOptions,
    ) -> anyhow::Result<SessionStartResult> {
        let request_route = options.request_route.clone();
        let params = session_request_params(None, options)?;
        let result = self
            .request_with_route(
                AGENT_METHOD_NAMES.session_new,
                params,
                self.request_timeout_ms(),
                request_route,
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
        let request_route = options.request_route.clone();
        let params = session_request_params(Some(session_id), options)?;
        let result = self
            .request_with_route(
                AGENT_METHOD_NAMES.session_load,
                params,
                self.request_timeout_ms(),
                request_route,
            )
            .await?;
        self.apply_permission_mode(session_id).await;
        self.apply_config_options(session_id).await;
        Ok(SessionLoadResult { metadata: result })
    }

    async fn cancel(&mut self, session_id: &str) -> anyhow::Result<()> {
        self.notify(
            AGENT_METHOD_NAMES.session_cancel,
            typed_params(CancelNotification::new(session_id.to_string())),
        )
        .await
    }

    async fn set_config_option(
        &mut self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> anyhow::Result<Value> {
        self.request(
            AGENT_METHOD_NAMES.session_set_config_option,
            typed_params(SetSessionConfigOptionRequest::new(
                session_id.to_string(),
                config_id.to_string(),
                SessionConfigValueId::new(value.to_string()),
            )),
            self.request_timeout_ms(),
        )
        .await
    }

    async fn set_mode(&mut self, session_id: &str, mode: &str) -> anyhow::Result<()> {
        self.request(
            AGENT_METHOD_NAMES.session_set_mode,
            typed_params(SetSessionModeRequest::new(
                session_id.to_string(),
                mode.to_string(),
            )),
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
        let previous = self.config.clone();
        let application = apply_settings_to_config(&mut self.config, settings);
        let mut applied = application.applied;
        let mut rejected = application.rejected;
        let restart_fields = application.restart_fields;
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
        crate::acp_semantics::permission_options_from_params(params)
    }

    fn prompt_client(&self) -> std::sync::Arc<dyn PromptClient> {
        std::sync::Arc::new(self.requester())
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::from_initialize(self.initialize_response.as_ref())
    }

    fn initialize_response(&self) -> Option<Value> {
        self.initialize_response.clone()
    }

    async fn inject_fence(&self, acp_session_id: String) {
        RuntimeAcpAdapter::inject_fence(self, acp_session_id).await;
    }
}

/// Agent→client notifications the headless relay serves; every other
/// notification is declined (`Handled::No`) so the runtime applies its default
/// handling. Pure so the opaque-relay routing is unit-testable.
fn runtime_serves_notification(method: &str) -> bool {
    matches!(method, "session/update" | "elicitation/complete")
}

/// Agent→client requests the headless relay serves; every other
/// request is declined so the runtime answers JSON-RPC `-32601` (Cheers
/// advertises no fs/* or terminal capabilities — docs/arch/ACP_FS_PROXY.md).
fn runtime_serves_request(method: &str) -> bool {
    matches!(method, "session/request_permission" | "elicitation/create")
}

/// Extract `(sessionId, update)` from a `session/update` notification's params.
/// The `update` value is forwarded to the backend **verbatim** (opaque relay) —
/// no field is dropped, renamed, or normalized. Returns `None` when there is no
/// usable sessionId (nothing to relay).
fn session_update_parts(mut params: Value) -> Option<(String, Value)> {
    let session_id = params.get("sessionId").and_then(|v| v.as_str())?;
    if session_id.is_empty() {
        return None;
    }
    let session_id = session_id.to_string();
    let update = params
        .get_mut("update")
        .map(Value::take)
        .unwrap_or(Value::Null);
    Some((session_id, update))
}

/// Serialize a stable-v1 SDK request type into the params object consumed by
/// the runtime's batch-aware untyped dispatcher. Typed construction pins the
/// standard ACP field names while the raw dispatcher lets responses and
/// extension metadata remain lossless.
fn typed_params(request: impl Serialize) -> Value {
    serde_json::to_value(request).expect("official ACP schema request must serialize")
}

/// Use the official prompt request envelope, then restore opaque content blocks
/// verbatim. This preserves unknown future block variants and vendor `_meta`
/// while still deriving the stable request shape from the SDK.
fn prompt_params(session_id: &str, prompt: Vec<Value>) -> Value {
    let mut params = typed_params(PromptRequest::new(session_id.to_string(), Vec::new()));
    params["prompt"] = Value::Array(prompt);
    params
}

fn session_request_params(
    session_id: Option<&str>,
    options: SessionStartOptions,
) -> anyhow::Result<Value> {
    let cwd = match options.cwd {
        Some(cwd) => PathBuf::from(cwd),
        None => std::env::current_dir().context(
            "ACP stable-v1 requires an absolute session cwd and the connector cwd is unavailable",
        )?,
    };
    let additional_directories = options
        .additional_dirs
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let mut params = match session_id {
        Some(session_id) => typed_params(
            LoadSessionRequest::new(session_id.to_string(), cwd)
                .additional_directories(additional_directories),
        ),
        None => {
            typed_params(NewSessionRequest::new(cwd).additional_directories(additional_directories))
        }
    };
    // MCP definitions may contain agent-specific extension fields. Keep the
    // official typed envelope while overlaying the opaque list unchanged.
    params["mcpServers"] = options.mcp_servers;
    Ok(params)
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
    request_routes: RequestRoutes,
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
    let event_request_routes = request_routes.clone();
    let account_req = account_id.clone();

    let result = Client
        .builder()
        .name("cce-acp-connector")
        .on_receive_notification(
            async move |msg: UntypedMessage, cx: ConnectionTo<Agent>| {
                // Relay session/update and elicitation completion; decline everything else so it
                // falls through to the runtime's default handling.
                if !runtime_serves_notification(&msg.method) {
                    return Ok(Handled::No {
                        message: (msg, cx),
                        retry: false,
                    });
                }
                if msg.method == CLIENT_METHOD_NAMES.elicitation_complete {
                    if let Some(elicitation_id) = msg
                        .params
                        .get("elicitationId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                    {
                        let _ = event_notif
                            .send(RuntimeEvent::ElicitationComplete {
                                elicitation_id: elicitation_id.to_string(),
                            })
                            .await;
                    }
                    return Ok(Handled::Yes);
                }
                if let Some((acp_session_id, update)) = session_update_parts(msg.params) {
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
                // Serve permission and elicitation requests; decline everything
                // else so the runtime answers with JSON-RPC -32601 (the headless
                // relay advertises no fs/terminal capabilities).
                if !runtime_serves_request(&msg.method) {
                    return Ok(Handled::No {
                        message: (msg, responder),
                        retry: false,
                    });
                }
                if msg.method == CLIENT_METHOD_NAMES.elicitation_create {
                    let parsed = CreateElicitationRequest::deserialize(&msg.params);
                    let response = match parsed {
                        Ok(_request) => {
                            let acp_session_id = msg
                                .params
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .map(ToString::to_string);
                            let request_route = match msg
                                .params
                                .get("requestId")
                                .and_then(request_id_key)
                            {
                                Some(key) => {
                                    event_request_routes.lock().await.get(&key).cloned()
                                }
                                None => None,
                            };
                            if acp_session_id.is_none() && request_route.is_none() {
                                typed_params(CreateElicitationResponse::new(
                                    ElicitationAction::Cancel,
                                ))
                            } else {
                                let (tx, rx) = oneshot::channel();
                                if event_req
                                    .send(RuntimeEvent::ElicitationRequest {
                                        acp_session_id,
                                        request_route,
                                        params: msg.params,
                                        respond_to: tx,
                                    })
                                    .await
                                    .is_err()
                                {
                                    typed_params(CreateElicitationResponse::new(
                                        ElicitationAction::Cancel,
                                    ))
                                } else {
                                    rx.await.unwrap_or_else(|_| {
                                        typed_params(CreateElicitationResponse::new(
                                            ElicitationAction::Cancel,
                                        ))
                                    })
                                }
                            }
                        }
                        Err(err) => {
                            tracing::warn!(account = %account_req, "invalid elicitation/create: {err}");
                            typed_params(CreateElicitationResponse::new(ElicitationAction::Cancel))
                        }
                    };
                    // Validate the bridge response against the SDK before it reaches the agent.
                    let response = serde_json::from_value::<CreateElicitationResponse>(response)
                        .map(typed_params)
                        .unwrap_or_else(|_| {
                            typed_params(CreateElicitationResponse::new(ElicitationAction::Cancel))
                        });
                    responder.respond(response)?;
                    return Ok(Handled::Yes);
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
                            params: msg.params,
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
            command_loop(cx, cmd_rx, request_routes).await;
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
async fn command_loop(
    cx: ConnectionTo<Agent>,
    mut cmd_rx: mpsc::Receiver<Command>,
    request_routes: RequestRoutes,
) {
    let (prompt_tx, prompt_rx) = mpsc::channel(PROMPT_WORK_QUEUE_CAPACITY);
    let (control_tx, control_rx) = mpsc::channel(CONTROL_WORK_QUEUE_CAPACITY);
    let prompt_worker = tokio::spawn(request_worker(
        cx.clone(),
        prompt_rx,
        request_routes.clone(),
        PROMPT_IN_FLIGHT_LIMIT,
    ));
    let control_worker = tokio::spawn(request_worker(
        cx.clone(),
        control_rx,
        request_routes,
        CONTROL_IN_FLIGHT_LIMIT,
    ));
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            Command::Request {
                method,
                params,
                timeout_ms,
                request_route,
                reply,
            } => {
                let is_prompt = is_prompt_request(&method);
                let command = Command::Request {
                    method,
                    params,
                    timeout_ms,
                    request_route,
                    reply,
                };
                let target = if is_prompt { &prompt_tx } else { &control_tx };
                if let Err(err) = target.try_send(command) {
                    reject_overloaded_command(err.into_inner());
                }
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
    drop(prompt_tx);
    drop(control_tx);
    let _ = prompt_worker.await;
    let _ = control_worker.await;
}

/// Classifies the only long-running request into its reserved concurrency lane.
fn is_prompt_request(method: &str) -> bool {
    method == AGENT_METHOD_NAMES.session_prompt
}

/// Runs a bounded class of ACP requests; queue + semaphore cap tasks and SDK work.
async fn request_worker(
    cx: ConnectionTo<Agent>,
    mut rx: mpsc::Receiver<Command>,
    request_routes: RequestRoutes,
    in_flight_limit: usize,
) {
    let permits = std::sync::Arc::new(Semaphore::new(in_flight_limit));
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(command) = rx.recv().await {
        let permit = match permits.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => {
                reject_overloaded_command(command);
                continue;
            }
        };
        let Command::Request {
            method,
            params,
            timeout_ms,
            request_route,
            reply,
        } = command
        else {
            continue;
        };
        let cx = cx.clone();
        let request_routes = request_routes.clone();
        tasks.spawn(async move {
            let _permit = permit;
            let result = send_request(
                &cx,
                &method,
                params,
                timeout_ms,
                request_route,
                &request_routes,
            )
            .await;
            let _ = reply.send(result);
        });
        while tasks.try_join_next().is_some() {}
    }
    while tasks.join_next().await.is_some() {}
}

/// Fails a saturated request immediately instead of spawning an unbounded waiter.
fn reject_overloaded_command(command: Command) {
    if let Command::Request { method, reply, .. } = command {
        let _ = reply.send(Err(anyhow!(
            "ACP runtime request queue is saturated method={method}"
        )));
    }
}

async fn send_request(
    cx: &ConnectionTo<Agent>,
    method: &str,
    params: Value,
    timeout_ms: u64,
    request_route: Option<RequestRoute>,
    request_routes: &RequestRoutes,
) -> anyhow::Result<Value> {
    let request = UntypedMessage::new(method, params)
        .map_err(|err| anyhow!("ACP request serialize failed method={method}: {err}"))?;
    let sent = cx.send_request(request);
    let route_key = request_route.map(|route| {
        let key = serde_json::to_value(sent.id())
            .ok()
            .as_ref()
            .and_then(request_id_key)
            .expect("SDK request IDs serialize as strings or numbers");
        (key, route)
    });
    if let Some((key, route)) = &route_key {
        request_routes
            .lock()
            .await
            .insert(key.clone(), route.clone());
    }
    let result = match timeout(Duration::from_millis(timeout_ms), sent.block_task()).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(anyhow!("ACP request failed method={method}: {err}")),
        Err(_) => Err(anyhow!("ACP request timeout method={method}")),
    };
    if let Some((key, _)) = route_key {
        request_routes.lock().await.remove(&key);
    }
    result
}

/// Canonical map key for ACP request IDs while preserving string/number distinction.
fn request_id_key(value: &Value) -> Option<String> {
    matches!(value, Value::String(_) | Value::Number(_))
        .then(|| serde_json::to_string(value).ok())
        .flatten()
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
    request_route: Option<RequestRoute>,
) -> anyhow::Result<Value> {
    let (reply_tx, reply_rx) = oneshot::channel();
    cmd_tx
        .send(Command::Request {
            method: method.to_string(),
            params,
            timeout_ms,
            request_route,
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
            AGENT_METHOD_NAMES.session_prompt,
            prompt_params(session_id, prompt),
            timeout_ms,
            None,
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

#[async_trait]
impl PromptClient for RuntimeRequester {
    async fn prompt(
        &self,
        session_id: &str,
        prompt: Vec<Value>,
        timeout_ms: u64,
    ) -> anyhow::Result<PromptResult> {
        RuntimeRequester::prompt(self, session_id, prompt, timeout_ms).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportChoice {
    Official,
    Legacy,
}

fn transport_choice_from(current: Option<&str>, deprecated: Option<&str>) -> TransportChoice {
    match current.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.eq_ignore_ascii_case("legacy") => TransportChoice::Legacy,
        Some(value) if value.eq_ignore_ascii_case("official") => TransportChoice::Official,
        Some(value) => {
            tracing::warn!(value, "invalid CHEERS_ACP_TRANSPORT; using official");
            TransportChoice::Official
        }
        None => match deprecated.map(str::trim) {
            Some("0") | Some("false") | Some("FALSE") => TransportChoice::Legacy,
            Some(_) => TransportChoice::Official,
            None => TransportChoice::Official,
        },
    }
}

/// Build the selected transport behind the real runtime interface. Official is
/// the 0.1.37 default; legacy remains a one-release rollback rail.
pub fn create_runtime(
    account_id: impl Into<String>,
    config: StdioAgentConfig,
    event_tx: mpsc::Sender<RuntimeEvent>,
) -> Box<dyn RuntimeAdapter> {
    let account_id = account_id.into();
    let current = std::env::var("CHEERS_ACP_TRANSPORT").ok();
    let deprecated = std::env::var("CHEERS_ACP_RUNTIME").ok();
    if deprecated.is_some() {
        tracing::warn!(
            "CHEERS_ACP_RUNTIME is deprecated; use CHEERS_ACP_TRANSPORT=official|legacy"
        );
    }
    match transport_choice_from(current.as_deref(), deprecated.as_deref()) {
        TransportChoice::Official => {
            tracing::info!(account = %account_id, transport = "official", "ACP transport selected");
            Box::new(RuntimeAcpAdapter::new(account_id, config, event_tx))
        }
        TransportChoice::Legacy => {
            tracing::warn!(account = %account_id, transport = "legacy", "ACP legacy rollback transport selected");
            Box::new(crate::acp_adapter::AcpAdapter::new(
                account_id, config, event_tx,
            ))
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

    #[test]
    fn official_transport_is_default_with_one_release_legacy_rollback() {
        assert_eq!(transport_choice_from(None, None), TransportChoice::Official);
        assert_eq!(
            transport_choice_from(Some("official"), Some("0")),
            TransportChoice::Official
        );
        assert_eq!(
            transport_choice_from(Some("legacy"), Some("1")),
            TransportChoice::Legacy
        );
        assert_eq!(
            transport_choice_from(None, Some("0")),
            TransportChoice::Legacy
        );
        assert_eq!(
            transport_choice_from(None, Some("1")),
            TransportChoice::Official
        );
    }

    #[test]
    fn typed_prompt_envelope_preserves_unknown_blocks_and_meta() {
        let prompt = vec![json!({
            "type": "future_vendor_block",
            "payload": {"answer": 42},
            "_meta": {"codex": {"params": {"cwd": "/work"}}}
        })];
        let params = prompt_params("session-1", prompt.clone());
        assert_eq!(params["sessionId"], "session-1");
        assert_eq!(params["prompt"], Value::Array(prompt));
    }

    #[test]
    fn typed_session_envelope_preserves_stdio_mcp_fields_verbatim() {
        let mcp_servers = json!([{
            "name": "cheers",
            "command": "/opt/cheers-mcp-server",
            "args": ["--stdio"],
            "env": {"CHEERS_RESOURCE_URL": "http://127.0.0.1:9876/resource"},
            "_meta": {"vendorExtension": true}
        }]);
        let params = session_request_params(
            Some("s1"),
            SessionStartOptions {
                cwd: Some("/work".to_string()),
                additional_dirs: vec!["/shared".to_string()],
                mcp_servers: mcp_servers.clone(),
                request_route: None,
            },
        )
        .expect("typed session params");
        assert_eq!(params["sessionId"], "s1");
        assert_eq!(params["cwd"], "/work");
        assert_eq!(params["additionalDirectories"], json!(["/shared"]));
        assert_eq!(params["mcpServers"], mcp_servers);
    }

    #[test]
    fn typed_stable_requests_keep_existing_wire_shapes() {
        assert_eq!(
            typed_params(SetSessionModeRequest::new("s1", "plan")),
            json!({"sessionId": "s1", "modeId": "plan"})
        );
        assert_eq!(
            typed_params(SetSessionConfigOptionRequest::new(
                "s1",
                "model",
                SessionConfigValueId::new("gpt-5")
            )),
            json!({"sessionId": "s1", "configId": "model", "value": "gpt-5"})
        );
        assert_eq!(
            typed_params(CancelNotification::new("s1")),
            json!({"sessionId": "s1"})
        );
    }

    #[test]
    fn request_id_keys_preserve_json_rpc_id_type() {
        assert_eq!(request_id_key(&json!(12)).as_deref(), Some("12"));
        assert_eq!(request_id_key(&json!("12")).as_deref(), Some("\"12\""));
        assert_eq!(request_id_key(&Value::Null), None);
    }

    #[tokio::test]
    async fn saturated_runtime_request_fails_without_spawning_a_waiter() {
        let (reply, response) = oneshot::channel();
        reject_overloaded_command(Command::Request {
            method: AGENT_METHOD_NAMES.session_prompt.to_string(),
            params: Value::Null,
            timeout_ms: 1,
            request_route: None,
            reply,
        });
        let error = response
            .await
            .expect("overload response")
            .expect_err("error");
        assert!(error.to_string().contains("queue is saturated"));
        assert!(is_prompt_request(AGENT_METHOD_NAMES.session_prompt));
        assert!(!is_prompt_request(AGENT_METHOD_NAMES.session_new));
    }

    // ── ② per-method decline ─────────────────────────────────────────────────
    #[test]
    fn only_session_update_notification_is_served() {
        // session/update is the sole agent→client notification we relay; every
        // other one is declined so the runtime applies its default handling.
        assert!(runtime_serves_notification("session/update"));
        assert!(runtime_serves_notification("elicitation/complete"));
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
        assert!(runtime_serves_request("elicitation/create"));
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
        let (session_id, relayed) = session_update_parts(params).expect("relayed");
        assert_eq!(session_id, "s1");
        assert_eq!(relayed, update); // verbatim — the whole nested _meta survives

        // No usable sessionId → nothing to relay (handler still returns Handled::Yes).
        assert!(session_update_parts(json!({ "sessionId": "", "update": update })).is_none());
        assert!(session_update_parts(json!({ "update": update })).is_none());
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
        let options = crate::acp_semantics::permission_options_from_params(&params);
        assert_eq!(options.len(), 4);
        assert_eq!(options[0].option_id, "allow_once");
        assert_eq!(options[0].kind.as_deref(), Some("allow_once"));
        assert_eq!(options[3].option_id, "reject_once");
        assert_eq!(options[3].kind.as_deref(), Some("reject_once"));
    }
}
