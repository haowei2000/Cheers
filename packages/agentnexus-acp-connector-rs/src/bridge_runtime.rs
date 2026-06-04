#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::env;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use ed25519_dalek::{pkcs8::DecodePrivateKey, Signature, Signer, SigningKey};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use uuid::Uuid;

use crate::acp_adapter::AcpAdapter;
use crate::bridge::{
    AcpCapabilityEnvelope, AcpSecurityHello, AttachmentInfo, ConfigStatusRejectedField,
    ConnectorControlSettings, ControlInbound, ControlOutbound, DataInbound, DataOutbound,
    PermissionResolution, RuntimeSessionAckSession, RuntimeSessionControlSession,
    ServerCapabilities, BRIDGE_PROTOCOL_VERSION,
};
use crate::bridge_session::{
    connect_control_stream, connect_data_stream, BridgeReady, BridgeSession, BridgeSessionConfig,
    BridgeSessionParts,
};
use crate::config::{
    AccountConfig, AcpCapabilityConfig, ConnectorConfig, LocalPolicy, PermissionTimeoutAction,
    PromptPolicy,
};
use crate::loopback::{start_loopback, LoopbackHandle, LoopbackRequest, LoopbackResponse};
use crate::runtime_adapter::{
    PermissionOutcome, RuntimeAdapter, RuntimeEvent, SessionStartOptions,
};
use crate::state::SessionStateStore;

const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub async fn run_connector(config: ConnectorConfig) -> anyhow::Result<()> {
    let mut state = SessionStateStore::new(config.state_path.clone());
    state.load().await?;
    let state = Arc::new(Mutex::new(state));

    let mut join_set = tokio::task::JoinSet::new();
    for (account_id, account) in config.accounts {
        let state = state.clone();
        join_set.spawn(async move { AccountRuntime::new(account_id, account, state).run().await });
    }

    while let Some(result) = join_set.join_next().await {
        result.context("account runtime task panicked")??;
    }
    Ok(())
}

struct AccountRuntime {
    account_id: String,
    config: AccountConfig,
    state: Arc<Mutex<SessionStateStore>>,
}

impl AccountRuntime {
    fn new(
        account_id: String,
        config: AccountConfig,
        state: Arc<Mutex<SessionStateStore>>,
    ) -> Self {
        Self {
            account_id,
            config,
            state,
        }
    }

    async fn run(self) -> anyhow::Result<()> {
        let (runtime_tx, mut runtime_rx) = mpsc::channel(512);
        let (adapter_tx, mut adapter_rx) = mpsc::channel(512);
        let mut adapter = AcpAdapter::new(
            self.account_id.clone(),
            self.config.agent.clone(),
            adapter_tx,
        );
        let initialize_response = adapter.start().await?;
        let adapter = Arc::new(Mutex::new(adapter));

        let (loopback, mut loopback_rx) = start_loopback().await?;
        let bridge_ready = bridge_ready_from_initialize(&initialize_response, &self.config.policy);
        let bridge_config = BridgeSessionConfig::new(
            self.account_id.clone(),
            self.config.bot_token.clone(),
            self.config.control_url.clone(),
            self.config.data_url.clone(),
        )
        .with_advanced(
            self.config.advanced.reconnect_base_ms,
            self.config.advanced.reconnect_max_ms,
            self.config.advanced.heartbeat_interval_ms,
            self.config.advanced.send_ack_timeout_ms,
        );
        let bridge = BridgeSession::connect(bridge_config.clone(), bridge_ready.clone()).await?;
        let initial_connector_config = bridge.control_hello().connector_config.clone();
        let security = bridge.data_hello().acp_security.clone();
        let signer = CapabilitySigner::from_config(self.config.acp_capability.clone(), security)?;
        let io = spawn_bridge_io(
            bridge,
            bridge_config,
            bridge_ready,
            runtime_tx.clone(),
            signer,
        );

        {
            let runtime_tx = runtime_tx.clone();
            tokio::spawn(async move {
                while let Some(event) = adapter_rx.recv().await {
                    if runtime_tx.send(RuntimeInput::Adapter(event)).await.is_err() {
                        break;
                    }
                }
            });
        }
        {
            let runtime_tx = runtime_tx.clone();
            tokio::spawn(async move {
                while let Some(request) = loopback_rx.recv().await {
                    if runtime_tx
                        .send(RuntimeInput::Loopback(request))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }

        let shared = Arc::new(Mutex::new(SharedRuntimeState::default()));
        let adapter_for_stop = adapter.clone();
        let context = Arc::new(RuntimeContext {
            account_id: self.account_id,
            config: self.config,
            state: self.state,
            adapter,
            loopback,
            io,
            shared,
        });
        tracing::info!(account = %context.account_id, "Rust BridgeRuntime started");
        if let Some(config) = initial_connector_config {
            if config.settings.is_some() {
                context
                    .clone()
                    .handle_config_update(config.revision, config.settings)
                    .await?;
            }
        }
        let result = context.run_loop(&mut runtime_rx).await;
        let _ = adapter_for_stop.lock().await.stop().await;
        result
    }
}

struct RuntimeContext {
    account_id: String,
    config: AccountConfig,
    state: Arc<Mutex<SessionStateStore>>,
    adapter: Arc<Mutex<AcpAdapter>>,
    loopback: LoopbackHandle,
    io: BridgeIoHandle,
    shared: Arc<Mutex<SharedRuntimeState>>,
}

impl RuntimeContext {
    async fn run_loop(
        self: Arc<Self>,
        rx: &mut mpsc::Receiver<RuntimeInput>,
    ) -> anyhow::Result<()> {
        while let Some(input) = rx.recv().await {
            match input {
                RuntimeInput::Control(frame) => {
                    self.clone().handle_control(frame).await?;
                }
                RuntimeInput::Data(frame) => {
                    self.clone().handle_data(frame).await?;
                }
                RuntimeInput::Adapter(event) => {
                    self.clone().handle_adapter_event(event).await?;
                }
                RuntimeInput::Loopback(request) => {
                    let runtime = self.clone();
                    tokio::spawn(async move {
                        if let Err(err) = runtime.handle_loopback_request(request).await {
                            tracing::warn!("loopback request failed: {err}");
                        }
                    });
                }
                RuntimeInput::SocketClosed(stream) => {
                    return Err(anyhow!("Agent Bridge {stream} stream closed"));
                }
                RuntimeInput::SocketError { stream, error } => {
                    return Err(anyhow!("Agent Bridge {stream} stream error: {error}"));
                }
            }
        }
        Err(anyhow!("BridgeRuntime event channel closed"))
    }

    async fn handle_control(self: Arc<Self>, frame: ControlInbound) -> anyhow::Result<()> {
        match frame {
            ControlInbound::Task {
                task_id,
                channel_id,
                placeholder_msg_id,
                provider_session_key,
                session_id,
                trigger_message,
                attachments,
                ..
            } => {
                let task = TaskCommand {
                    task_id,
                    channel_id,
                    msg_id: placeholder_msg_id,
                    provider_session_key,
                    session_id,
                    trigger_message,
                    attachments,
                };
                let runtime = self.clone();
                tokio::spawn(async move {
                    if let Err(err) = runtime.run_task(task).await {
                        tracing::error!("task failed: {err}");
                    }
                });
            }
            ControlInbound::Cancel { msg_id, reason } => {
                self.handle_cancel(&msg_id, reason.as_deref()).await?;
            }
            ControlInbound::RuntimeSessionControl {
                request_id,
                action,
                session,
                ..
            } => {
                self.handle_runtime_session_control(request_id, action, session)
                    .await?;
            }
            ControlInbound::ConfigUpdate {
                revision, settings, ..
            } => {
                self.handle_config_update(revision, settings).await?;
            }
            ControlInbound::ConfigOptionSet {
                request_id,
                session_id,
                provider_session_key,
                config_id,
                value,
                ..
            } => {
                self.handle_config_option_set(
                    request_id,
                    session_id,
                    provider_session_key,
                    config_id,
                    value,
                )
                .await?;
            }
            ControlInbound::PermissionResolution { resolution, .. } => {
                self.handle_permission_resolution(resolution).await?;
            }
            ControlInbound::Pong | ControlInbound::Unknown => {}
            ControlInbound::Hello { .. }
            | ControlInbound::ChannelJoined { .. }
            | ControlInbound::ChannelLeft { .. }
            | ControlInbound::Error { .. } => {}
        }
        Ok(())
    }

    async fn handle_data(self: Arc<Self>, frame: DataInbound) -> anyhow::Result<()> {
        let ack_was_pending = self.io.resolve_data_ack(&frame).await;
        match frame {
            DataInbound::ResourceRes { response } => {
                if let Some(tx) = self
                    .shared
                    .lock()
                    .await
                    .pending_resources
                    .remove(&response.req_id)
                {
                    let _ = tx.send(LoopbackResponse {
                        ok: response.ok,
                        data: response.data,
                        error: response.error,
                        code: response.code,
                    });
                }
            }
            DataInbound::SendAck {
                permission_resolution,
                ..
            } => {
                if !ack_was_pending {
                    if let Some(value) = permission_resolution {
                        if let Ok(resolution) =
                            serde_json::from_value::<PermissionResolution>(value)
                        {
                            self.handle_permission_resolution(resolution).await?;
                        }
                    }
                }
            }
            DataInbound::Pong
            | DataInbound::ResumeAck { .. }
            | DataInbound::TerminalAck { .. }
            | DataInbound::FileUploadAck { .. }
            | DataInbound::Unknown
            | DataInbound::Hello { .. }
            | DataInbound::Error { .. } => {}
        }
        Ok(())
    }

    async fn handle_adapter_event(self: Arc<Self>, event: RuntimeEvent) -> anyhow::Result<()> {
        match event {
            RuntimeEvent::SessionUpdate {
                acp_session_id,
                update,
            } => {
                self.handle_session_update(acp_session_id, update).await?;
            }
            RuntimeEvent::PermissionRequest {
                acp_session_id,
                params,
                respond_to,
            } => {
                let runtime = self.clone();
                tokio::spawn(async move {
                    if let Err(err) = runtime
                        .handle_permission_request(acp_session_id, params, respond_to)
                        .await
                    {
                        tracing::warn!("permission request failed: {err}");
                    }
                });
            }
            RuntimeEvent::AdapterError { message } => {
                tracing::warn!(account = %self.account_id, "ACP adapter error: {message}");
            }
        }
        Ok(())
    }

    async fn handle_loopback_request(
        self: Arc<Self>,
        request: LoopbackRequest,
    ) -> anyhow::Result<()> {
        if !self.loopback_resource_allowed(&request.resource) {
            let _ = request.respond_to.send(LoopbackResponse {
                ok: false,
                data: None,
                error: Some(format!(
                    "local daemon policy does not allow resource {}",
                    request.resource
                )),
                code: Some("LOCAL_POLICY_DENIED".to_string()),
            });
            return Ok(());
        }
        let (tx, rx) = oneshot::channel();
        self.shared
            .lock()
            .await
            .pending_resources
            .insert(request.req_id.clone(), tx);
        self.io
            .send_data(DataOutbound::ResourceReq {
                v: BRIDGE_PROTOCOL_VERSION,
                req_id: request.req_id.clone(),
                resource: request.resource,
                params: request.params,
                session_id: request.session_id,
                encrypted: None,
                encrypted_payload: None,
                acp_capability: None,
            })
            .await?;
        let response = timeout(
            Duration::from_millis(self.config.policy.loopback.request_timeout_ms),
            rx,
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| LoopbackResponse {
            ok: false,
            data: None,
            error: Some("resource response timed out".to_string()),
            code: Some("RESOURCE_TIMEOUT".to_string()),
        });
        let _ = request.respond_to.send(response);
        Ok(())
    }

    async fn run_task(self: Arc<Self>, task: TaskCommand) -> anyhow::Result<()> {
        if !self.config.policy.prompt.allow {
            let _ = self
                .io
                .send_data_expect_terminal_ack(DataOutbound::Error {
                    v: BRIDGE_PROTOCOL_VERSION,
                    client_msg_id: Uuid::new_v4().to_string(),
                    msg_id: task.msg_id.clone(),
                    message: "local daemon policy does not allow prompts".to_string(),
                    provider_session_key: Some(task.provider_session_key.clone()),
                    provider_session_id: None,
                    session_id: task.session_id.clone(),
                    acp_capability: None,
                })
                .await;
            return Ok(());
        }
        let session_lock = self.session_lock(&task.provider_session_key).await;
        let _guard = session_lock.lock().await;
        let start_options = SessionStartOptions {
            cwd: self
                .config
                .agent
                .cwd
                .as_ref()
                .map(|path| path.display().to_string()),
            mcp_servers: self.mcp_servers_for_task(&task),
        };
        let acp_session_id = self.ensure_acp_session(&task, start_options).await?;
        let run = Arc::new(Mutex::new(ActiveRun {
            task_id: task.task_id.clone(),
            msg_id: task.msg_id.clone(),
            channel_id: task.channel_id.clone(),
            provider_session_key: task.provider_session_key.clone(),
            acp_session_id: acp_session_id.clone(),
            session_id: task.session_id.clone(),
            delta_seq: 0,
            trace_seq: 0,
            text: String::new(),
        }));
        {
            let mut shared = self.shared.lock().await;
            shared.by_msg.insert(task.msg_id.clone(), run.clone());
            shared
                .by_acp_session
                .insert(acp_session_id.clone(), run.clone());
            shared
                .by_provider_key
                .insert(task.provider_session_key.clone(), run.clone());
        }
        self.trace(
            &run,
            "prompt_started",
            "running",
            "ACP prompt started",
            None,
        )
        .await?;
        let prompt = build_prompt(&task, &self.config.policy.prompt);
        let prompt_size = serde_json::to_vec(&prompt)?.len();
        if prompt_size > self.config.policy.prompt.max_prompt_bytes {
            self.io
                .send_data_expect_terminal_ack(DataOutbound::Error {
                    v: BRIDGE_PROTOCOL_VERSION,
                    client_msg_id: Uuid::new_v4().to_string(),
                    msg_id: task.msg_id.clone(),
                    message: format!(
                        "local daemon policy rejected prompt size {} > {} bytes",
                        prompt_size, self.config.policy.prompt.max_prompt_bytes
                    ),
                    provider_session_key: Some(task.provider_session_key.clone()),
                    provider_session_id: Some(acp_session_id.clone()),
                    session_id: task.session_id.clone(),
                    acp_capability: None,
                })
                .await?;
            let mut shared = self.shared.lock().await;
            shared.by_msg.remove(&task.msg_id);
            shared.by_acp_session.remove(&acp_session_id);
            shared.by_provider_key.remove(&task.provider_session_key);
            return Ok(());
        }
        let prompt_result = {
            let mut adapter = self.adapter.lock().await;
            adapter
                .prompt(&acp_session_id, prompt, self.config.agent.prompt_timeout_ms)
                .await
        };

        match prompt_result {
            Ok(result) => {
                self.trace(
                    &run,
                    "prompt_finished",
                    if result.stop_reason.as_deref() == Some("cancelled") {
                        "cancelled"
                    } else {
                        "completed"
                    },
                    "ACP prompt finished",
                    result.stop_reason.as_deref(),
                )
                .await?;
                let final_text = run.lock().await.text.clone();
                let terminal_ack = self
                    .io
                    .send_data_expect_terminal_ack(DataOutbound::Done {
                        v: BRIDGE_PROTOCOL_VERSION,
                        client_msg_id: Uuid::new_v4().to_string(),
                        msg_id: task.msg_id.clone(),
                        file_ids: Vec::new(),
                        mention_ids: Vec::new(),
                        content: Some(final_text),
                        provider_session_key: Some(task.provider_session_key.clone()),
                        provider_session_id: Some(acp_session_id.clone()),
                        session_id: task.session_id.clone(),
                        acp_capability: None,
                    })
                    .await?;
                if !terminal_ack_ok(&terminal_ack) {
                    self.trace(
                        &run,
                        "terminal_ack_failed",
                        "error",
                        "Agent Bridge rejected done frame",
                        terminal_ack_error(&terminal_ack).as_deref(),
                    )
                    .await?;
                }
            }
            Err(err) => {
                let message = err.to_string();
                self.trace(
                    &run,
                    "prompt_failed",
                    "error",
                    "ACP prompt failed",
                    Some(&message),
                )
                .await?;
                let terminal_ack = self
                    .io
                    .send_data_expect_terminal_ack(DataOutbound::Error {
                        v: BRIDGE_PROTOCOL_VERSION,
                        client_msg_id: Uuid::new_v4().to_string(),
                        msg_id: task.msg_id.clone(),
                        message,
                        provider_session_key: Some(task.provider_session_key.clone()),
                        provider_session_id: Some(acp_session_id.clone()),
                        session_id: task.session_id.clone(),
                        acp_capability: None,
                    })
                    .await?;
                if !terminal_ack_ok(&terminal_ack) {
                    self.trace(
                        &run,
                        "terminal_ack_failed",
                        "error",
                        "Agent Bridge rejected error frame",
                        terminal_ack_error(&terminal_ack).as_deref(),
                    )
                    .await?;
                }
            }
        }

        let mut shared = self.shared.lock().await;
        shared.by_msg.remove(&task.msg_id);
        shared.by_acp_session.remove(&acp_session_id);
        shared.by_provider_key.remove(&task.provider_session_key);
        Ok(())
    }

    async fn ensure_acp_session(
        &self,
        task: &TaskCommand,
        options: SessionStartOptions,
    ) -> anyhow::Result<String> {
        let existing = self
            .state
            .lock()
            .await
            .get(&self.account_id, &task.provider_session_key);
        if let Some(session_id) = existing {
            let supports_load = self.adapter.lock().await.supports_load_session();
            if supports_load && self.config.policy.sessions.load {
                let mut adapter = self.adapter.lock().await;
                if adapter
                    .load_session(&session_id, options.clone())
                    .await
                    .is_ok()
                {
                    self.report_provider_session(&task.provider_session_key, &session_id)
                        .await?;
                    return Ok(session_id);
                }
            }
        }
        if !self.config.policy.sessions.create {
            return Err(anyhow!(
                "local daemon policy does not allow ACP session creation"
            ));
        }
        let new_session = {
            let mut adapter = self.adapter.lock().await;
            adapter.new_session(options).await?
        };
        self.state
            .lock()
            .await
            .set(
                &self.account_id,
                &task.provider_session_key,
                &new_session.session_id,
            )
            .await?;
        self.report_provider_session(&task.provider_session_key, &new_session.session_id)
            .await?;
        Ok(new_session.session_id)
    }

    async fn report_provider_session(
        &self,
        provider_session_key: &str,
        provider_session_id: &str,
    ) -> anyhow::Result<()> {
        if !self.config.policy.session_update.allow {
            return Ok(());
        }
        self.io
            .send_data(DataOutbound::SessionUpdate {
                v: BRIDGE_PROTOCOL_VERSION,
                provider_session_key: Some(provider_session_key.to_string()),
                provider_session_id: Some(provider_session_id.to_string()),
                metadata: self
                    .config
                    .policy
                    .session_update
                    .include_metadata
                    .then(|| {
                        json!({
                            "account_id": self.account_id.clone(),
                            "command": self.config.agent.command.clone(),
                            "cwd": self.config.agent.cwd.as_ref().map(|path| path.display().to_string()),
                        })
                    }),
                acp_capability: None,
            })
            .await
    }

    async fn handle_cancel(&self, msg_id: &str, reason: Option<&str>) -> anyhow::Result<()> {
        if !self.config.policy.sessions.cancel {
            tracing::warn!(
                account = %self.account_id,
                msg_id = %msg_id,
                "local daemon policy rejected cancel"
            );
            return Ok(());
        }
        let run = self.shared.lock().await.by_msg.get(msg_id).cloned();
        let Some(run) = run else {
            return Ok(());
        };
        let acp_session_id = run.lock().await.acp_session_id.clone();
        tracing::warn!(
            account = %self.account_id,
            acp_session_id = %acp_session_id,
            reason = reason.unwrap_or(""),
            "cancelling ACP prompt"
        );
        self.adapter.lock().await.cancel(&acp_session_id).await
    }

    async fn handle_runtime_session_control(
        &self,
        request_id: String,
        action: String,
        session: RuntimeSessionControlSession,
    ) -> anyhow::Result<()> {
        let result = match action.as_str() {
            "create" | "resume" => {
                let task = TaskCommand {
                    task_id: session
                        .task_scope_id
                        .clone()
                        .unwrap_or_else(|| request_id.clone()),
                    channel_id: session.primary_scope_id.clone().unwrap_or_default(),
                    msg_id: session.id.clone(),
                    provider_session_key: session.provider_session_key.clone(),
                    session_id: Some(session.id.clone()),
                    trigger_message: None,
                    attachments: Vec::new(),
                };
                let options = SessionStartOptions {
                    cwd: self
                        .config
                        .agent
                        .cwd
                        .as_ref()
                        .map(|path| path.display().to_string()),
                    mcp_servers: self.mcp_servers_for_task(&task),
                };
                self.ensure_acp_session(&task, options).await.map(|id| {
                    (
                        true,
                        Some(RuntimeSessionAckSession {
                            id: Some(session.id.clone()),
                            session_id: Some(session.id.clone()),
                            provider_session_key: Some(session.provider_session_key.clone()),
                            provider_session_id: Some(id),
                            status: Some("active".to_string()),
                            extra: Default::default(),
                        }),
                        None,
                    )
                })
            }
            "pause" => Ok((
                true,
                Some(RuntimeSessionAckSession {
                    id: Some(session.id.clone()),
                    session_id: Some(session.id.clone()),
                    provider_session_key: Some(session.provider_session_key.clone()),
                    provider_session_id: self
                        .state
                        .lock()
                        .await
                        .get(&self.account_id, &session.provider_session_key),
                    status: Some("paused".to_string()),
                    extra: Default::default(),
                }),
                None,
            )),
            "terminate" => {
                if !self.config.policy.sessions.terminate {
                    Ok((
                        false,
                        None,
                        Some("local daemon policy does not allow session terminate".to_string()),
                    ))
                } else {
                    if let Some(acp_id) = self
                        .state
                        .lock()
                        .await
                        .get(&self.account_id, &session.provider_session_key)
                    {
                        let _ = self.adapter.lock().await.cancel(&acp_id).await;
                    }
                    self.state
                        .lock()
                        .await
                        .remove(&self.account_id, &session.provider_session_key)
                        .await?;
                    Ok((
                        true,
                        Some(RuntimeSessionAckSession {
                            id: Some(session.id.clone()),
                            session_id: Some(session.id.clone()),
                            provider_session_key: Some(session.provider_session_key.clone()),
                            provider_session_id: None,
                            status: Some("terminated".to_string()),
                            extra: Default::default(),
                        }),
                        None,
                    ))
                }
            }
            other => Ok((false, None, Some(format!("unsupported action: {other}")))),
        };

        let (ok, ack_session, error) = match result {
            Ok(value) => value,
            Err(err) => (false, None, Some(err.to_string())),
        };
        self.io
            .send_control(ControlOutbound::RuntimeSessionControlAck {
                v: BRIDGE_PROTOCOL_VERSION,
                request_id,
                action,
                ok,
                session: ack_session,
                applied_at: Some(Utc::now().to_rfc3339()),
                code: if ok {
                    None
                } else {
                    Some("RUNTIME_SESSION_CONTROL_FAILED".to_string())
                },
                error,
                retryable: Some(false),
            })
            .await
    }

    async fn handle_config_update(
        &self,
        revision: Option<Value>,
        settings: Option<ConnectorControlSettings>,
    ) -> anyhow::Result<()> {
        let Some(settings) = settings else {
            self.io
                .send_control(ControlOutbound::ConfigStatus {
                    v: BRIDGE_PROTOCOL_VERSION,
                    revision,
                    ok: true,
                    applied: Vec::new(),
                    rejected: Vec::new(),
                })
                .await?;
            return Ok(());
        };
        let (settings, mut rejected) = self.filter_settings_by_policy(settings);
        let result = self.adapter.lock().await.apply_settings(&settings).await?;
        rejected.extend(result.rejected);
        self.io
            .send_control(ControlOutbound::ConfigStatus {
                v: BRIDGE_PROTOCOL_VERSION,
                revision,
                ok: rejected.is_empty(),
                applied: result.applied,
                rejected,
            })
            .await
    }

    fn filter_settings_by_policy(
        &self,
        mut settings: ConnectorControlSettings,
    ) -> (ConnectorControlSettings, Vec<ConfigStatusRejectedField>) {
        let mut rejected = Vec::new();
        if settings.agentnexus_approval_mode.take().is_some()
            || settings.permission_mode.take().is_some()
        {
            rejected.push(ConfigStatusRejectedField {
                field: "agentnexusApprovalMode".to_string(),
                reason: "platform permission is resolved by Backend permission_resolution, not local daemon config".to_string(),
            });
        }
        if let Some(cwd) = settings.cwd.take() {
            match self.validate_backend_cwd(&cwd) {
                Ok(path) => settings.cwd = Some(path.display().to_string()),
                Err(reason) => rejected.push(ConfigStatusRejectedField {
                    field: "cwd".to_string(),
                    reason,
                }),
            }
        }
        if settings.model.is_some() && !self.config.policy.config.backend_may_set_model {
            settings.model = None;
            rejected.push(ConfigStatusRejectedField {
                field: "model".to_string(),
                reason: "local daemon policy does not allow Backend to set model".to_string(),
            });
        }
        if settings.agent_native_permission_mode.is_some()
            && !self.config.policy.config.backend_may_set_native_options
        {
            settings.agent_native_permission_mode = None;
            rejected.push(ConfigStatusRejectedField {
                field: "agentNativePermissionMode".to_string(),
                reason: "local daemon policy does not allow Backend to set native options"
                    .to_string(),
            });
        }
        (settings, rejected)
    }

    fn validate_backend_cwd(&self, cwd: &str) -> Result<PathBuf, String> {
        if !self.config.policy.workspace.backend_may_set_cwd {
            return Err("local daemon policy does not allow Backend to set cwd".to_string());
        }
        let path = PathBuf::from(cwd);
        if !path.is_absolute() {
            return Err("cwd must be an absolute path".to_string());
        }
        let canonical = path
            .canonicalize()
            .map_err(|err| format!("cwd cannot be canonicalized: {err}"))?;
        if self.config.policy.workspace.allowed_roots.is_empty()
            || !self
                .config
                .policy
                .workspace
                .allowed_roots
                .iter()
                .any(|root| canonical.starts_with(root))
        {
            return Err("cwd is outside local allowed workspace roots".to_string());
        }
        Ok(canonical)
    }

    async fn handle_config_option_set(
        &self,
        request_id: String,
        session_id: Option<String>,
        provider_session_key: Option<String>,
        config_id: String,
        value: String,
    ) -> anyhow::Result<()> {
        if !self.config_option_allowed(&config_id) {
            self.io
                .send_control(ControlOutbound::ConfigOptionStatus {
                    v: BRIDGE_PROTOCOL_VERSION,
                    request_id,
                    ok: false,
                    session_id,
                    provider_session_key,
                    config_id: Some(config_id),
                    value: Some(value),
                    options: None,
                    error: Some(
                        "local daemon policy does not allow this ACP config option".to_string(),
                    ),
                    code: Some("LOCAL_POLICY_DENIED".to_string()),
                })
                .await?;
            return Ok(());
        }
        let acp_session_id = match (&session_id, &provider_session_key) {
            (Some(id), _) => Some(id.clone()),
            (_, Some(key)) => self.state.lock().await.get(&self.account_id, key),
            _ => None,
        };
        let Some(acp_session_id) = acp_session_id else {
            self.io
                .send_control(ControlOutbound::ConfigOptionStatus {
                    v: BRIDGE_PROTOCOL_VERSION,
                    request_id,
                    ok: false,
                    session_id,
                    provider_session_key,
                    config_id: Some(config_id),
                    value: Some(value),
                    options: None,
                    error: Some("runtime session is not active".to_string()),
                    code: Some("SESSION_NOT_FOUND".to_string()),
                })
                .await?;
            return Ok(());
        };
        let result = self
            .adapter
            .lock()
            .await
            .set_config_option(&acp_session_id, &config_id, &value)
            .await;
        match result {
            Ok(options) => {
                self.io
                    .send_control(ControlOutbound::ConfigOptionStatus {
                        v: BRIDGE_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        session_id,
                        provider_session_key,
                        config_id: Some(config_id),
                        value: Some(value),
                        options: Some(options),
                        error: None,
                        code: None,
                    })
                    .await
            }
            Err(err) => {
                self.io
                    .send_control(ControlOutbound::ConfigOptionStatus {
                        v: BRIDGE_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        session_id,
                        provider_session_key,
                        config_id: Some(config_id),
                        value: Some(value),
                        options: None,
                        error: Some(err.to_string()),
                        code: Some("CONFIG_OPTION_FAILED".to_string()),
                    })
                    .await
            }
        }
    }

    fn config_option_allowed(&self, config_id: &str) -> bool {
        self.config
            .policy
            .config
            .allowed_config_options
            .iter()
            .any(|item| item == config_id)
    }

    async fn handle_session_update(
        &self,
        acp_session_id: String,
        update: Value,
    ) -> anyhow::Result<()> {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if matches!(
            kind,
            "config_option_update" | "current_mode_update" | "available_commands_update"
        ) {
            self.io
                .send_control(ControlOutbound::ConfigOptions {
                    v: BRIDGE_PROTOCOL_VERSION,
                    options: normalize_config_options_report(&update),
                })
                .await?;
        }

        let run = self
            .shared
            .lock()
            .await
            .by_acp_session
            .get(&acp_session_id)
            .cloned();
        let Some(run) = run else {
            return Ok(());
        };
        if kind == "agent_message_chunk" {
            if let Some(text) = text_from_content(update.get("content").unwrap_or(&Value::Null)) {
                let mut guard = run.lock().await;
                guard.delta_seq += 1;
                guard.text.push_str(&text);
                self.io
                    .send_data(DataOutbound::Delta {
                        v: BRIDGE_PROTOCOL_VERSION,
                        msg_id: guard.msg_id.clone(),
                        seq: guard.delta_seq,
                        delta: text,
                        provider_session_key: Some(guard.provider_session_key.clone()),
                        provider_session_id: Some(guard.acp_session_id.clone()),
                        session_id: guard.session_id.clone(),
                        acp_capability: None,
                    })
                    .await?;
            }
        } else {
            let summary = update_summary(&update);
            self.trace(&run, kind, "running", "ACP session update", Some(&summary))
                .await?;
        }
        Ok(())
    }

    async fn handle_permission_request(
        self: Arc<Self>,
        acp_session_id: String,
        params: Value,
        respond_to: oneshot::Sender<PermissionOutcome>,
    ) -> anyhow::Result<()> {
        let run = self
            .shared
            .lock()
            .await
            .by_acp_session
            .get(&acp_session_id)
            .cloned();
        let Some(run) = run else {
            let _ = respond_to.send(PermissionOutcome::Cancelled);
            return Ok(());
        };
        if !self.config.policy.permission.forward_to_backend {
            self.trace(
                &run,
                "permission_rejected",
                "cancelled",
                "Local daemon policy does not forward permission requests",
                None,
            )
            .await?;
            let _ = respond_to.send(PermissionOutcome::Cancelled);
            return Ok(());
        }
        let request_id = Uuid::new_v4().to_string();
        let body = permission_body_from_params(&params);
        let (channel_id, task_id, msg_id, provider_session_key, session_id) = {
            let guard = run.lock().await;
            (
                guard.channel_id.clone(),
                guard.task_id.clone(),
                guard.msg_id.clone(),
                guard.provider_session_key.clone(),
                guard.session_id.clone(),
            )
        };
        let options = self.adapter.lock().await.permission_options(&params);
        self.shared
            .lock()
            .await
            .pending_permissions
            .insert(request_id.clone(), PendingPermission { params, respond_to });
        let timeout_runtime = self.clone();
        let timeout_request_id = request_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(
                timeout_runtime.config.policy.permission.wait_timeout_ms,
            ))
            .await;
            timeout_runtime
                .handle_permission_timeout(timeout_request_id)
                .await;
        });
        let ack = self
            .io
            .send_data_expect_send_ack(DataOutbound::PermissionRequest {
                v: BRIDGE_PROTOCOL_VERSION,
                client_msg_id: Uuid::new_v4().to_string(),
                channel_id,
                request_id: request_id.clone(),
                task_id: Some(task_id),
                msg_id: Some(msg_id),
                acp_session_id: Some(acp_session_id.clone()),
                provider_session_key: Some(provider_session_key),
                provider_session_id: Some(acp_session_id),
                session_id,
                title: Some("ACP permission request".to_string()),
                body,
                tool: None,
                options,
                acp_capability: None,
            })
            .await;
        match ack {
            Ok(DataInbound::SendAck {
                ok: true,
                permission_resolution,
                ..
            }) => {
                if let Some(value) = permission_resolution {
                    if let Ok(resolution) = serde_json::from_value::<PermissionResolution>(value) {
                        self.handle_permission_resolution(resolution).await?;
                    }
                }
            }
            Ok(frame) => {
                let message = send_ack_error(&frame).unwrap_or_else(|| {
                    "permission request was rejected by Agent Bridge".to_string()
                });
                let pending = self
                    .shared
                    .lock()
                    .await
                    .pending_permissions
                    .remove(&request_id);
                if let Some(pending) = pending {
                    let _ = pending.respond_to.send(PermissionOutcome::Cancelled);
                }
                tracing::warn!(
                    account = %self.account_id,
                    request_id = %request_id,
                    "Agent Bridge permission request send_ack failed: {message}"
                );
            }
            Err(err) => {
                let pending = self
                    .shared
                    .lock()
                    .await
                    .pending_permissions
                    .remove(&request_id);
                if let Some(pending) = pending {
                    let _ = pending.respond_to.send(PermissionOutcome::Cancelled);
                }
                tracing::warn!(
                    account = %self.account_id,
                    request_id = %request_id,
                    "Agent Bridge permission request send_ack timeout/error: {err}"
                );
            }
        }
        Ok(())
    }

    async fn handle_permission_timeout(&self, request_id: String) {
        let pending = self
            .shared
            .lock()
            .await
            .pending_permissions
            .remove(&request_id);
        let Some(pending) = pending else {
            return;
        };
        let action = self.config.policy.permission.on_timeout;
        let outcome = match action {
            PermissionTimeoutAction::Cancel | PermissionTimeoutAction::Deny => {
                PermissionOutcome::Cancelled
            }
        };
        let _ = pending.respond_to.send(outcome);
        tracing::warn!(
            account = %self.account_id,
            request_id = %request_id,
            action = ?action,
            "ACP permission request timed out waiting for Backend resolution"
        );
    }

    async fn handle_permission_resolution(
        &self,
        resolution: PermissionResolution,
    ) -> anyhow::Result<()> {
        let pending = self
            .shared
            .lock()
            .await
            .pending_permissions
            .remove(&resolution.request_id);
        let Some(pending) = pending else {
            return Ok(());
        };
        let outcome = if resolution.resolution == "allow" {
            resolution
                .option_id
                .clone()
                .or_else(|| permission_option_id_for_resolution(&pending.params, "allow"))
                .map(|option_id| PermissionOutcome::Selected { option_id })
                .unwrap_or(PermissionOutcome::Cancelled)
        } else {
            PermissionOutcome::Cancelled
        };
        let _ = pending.respond_to.send(outcome);
        Ok(())
    }

    async fn session_lock(&self, provider_session_key: &str) -> Arc<Mutex<()>> {
        let mut shared = self.shared.lock().await;
        shared
            .session_locks
            .entry(provider_session_key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn mcp_servers_for_task(&self, task: &TaskCommand) -> Value {
        let mut servers = self
            .config
            .agent
            .mcp_servers
            .as_array()
            .cloned()
            .unwrap_or_default();
        if self.config.policy.mcp.inject_agentnexus {
            servers.push(json!({
                "name": "agentnexus",
                "command": resolve_mcp_server_command(),
                "args": [],
                "env": {
                    "AGENTNEXUS_RESOURCE_URL": self.loopback.url.clone(),
                    "AGENTNEXUS_RESOURCE_TOKEN": self.loopback.token.clone(),
                    "AGENTNEXUS_CHANNEL_ID": task.channel_id.clone(),
                    "AGENTNEXUS_BOT_ID": self.account_id.clone(),
                    // Platform session UUID — forwarded into resource_req so the server
                    // can perform Grant authorization on write operations.
                    "AGENTNEXUS_SESSION_ID": task.session_id.clone().unwrap_or_default(),
                    "AGENTNEXUS_REQUEST_TIMEOUT_MS": self.config.policy.loopback.request_timeout_ms.to_string()
                }
            }));
        }
        Value::Array(servers)
    }

    fn loopback_resource_allowed(&self, resource: &str) -> bool {
        // Explicit deny always wins.
        if self
            .config
            .policy
            .loopback
            .deny_resources
            .iter()
            .any(|item| item == resource)
        {
            return false;
        }
        // Explicit allow list takes precedence over the auto-allow below.
        if self
            .config
            .policy
            .loopback
            .allowed_resources
            .iter()
            .any(|item| item == resource)
        {
            return true;
        }
        // When inject_agentnexus is enabled and the user has not configured an
        // explicit allowed_resources list, automatically permit the read-only
        // resources that the injected MCP server uses. Write resources (anything
        // that modifies state) remain opt-in via allowed_resources.
        if self.config.policy.mcp.inject_agentnexus
            && self.config.policy.loopback.allowed_resources.is_empty()
        {
            const MCP_READ_RESOURCES: &[&str] = &[
                "channel.info",
                "channel.members",
                "channel.messages",
                "channel.messages.index",
                "channel.messages.by-seq",
                "channel.activity.read",
                "channel.files",
                "channel.files.read",
                "channel.context",
                "fs.ls",
                "fs.read",
            ];
            return MCP_READ_RESOURCES.contains(&resource);
        }
        false
    }

    async fn trace(
        &self,
        run: &Arc<Mutex<ActiveRun>>,
        phase: &str,
        status: &str,
        title: &str,
        message: Option<&str>,
    ) -> anyhow::Result<()> {
        if !self.config.policy.trace.allow {
            return Ok(());
        }
        let message = message
            .map(|value| limit_text_bytes(value, self.config.policy.trace.max_message_bytes));
        let mut guard = run.lock().await;
        guard.trace_seq += 1;
        self.io
            .send_data(DataOutbound::Trace {
                v: BRIDGE_PROTOCOL_VERSION,
                msg_id: guard.msg_id.clone(),
                task_id: Some(guard.task_id.clone()),
                channel_id: Some(guard.channel_id.clone()),
                run_id: Some(guard.acp_session_id.clone()),
                session_key: Some(guard.provider_session_key.clone()),
                provider_session_key: Some(guard.provider_session_key.clone()),
                provider_session_id: Some(guard.acp_session_id.clone()),
                session_id: guard.session_id.clone(),
                stream: "acp".to_string(),
                seq: Some(guard.trace_seq),
                ts: Some(Utc::now().timestamp()),
                phase: Some(phase.to_string()),
                status: Some(status.to_string()),
                title: Some(title.to_string()),
                message,
                data: None,
                acp_capability: None,
            })
            .await
    }
}

#[derive(Default)]
struct SharedRuntimeState {
    by_msg: HashMap<String, Arc<Mutex<ActiveRun>>>,
    by_acp_session: HashMap<String, Arc<Mutex<ActiveRun>>>,
    by_provider_key: HashMap<String, Arc<Mutex<ActiveRun>>>,
    pending_permissions: HashMap<String, PendingPermission>,
    pending_resources: HashMap<String, oneshot::Sender<LoopbackResponse>>,
    session_locks: HashMap<String, Arc<Mutex<()>>>,
}

struct PendingPermission {
    params: Value,
    respond_to: oneshot::Sender<PermissionOutcome>,
}

struct ActiveRun {
    task_id: String,
    msg_id: String,
    channel_id: String,
    provider_session_key: String,
    acp_session_id: String,
    session_id: Option<String>,
    delta_seq: u64,
    trace_seq: u64,
    text: String,
}

#[derive(Debug, Clone)]
struct TaskCommand {
    task_id: String,
    channel_id: String,
    msg_id: String,
    provider_session_key: String,
    session_id: Option<String>,
    trigger_message: Option<Value>,
    attachments: Vec<AttachmentInfo>,
}

enum RuntimeInput {
    Control(ControlInbound),
    Data(DataInbound),
    Adapter(RuntimeEvent),
    Loopback(LoopbackRequest),
    SocketClosed(&'static str),
    SocketError { stream: &'static str, error: String },
}

#[derive(Clone)]
struct BridgeIoHandle {
    control_tx: mpsc::Sender<ControlOutbound>,
    data_tx: mpsc::Sender<DataOutbound>,
    pending_send_acks: Arc<Mutex<HashMap<String, oneshot::Sender<DataInbound>>>>,
    pending_terminal_acks: Arc<Mutex<HashMap<String, oneshot::Sender<DataInbound>>>>,
    pending_file_upload_acks: Arc<Mutex<HashMap<String, oneshot::Sender<DataInbound>>>>,
    ack_timeout: Duration,
    terminal_ack_timeout: Duration,
    send_ack_enabled: bool,
    terminal_ack_enabled: bool,
    file_upload_enabled: bool,
    last_event_seq: Arc<AtomicU64>,
}

impl BridgeIoHandle {
    async fn send_control(&self, frame: ControlOutbound) -> anyhow::Result<()> {
        self.control_tx
            .send(frame)
            .await
            .context("control writer closed")
    }

    async fn send_data(&self, frame: DataOutbound) -> anyhow::Result<()> {
        self.data_tx.send(frame).await.context("data writer closed")
    }

    async fn send_data_expect_send_ack(&self, frame: DataOutbound) -> anyhow::Result<DataInbound> {
        let Some(client_msg_id) = send_ack_client_msg_id(&frame).map(ToString::to_string) else {
            return Err(anyhow!("data frame does not carry client_msg_id"));
        };
        if !self.send_ack_enabled {
            self.send_data(frame).await?;
            return Ok(DataInbound::SendAck {
                v: BRIDGE_PROTOCOL_VERSION,
                client_msg_id,
                ok: true,
                message_id: None,
                finalized_placeholder: None,
                permission_resolution: None,
                error: None,
                code: None,
            });
        }
        let (tx, rx) = oneshot::channel();
        self.pending_send_acks
            .lock()
            .await
            .insert(client_msg_id.clone(), tx);
        if let Err(err) = self.send_data(frame).await {
            self.pending_send_acks.lock().await.remove(&client_msg_id);
            return Err(err);
        }
        match timeout(self.ack_timeout, rx).await {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(_)) => Err(anyhow!(
                "send_ack waiter closed client_msg_id={client_msg_id}"
            )),
            Err(_) => {
                self.pending_send_acks.lock().await.remove(&client_msg_id);
                Err(anyhow!("send_ack timeout client_msg_id={client_msg_id}"))
            }
        }
    }

    async fn send_data_expect_terminal_ack(
        &self,
        frame: DataOutbound,
    ) -> anyhow::Result<DataInbound> {
        let Some(client_msg_id) = terminal_ack_client_msg_id(&frame).map(ToString::to_string)
        else {
            return Err(anyhow!("terminal data frame does not carry client_msg_id"));
        };
        if !self.terminal_ack_enabled {
            self.send_data(frame).await?;
            return Ok(DataInbound::TerminalAck {
                v: BRIDGE_PROTOCOL_VERSION,
                client_msg_id,
                ok: true,
                msg_id: None,
                queued: None,
                job_id: None,
                error: None,
                code: None,
            });
        }
        let (tx, rx) = oneshot::channel();
        self.pending_terminal_acks
            .lock()
            .await
            .insert(client_msg_id.clone(), tx);
        if let Err(err) = self.send_data(frame).await {
            self.pending_terminal_acks
                .lock()
                .await
                .remove(&client_msg_id);
            return Err(err);
        }
        match timeout(self.terminal_ack_timeout, rx).await {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(_)) => Err(anyhow!(
                "terminal_ack waiter closed client_msg_id={client_msg_id}"
            )),
            Err(_) => {
                self.pending_terminal_acks
                    .lock()
                    .await
                    .remove(&client_msg_id);
                Err(anyhow!(
                    "terminal_ack timeout client_msg_id={client_msg_id}"
                ))
            }
        }
    }

    async fn send_data_expect_file_upload_ack(
        &self,
        frame: DataOutbound,
    ) -> anyhow::Result<DataInbound> {
        let Some(client_file_id) = file_upload_ack_client_file_id(&frame).map(ToString::to_string)
        else {
            return Err(anyhow!("file_upload frame does not carry client_file_id"));
        };
        if !self.file_upload_enabled {
            self.send_data(frame).await?;
            return Ok(DataInbound::FileUploadAck {
                v: BRIDGE_PROTOCOL_VERSION,
                client_file_id: Some(client_file_id),
                ok: true,
                file_id: None,
                filename: None,
                content_type: None,
                size_bytes: None,
                preview_url: None,
                download_url: None,
                error: None,
                code: None,
            });
        }
        let (tx, rx) = oneshot::channel();
        self.pending_file_upload_acks
            .lock()
            .await
            .insert(client_file_id.clone(), tx);
        if let Err(err) = self.send_data(frame).await {
            self.pending_file_upload_acks
                .lock()
                .await
                .remove(&client_file_id);
            return Err(err);
        }
        match timeout(self.ack_timeout, rx).await {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(_)) => Err(anyhow!(
                "file_upload_ack waiter closed client_file_id={client_file_id}"
            )),
            Err(_) => {
                self.pending_file_upload_acks
                    .lock()
                    .await
                    .remove(&client_file_id);
                Err(anyhow!(
                    "file_upload_ack timeout client_file_id={client_file_id}"
                ))
            }
        }
    }

    async fn resolve_data_ack(&self, frame: &DataInbound) -> bool {
        match frame {
            DataInbound::SendAck { client_msg_id, .. } => self
                .pending_send_acks
                .lock()
                .await
                .remove(client_msg_id)
                .map(|tx| tx.send(frame.clone()).is_ok())
                .unwrap_or(false),
            DataInbound::TerminalAck { client_msg_id, .. } => self
                .pending_terminal_acks
                .lock()
                .await
                .remove(client_msg_id)
                .map(|tx| tx.send(frame.clone()).is_ok())
                .unwrap_or(false),
            DataInbound::FileUploadAck { client_file_id, .. } => {
                let key = client_file_id.as_deref().unwrap_or("");
                self.pending_file_upload_acks
                    .lock()
                    .await
                    .remove(key)
                    .map(|tx| tx.send(frame.clone()).is_ok())
                    .unwrap_or(false)
            }
            DataInbound::ResumeAck { up_to_seq, .. } => {
                self.last_event_seq.fetch_max(*up_to_seq, Ordering::SeqCst);
                false
            }
            _ => false,
        }
    }
}

fn spawn_bridge_io(
    session: BridgeSession,
    config: BridgeSessionConfig,
    ready: BridgeReady,
    runtime_tx: mpsc::Sender<RuntimeInput>,
    signer: Option<CapabilitySigner>,
) -> BridgeIoHandle {
    let BridgeSessionParts {
        control,
        data,
        account_id: _,
        control_hello: _,
        data_hello,
        memberships: _,
    } = session.into_parts();
    let (control_tx, control_rx) = mpsc::channel(256);
    let (data_tx, data_rx) = mpsc::channel(256);
    let last_event_seq = Arc::new(AtomicU64::new(data_hello.last_event_seq));
    let data_capabilities = data_hello.server_capabilities.clone();
    let ack_timeout = config.send_ack_timeout;
    let terminal_ack_timeout = ack_timeout.min(Duration::from_secs(30));
    spawn_control_socket(
        control,
        control_rx,
        runtime_tx.clone(),
        config.clone(),
        ready,
    );
    spawn_data_socket(
        data,
        data_rx,
        runtime_tx,
        config,
        signer,
        last_event_seq.clone(),
    );
    BridgeIoHandle {
        control_tx,
        data_tx,
        pending_send_acks: Arc::new(Mutex::new(HashMap::new())),
        pending_terminal_acks: Arc::new(Mutex::new(HashMap::new())),
        pending_file_upload_acks: Arc::new(Mutex::new(HashMap::new())),
        ack_timeout,
        terminal_ack_timeout,
        send_ack_enabled: capability_enabled(&data_capabilities, |cap| cap.send_ack),
        terminal_ack_enabled: capability_enabled(&data_capabilities, |cap| cap.terminal_ack),
        file_upload_enabled: data_capabilities
            .as_ref()
            .and_then(|cap| cap.file_upload.as_ref())
            .is_some(),
        last_event_seq,
    }
}

fn spawn_control_socket(
    mut socket: crate::bridge::BridgeWebSocket,
    mut out_rx: mpsc::Receiver<ControlOutbound>,
    runtime_tx: mpsc::Sender<RuntimeInput>,
    config: BridgeSessionConfig,
    ready: BridgeReady,
) {
    tokio::spawn(async move {
        let mut next_heartbeat = Instant::now() + config.heartbeat_interval;
        let mut reconnect_attempt = 0_u32;
        loop {
            while let Ok(frame) = out_rx.try_recv() {
                if let Err(_err) = socket.send_json(&frame).await {
                    match reconnect_control_stream(
                        &config,
                        &ready,
                        &runtime_tx,
                        &mut reconnect_attempt,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                            if let Err(err) = socket.send_json(&frame).await {
                                let _ = runtime_tx
                                    .send(RuntimeInput::SocketError {
                                        stream: "control",
                                        error: err.to_string(),
                                    })
                                    .await;
                                return;
                            }
                        }
                        Err(err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "control",
                                    error: err.to_string(),
                                })
                                .await;
                            return;
                        }
                    }
                }
            }
            if Instant::now() >= next_heartbeat {
                if let Err(err) = socket.send_json(&ControlOutbound::Ping).await {
                    match reconnect_control_stream(
                        &config,
                        &ready,
                        &runtime_tx,
                        &mut reconnect_attempt,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                        }
                        Err(reconnect_err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "control",
                                    error: format!("{err}; reconnect failed: {reconnect_err}"),
                                })
                                .await;
                            return;
                        }
                    }
                } else {
                    next_heartbeat = Instant::now() + config.heartbeat_interval;
                }
            }
            match timeout(SOCKET_POLL_INTERVAL, socket.next_json()).await {
                Ok(Ok(Some(value))) => match serde_json::from_value::<ControlInbound>(value) {
                    Ok(frame) => {
                        if runtime_tx.send(RuntimeInput::Control(frame)).await.is_err() {
                            return;
                        }
                    }
                    Err(err) => {
                        let _ = runtime_tx
                            .send(RuntimeInput::SocketError {
                                stream: "control",
                                error: err.to_string(),
                            })
                            .await;
                        return;
                    }
                },
                Ok(Ok(None)) => {
                    match reconnect_control_stream(
                        &config,
                        &ready,
                        &runtime_tx,
                        &mut reconnect_attempt,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                        }
                        Err(err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "control",
                                    error: err.to_string(),
                                })
                                .await;
                            return;
                        }
                    }
                }
                Ok(Err(err)) => {
                    if is_fatal_bridge_error(&err) {
                        let _ = runtime_tx
                            .send(RuntimeInput::SocketError {
                                stream: "control",
                                error: err.to_string(),
                            })
                            .await;
                        return;
                    }
                    match reconnect_control_stream(
                        &config,
                        &ready,
                        &runtime_tx,
                        &mut reconnect_attempt,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                        }
                        Err(reconnect_err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "control",
                                    error: reconnect_err.to_string(),
                                })
                                .await;
                            return;
                        }
                    }
                }
                Err(_) => {}
            }
        }
    });
}

fn spawn_data_socket(
    mut socket: crate::bridge::BridgeWebSocket,
    mut out_rx: mpsc::Receiver<DataOutbound>,
    runtime_tx: mpsc::Sender<RuntimeInput>,
    config: BridgeSessionConfig,
    mut signer: Option<CapabilitySigner>,
    last_event_seq: Arc<AtomicU64>,
) {
    tokio::spawn(async move {
        let mut next_heartbeat = Instant::now() + config.heartbeat_interval;
        let mut reconnect_attempt = 0_u32;
        loop {
            while let Ok(mut frame) = out_rx.try_recv() {
                if let Some(signer) = &mut signer {
                    if let Err(err) = signer.attach(&mut frame) {
                        let _ = runtime_tx
                            .send(RuntimeInput::SocketError {
                                stream: "data",
                                error: err.to_string(),
                            })
                            .await;
                        return;
                    }
                }
                if let Err(_err) = socket.send_json(&frame).await {
                    match reconnect_data_stream(
                        &config,
                        &runtime_tx,
                        &mut reconnect_attempt,
                        &last_event_seq,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                            if let Err(err) = socket.send_json(&frame).await {
                                let _ = runtime_tx
                                    .send(RuntimeInput::SocketError {
                                        stream: "data",
                                        error: err.to_string(),
                                    })
                                    .await;
                                return;
                            }
                        }
                        Err(err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "data",
                                    error: err.to_string(),
                                })
                                .await;
                            return;
                        }
                    }
                }
            }
            if Instant::now() >= next_heartbeat {
                if let Err(err) = socket.send_json(&DataOutbound::Ping).await {
                    match reconnect_data_stream(
                        &config,
                        &runtime_tx,
                        &mut reconnect_attempt,
                        &last_event_seq,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                        }
                        Err(reconnect_err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "data",
                                    error: format!("{err}; reconnect failed: {reconnect_err}"),
                                })
                                .await;
                            return;
                        }
                    }
                } else {
                    next_heartbeat = Instant::now() + config.heartbeat_interval;
                }
            }
            match timeout(SOCKET_POLL_INTERVAL, socket.next_json()).await {
                Ok(Ok(Some(value))) => match serde_json::from_value::<DataInbound>(value) {
                    Ok(frame) => {
                        if runtime_tx.send(RuntimeInput::Data(frame)).await.is_err() {
                            return;
                        }
                    }
                    Err(err) => {
                        let _ = runtime_tx
                            .send(RuntimeInput::SocketError {
                                stream: "data",
                                error: err.to_string(),
                            })
                            .await;
                        return;
                    }
                },
                Ok(Ok(None)) => {
                    match reconnect_data_stream(
                        &config,
                        &runtime_tx,
                        &mut reconnect_attempt,
                        &last_event_seq,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                        }
                        Err(err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "data",
                                    error: err.to_string(),
                                })
                                .await;
                            return;
                        }
                    }
                }
                Ok(Err(err)) => {
                    if is_fatal_bridge_error(&err) {
                        let _ = runtime_tx
                            .send(RuntimeInput::SocketError {
                                stream: "data",
                                error: err.to_string(),
                            })
                            .await;
                        return;
                    }
                    match reconnect_data_stream(
                        &config,
                        &runtime_tx,
                        &mut reconnect_attempt,
                        &last_event_seq,
                    )
                    .await
                    {
                        Ok(new_socket) => {
                            socket = new_socket;
                            next_heartbeat = Instant::now() + config.heartbeat_interval;
                        }
                        Err(reconnect_err) => {
                            let _ = runtime_tx
                                .send(RuntimeInput::SocketError {
                                    stream: "data",
                                    error: reconnect_err.to_string(),
                                })
                                .await;
                            return;
                        }
                    }
                }
                Err(_) => {}
            }
        }
    });
}

async fn reconnect_control_stream(
    config: &BridgeSessionConfig,
    ready: &BridgeReady,
    runtime_tx: &mpsc::Sender<RuntimeInput>,
    attempt: &mut u32,
) -> anyhow::Result<crate::bridge::BridgeWebSocket> {
    loop {
        *attempt = attempt.saturating_add(1);
        let delay = crate::bridge::compute_backoff(*attempt, config.reconnect);
        tracing::warn!(
            account = %config.account_id,
            attempt = *attempt,
            delay_ms = delay.as_millis(),
            "Agent Bridge control stream reconnect scheduled"
        );
        tokio::time::sleep(delay).await;
        match connect_control_stream(config, ready).await {
            Ok((socket, _hello)) => {
                tracing::info!(
                    account = %config.account_id,
                    "Agent Bridge control stream reconnected"
                );
                *attempt = 0;
                return Ok(socket);
            }
            Err(err) if is_fatal_bridge_error(&err) => return Err(err),
            Err(err) => {
                let _ = runtime_tx
                    .send(RuntimeInput::Adapter(RuntimeEvent::AdapterError {
                        message: format!("Agent Bridge control reconnect failed: {err}"),
                    }))
                    .await;
            }
        }
    }
}

async fn reconnect_data_stream(
    config: &BridgeSessionConfig,
    runtime_tx: &mpsc::Sender<RuntimeInput>,
    attempt: &mut u32,
    last_event_seq: &Arc<AtomicU64>,
) -> anyhow::Result<crate::bridge::BridgeWebSocket> {
    loop {
        *attempt = attempt.saturating_add(1);
        let delay = crate::bridge::compute_backoff(*attempt, config.reconnect);
        tracing::warn!(
            account = %config.account_id,
            attempt = *attempt,
            delay_ms = delay.as_millis(),
            "Agent Bridge data stream reconnect scheduled"
        );
        tokio::time::sleep(delay).await;
        match connect_data_stream(config).await {
            Ok((mut socket, hello)) => {
                let resume_from = last_event_seq
                    .load(Ordering::SeqCst)
                    .max(hello.last_event_seq);
                last_event_seq.store(resume_from, Ordering::SeqCst);
                socket
                    .send_json(&DataOutbound::Resume {
                        v: BRIDGE_PROTOCOL_VERSION,
                        last_event_seq: resume_from,
                    })
                    .await
                    .context("failed to send Agent Bridge data resume frame")?;
                tracing::info!(
                    account = %config.account_id,
                    last_event_seq = resume_from,
                    "Agent Bridge data stream reconnected and resume requested"
                );
                *attempt = 0;
                return Ok(socket);
            }
            Err(err) if is_fatal_bridge_error(&err) => return Err(err),
            Err(err) => {
                let _ = runtime_tx
                    .send(RuntimeInput::Adapter(RuntimeEvent::AdapterError {
                        message: format!("Agent Bridge data reconnect failed: {err}"),
                    }))
                    .await;
            }
        }
    }
}

fn is_fatal_bridge_error(err: &anyhow::Error) -> bool {
    let text = err.to_string();
    text.contains("fatal code=4401")
        || text.contains("fatal code=4402")
        || text.contains("fatal code=4403")
}

fn capability_enabled(
    capabilities: &Option<ServerCapabilities>,
    field: impl FnOnce(&ServerCapabilities) -> Option<bool>,
) -> bool {
    capabilities.as_ref().and_then(field).unwrap_or(true)
}

fn send_ack_client_msg_id(frame: &DataOutbound) -> Option<&str> {
    match frame {
        DataOutbound::Send { client_msg_id, .. }
        | DataOutbound::PermissionRequest { client_msg_id, .. } => Some(client_msg_id),
        _ => None,
    }
}

fn terminal_ack_client_msg_id(frame: &DataOutbound) -> Option<&str> {
    match frame {
        DataOutbound::Done { client_msg_id, .. } | DataOutbound::Error { client_msg_id, .. } => {
            Some(client_msg_id)
        }
        _ => None,
    }
}

fn file_upload_ack_client_file_id(frame: &DataOutbound) -> Option<&str> {
    match frame {
        DataOutbound::FileUpload { client_file_id, .. } => Some(client_file_id),
        _ => None,
    }
}

fn terminal_ack_ok(frame: &DataInbound) -> bool {
    matches!(frame, DataInbound::TerminalAck { ok: true, .. })
}

fn terminal_ack_error(frame: &DataInbound) -> Option<String> {
    match frame {
        DataInbound::TerminalAck { error, code, .. } => Some(
            error
                .clone()
                .or_else(|| code.clone())
                .unwrap_or_else(|| "terminal_ack failed".to_string()),
        ),
        _ => None,
    }
}

fn send_ack_error(frame: &DataInbound) -> Option<String> {
    match frame {
        DataInbound::SendAck { error, code, .. } => Some(
            error
                .clone()
                .or_else(|| code.clone())
                .unwrap_or_else(|| "send_ack failed".to_string()),
        ),
        _ => None,
    }
}

fn bridge_ready_from_initialize(initialize: &Value, policy: &LocalPolicy) -> BridgeReady {
    let runtime_name = initialize
        .get("agentInfo")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("acp-agent");
    let runtime_version = initialize
        .get("agentInfo")
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let mut ready = BridgeReady::acp(runtime_name, runtime_version);
    ready.connector_capabilities = Some(json!({
        "runtime_protocols": ["acp"],
        "runtime_session_control": policy.sessions.create
            || policy.sessions.load
            || policy.sessions.cancel
            || policy.sessions.terminate,
        "streaming": policy.prompt.allow,
        "files": policy.file_upload.allow,
        "send": policy.send.allow,
        "resource_req": !policy.loopback.allowed_resources.is_empty(),
        "permission_request": policy.permission.forward_to_backend,
        "config_options": true,
        "trace": policy.trace.allow,
        "session_update": policy.session_update.allow,
    }));
    ready
}

fn build_prompt(task: &TaskCommand, policy: &PromptPolicy) -> Vec<Value> {
    let mut parts = vec![AGENTNEXUS_ACP_OUTPUT_CONTRACT.to_string()];
    if let Some(text) = task
        .trigger_message
        .as_ref()
        .and_then(extract_trigger_text)
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(text);
    }
    if policy.allow_attachments && !task.attachments.is_empty() {
        let mut lines = vec!["AgentNexus attachments:".to_string()];
        for attachment in &task.attachments {
            lines.push(attachment_summary_line(attachment));
        }
        parts.push(lines.join("\n"));
    }
    vec![json!({
        "type": "text",
        "text": parts.join("\n\n")
    })]
}

const AGENTNEXUS_ACP_OUTPUT_CONTRACT: &str = "You are replying inside AgentNexus. Stream useful answer text through the ACP session; generated files should be returned as explicit file/resource updates when the runtime supports them.";

fn extract_trigger_text(value: &Value) -> Option<String> {
    value
        .get("text")
        .or_else(|| value.get("content"))
        .or_else(|| value.get("body"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn attachment_summary_line(attachment: &AttachmentInfo) -> String {
    let name = attachment
        .filename
        .as_deref()
        .or(attachment.file_id.as_deref())
        .unwrap_or("attachment");
    let content_type = attachment.content_type.as_deref().unwrap_or("unknown");
    let size = attachment
        .size_bytes
        .map(|value| format!(" size={value} bytes"))
        .unwrap_or_default();
    let summary = attachment
        .summary
        .as_ref()
        .map(|value| format!(" summary={value}"))
        .unwrap_or_default();
    format!("- {name} ({content_type}{size}){summary}")
}

fn limit_text_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut out = String::new();
    for ch in value.chars() {
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

fn text_from_content(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(array) = value.as_array() {
        let mut out = String::new();
        for item in array {
            if let Some(text) = text_from_content(item) {
                out.push_str(&text);
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    None
}

fn update_summary(value: &Value) -> String {
    value
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn normalize_config_options_report(update: &Value) -> Value {
    json!({
        "source": "acp",
        "updatedAt": Utc::now().to_rfc3339(),
        "sessionUpdate": update.get("sessionUpdate").cloned(),
        "configOptions": update.get("configOptions").cloned(),
        "modes": update.get("modes").cloned(),
        "availableCommands": update.get("availableCommands").cloned(),
        "currentModeId": update.get("currentModeId").cloned(),
    })
}

fn permission_body_from_params(params: &Value) -> String {
    params
        .get("message")
        .or_else(|| params.get("description"))
        .or_else(|| params.get("content"))
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("toolCall")
                .and_then(|tool| tool.get("name").or_else(|| tool.get("tool")))
                .and_then(Value::as_str)
        })
        .unwrap_or("ACP agent requested permission to continue.")
        .to_string()
}

fn permission_option_id_for_resolution(params: &Value, resolution: &str) -> Option<String> {
    let wanted = match resolution {
        "allow" => "allow",
        "deny" | "reject" => "reject",
        _ => resolution,
    };
    params
        .get("options")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_object)
        .find_map(|option| {
            let kind = option.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind.starts_with(wanted) {
                option
                    .get("optionId")
                    .or_else(|| option.get("option_id"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            } else {
                None
            }
        })
}

fn resolve_mcp_server_command() -> String {
    if let Ok(path) = env::var("AGENTNEXUS_MCP_SERVER_BIN") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(packages_dir) = manifest_dir.parent() {
        let candidate = packages_dir
            .join("agentnexus-mcp-server")
            .join("target")
            .join("debug")
            .join(if cfg!(windows) {
                "agentnexus-mcp-server.exe"
            } else {
                "agentnexus-mcp-server"
            });
        if candidate.exists() {
            return candidate.display().to_string();
        }
    }
    "agentnexus-mcp-server".to_string()
}

struct CapabilitySigner {
    delegation_id: String,
    kid: Option<String>,
    request_id_prefix: String,
    seq: u64,
    key: SigningKey,
}

impl CapabilitySigner {
    fn from_config(
        config: Option<AcpCapabilityConfig>,
        security: Option<AcpSecurityHello>,
    ) -> anyhow::Result<Option<Self>> {
        let require = security
            .as_ref()
            .and_then(|value| value.require_capability)
            .unwrap_or(false);
        if !require {
            return Ok(None);
        }
        let config =
            config.ok_or_else(|| anyhow!("acpCapability is required by Agent Bridge hello"))?;
        if config.algorithm.to_ascii_lowercase() != "ed25519" {
            return Err(anyhow!(
                "unsupported acpCapability algorithm {}; expected ed25519",
                config.algorithm
            ));
        }
        if let Some(algorithm) = security
            .as_ref()
            .and_then(|value| value.algorithm.as_deref())
        {
            if algorithm.to_ascii_lowercase() != "ed25519" {
                return Err(anyhow!(
                    "unsupported Agent Bridge acp_security algorithm {}; expected ed25519",
                    algorithm
                ));
            }
        }
        let key_text = read_private_key_text(&config.private_key)?;
        let key = SigningKey::from_pkcs8_pem(&key_text)
            .context("failed to parse acpCapability private key as Ed25519 PKCS#8 PEM")?;
        Ok(Some(Self {
            delegation_id: config.delegation_id,
            kid: config.kid,
            request_id_prefix: config
                .request_id_prefix
                .unwrap_or_else(|| "acp-cap".to_string()),
            seq: 0,
            key,
        }))
    }

    fn attach(&mut self, frame: &mut DataOutbound) -> anyhow::Result<()> {
        let Some(frame_type) = signed_frame_type(frame) else {
            return Ok(());
        };
        let mut value = serde_json::to_value(&*frame)?;
        if let Some(obj) = value.as_object_mut() {
            obj.remove("acp_capability");
        }
        self.seq += 1;
        let ts = Utc::now().timestamp();
        let nonce = Uuid::new_v4().to_string();
        let request_id = format!("{}-{}-{}", self.request_id_prefix, ts, self.seq);
        let payload = canonical_serialize(&value);
        let signable = format!(
            "anx-cap|v1|type={frame_type}|kid={}|ts={ts}|nonce={nonce}|request={request_id}|payload={payload}",
            self.delegation_id
        );
        let signature: Signature = self.key.sign(signable.as_bytes());
        let envelope = AcpCapabilityEnvelope {
            delegation_id: self.delegation_id.clone(),
            ts,
            nonce,
            signature: BASE64.encode(signature.to_bytes()),
            request_id: Some(request_id),
            algorithm: Some("ed25519".to_string()),
            kid: self.kid.clone(),
        };
        attach_envelope(frame, envelope);
        Ok(())
    }
}

fn read_private_key_text(value: &str) -> anyhow::Result<String> {
    if let Some(path) = value.strip_prefix("file:") {
        std::fs::read_to_string(path.trim())
            .with_context(|| format!("failed to read acpCapability private key {}", path.trim()))
    } else {
        Ok(value.to_string())
    }
}

fn signed_frame_type(frame: &DataOutbound) -> Option<&'static str> {
    match frame {
        DataOutbound::Delta { .. } => Some("delta"),
        DataOutbound::Done { .. } => Some("done"),
        DataOutbound::Error { .. } => Some("error"),
        DataOutbound::Send { .. } => Some("send"),
        DataOutbound::ResourceReq { .. } => Some("resource_req"),
        DataOutbound::PermissionRequest { .. } => Some("permission_request"),
        DataOutbound::SessionUpdate { .. } => Some("session_update"),
        DataOutbound::Trace { .. } => Some("trace"),
        DataOutbound::Auth { .. }
        | DataOutbound::Ping
        | DataOutbound::Resume { .. }
        | DataOutbound::FileUpload { .. } => None,
    }
}

fn attach_envelope(frame: &mut DataOutbound, envelope: AcpCapabilityEnvelope) {
    match frame {
        DataOutbound::Delta { acp_capability, .. }
        | DataOutbound::Done { acp_capability, .. }
        | DataOutbound::Error { acp_capability, .. }
        | DataOutbound::Send { acp_capability, .. }
        | DataOutbound::ResourceReq { acp_capability, .. }
        | DataOutbound::PermissionRequest { acp_capability, .. }
        | DataOutbound::SessionUpdate { acp_capability, .. }
        | DataOutbound::Trace { acp_capability, .. } => {
            *acp_capability = Some(envelope);
        }
        DataOutbound::Auth { .. }
        | DataOutbound::Ping
        | DataOutbound::Resume { .. }
        | DataOutbound::FileUpload { .. } => {}
    }
}

fn canonical_serialize(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_serialize)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut entries: BTreeMap<&String, &Value> = BTreeMap::new();
            for (key, value) in map {
                entries.insert(key, value);
            }
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_serialize(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_builder_uses_trigger_text_and_attachment_summary() {
        let task = TaskCommand {
            task_id: "task-1".to_string(),
            channel_id: "channel-1".to_string(),
            msg_id: "msg-1".to_string(),
            provider_session_key: "provider".to_string(),
            session_id: None,
            trigger_message: Some(json!({"text": "@bot summarize"})),
            attachments: vec![AttachmentInfo {
                file_id: Some("file-1".to_string()),
                filename: Some("report.pdf".to_string()),
                content_type: Some("application/pdf".to_string()),
                size_bytes: Some(12),
                summary: Some("short".to_string()),
                is_image: None,
                image_b64: None,
                extra: serde_json::Map::new(),
            }],
        };
        let prompt = build_prompt(&task, &test_prompt_policy(true));
        let text = prompt[0]["text"].as_str().expect("text block");
        assert!(text.contains("@bot summarize"));
        assert!(text.contains("report.pdf"));
    }

    fn test_prompt_policy(allow_attachments: bool) -> PromptPolicy {
        PromptPolicy {
            allow: true,
            max_concurrent: 1,
            max_prompt_bytes: 200_000,
            max_duration_ms: 900_000,
            allow_attachments,
            allow_images: true,
            allow_local_file_refs: false,
        }
    }

    #[test]
    fn canonical_serialize_sorts_object_keys() {
        let value = json!({"b": 2, "a": 1});
        assert_eq!(canonical_serialize(&value), "{\"a\":1,\"b\":2}");
    }

    #[test]
    fn bridge_ack_keys_are_extracted_from_protocol_frames() {
        let permission = DataOutbound::PermissionRequest {
            v: BRIDGE_PROTOCOL_VERSION,
            client_msg_id: "send-1".to_string(),
            channel_id: "channel-1".to_string(),
            request_id: "permission-1".to_string(),
            task_id: None,
            msg_id: None,
            acp_session_id: None,
            provider_session_key: None,
            provider_session_id: None,
            session_id: None,
            title: None,
            body: "Approve?".to_string(),
            tool: None,
            options: Vec::new(),
            acp_capability: None,
        };
        assert_eq!(send_ack_client_msg_id(&permission), Some("send-1"));

        let done = DataOutbound::Done {
            v: BRIDGE_PROTOCOL_VERSION,
            client_msg_id: "terminal-1".to_string(),
            msg_id: "msg-1".to_string(),
            file_ids: Vec::new(),
            mention_ids: Vec::new(),
            content: None,
            provider_session_key: None,
            provider_session_id: None,
            session_id: None,
            acp_capability: None,
        };
        assert_eq!(terminal_ack_client_msg_id(&done), Some("terminal-1"));

        let upload = DataOutbound::FileUpload {
            v: BRIDGE_PROTOCOL_VERSION,
            client_file_id: "file-1".to_string(),
            channel_id: "channel-1".to_string(),
            filename: "report.txt".to_string(),
            content_type: Some("text/plain".to_string()),
            data_b64: "cmVwb3J0".to_string(),
        };
        assert_eq!(file_upload_ack_client_file_id(&upload), Some("file-1"));
    }
}
