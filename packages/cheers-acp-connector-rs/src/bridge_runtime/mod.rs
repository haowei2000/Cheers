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
        // Extract channel_id → channel_name map from membership snapshot
        // before it's consumed by spawn_bridge_io.
        let channel_names: std::collections::HashMap<String, String> = bridge
            .memberships()
            .iter_channels()
            .filter_map(|ch| {
                ch.channel_name
                    .as_ref()
                    .map(|name| (ch.channel_id.clone(), name.clone()))
            })
            .collect();
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

        let mut shared = SharedRuntimeState::default();
        shared.channel_names = channel_names;
        let shared = Arc::new(Mutex::new(shared));
        let adapter_for_stop = adapter.clone();
        let context = Arc::new(RuntimeContext {
            account_id: self.account_id,
            config: self.config,
            state: self.state,
            adapter,
            loopback,
            io,
            shared,
            runtime_tx: runtime_tx.clone(),
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
    /// Sender into the main event loop — used to enqueue fence events (EnableStreaming)
    /// that must be ordered after history-replay notifications already in the queue.
    runtime_tx: mpsc::Sender<RuntimeInput>,
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
                    // Fail all pending loopback requests immediately so their tasks don't
                    // block until the timeout when the data WS is gone.
                    let _ = self
                        .runtime_tx
                        .send(RuntimeInput::AbortPendingResources)
                        .await;
                    return Err(anyhow!("Agent Bridge {stream} stream closed"));
                }
                RuntimeInput::SocketError { stream, error } => {
                    let _ = self
                        .runtime_tx
                        .send(RuntimeInput::AbortPendingResources)
                        .await;
                    return Err(anyhow!("Agent Bridge {stream} stream error: {error}"));
                }
                RuntimeInput::AbortPendingResources => {
                    let mut shared = self.shared.lock().await;
                    for tx in shared.pending_resources.drain().map(|(_, tx)| tx) {
                        let _ = tx.send(LoopbackResponse {
                            ok: false,
                            data: None,
                            error: Some("data stream closed before resource response".to_string()),
                            code: Some("DATA_STREAM_CLOSED".to_string()),
                        });
                    }
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
                pinned,
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
                    pinned,
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
            ControlInbound::ChannelJoined { channel, .. } => {
                if let Some(name) = &channel.channel_name {
                    self.shared
                        .lock()
                        .await
                        .channel_names
                        .insert(channel.channel_id.clone(), name.clone());
                }
            }
            ControlInbound::ChannelLeft { channel_id, .. } => {
                self.shared.lock().await.channel_names.remove(&channel_id);
            }
            ControlInbound::Hello { memberships, .. } => {
                let mut guard = self.shared.lock().await;
                for ch in memberships {
                    if let Some(name) = &ch.channel_name {
                        guard
                            .channel_names
                            .insert(ch.channel_id.clone(), name.clone());
                    }
                }
            }
            ControlInbound::Pong | ControlInbound::Unknown => {}
            ControlInbound::Error { .. } => {}
        }
        Ok(())
    }

    async fn handle_data(self: Arc<Self>, frame: DataInbound) -> anyhow::Result<()> {
        let ack_was_pending = self.io.resolve_data_ack(&frame).await;
        match frame {
            DataInbound::ResourceRes { response } => {
                let matched = {
                    let maybe_tx = self
                        .shared
                        .lock()
                        .await
                        .pending_resources
                        .remove(&response.req_id);
                    if let Some(tx) = maybe_tx {
                        let _ = tx.send(LoopbackResponse {
                            ok: response.ok,
                            data: response.data,
                            error: response.error,
                            code: response.code,
                        });
                        true
                    } else {
                        false
                    }
                };
                tracing::debug!(
                    req_id = %response.req_id,
                    matched,
                    "loopback resource_res received"
                );
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
            DataInbound::RealizeFile {
                file_id,
                remote_ref,
                channel_id,
            } => {
                let runtime = self.clone();
                tokio::spawn(async move {
                    if let Err(err) = runtime
                        .handle_realize_file(file_id, remote_ref, channel_id)
                        .await
                    {
                        tracing::warn!("realize_file failed: {err}");
                    }
                });
            }
            DataInbound::WorkspaceReq {
                req_id,
                op,
                path,
                root,
                content_b64,
            } => {
                let runtime = self.clone();
                tokio::spawn(async move {
                    let frame = match runtime
                        .handle_workspace_req(&op, &path, root.as_deref(), content_b64.as_deref())
                        .await
                    {
                        Ok(data) => DataOutbound::WorkspaceRes {
                            v: BRIDGE_PROTOCOL_VERSION,
                            req_id,
                            ok: true,
                            data: Some(data),
                            error: None,
                            code: None,
                        },
                        Err((code, msg)) => DataOutbound::WorkspaceRes {
                            v: BRIDGE_PROTOCOL_VERSION,
                            req_id,
                            ok: false,
                            data: None,
                            error: Some(msg),
                            code: Some(code),
                        },
                    };
                    if let Err(e) = runtime.io.send_data(frame).await {
                        tracing::warn!("workspace_res send failed: {e}");
                    }
                });
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

    async fn handle_realize_file(
        &self,
        file_id: String,
        remote_ref: String,
        channel_id: String,
    ) -> anyhow::Result<()> {
        let bytes = tokio::fs::read(&remote_ref)
            .await
            .with_context(|| format!("realize_file: cannot read local file '{remote_ref}'"))?;

        let filename = std::path::Path::new(&remote_ref)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();

        let content_type = mime_guess::from_path(&filename)
            .first_raw()
            .unwrap_or("application/octet-stream")
            .to_string();

        let data_b64 = BASE64.encode(&bytes);

        let req_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.shared
            .lock()
            .await
            .pending_resources
            .insert(req_id.clone(), tx);

        self.io
            .send_data(DataOutbound::ResourceReq {
                v: BRIDGE_PROTOCOL_VERSION,
                req_id: req_id.clone(),
                resource: "channel.files.realize".to_string(),
                params: Some(serde_json::json!({
                    "file_id": file_id,
                    "channel_id": channel_id,
                    "data_b64": data_b64,
                    "content_type": content_type,
                    "filename": filename,
                })),
                encrypted: None,
                encrypted_payload: None,
                acp_capability: None,
            })
            .await?;

        let response = tokio::time::timeout(
            std::time::Duration::from_millis(self.config.policy.loopback.request_timeout_ms),
            rx,
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| LoopbackResponse {
            ok: false,
            data: None,
            error: Some("realize resource response timed out".to_string()),
            code: Some("RESOURCE_TIMEOUT".to_string()),
        });

        if response.ok {
            tracing::info!(%file_id, "realize_file: uploaded to S3");
        } else {
            tracing::warn!(
                %file_id,
                error = response.error.as_deref().unwrap_or(""),
                "realize_file: gateway returned error"
            );
        }
        Ok(())
    }

    /// Browse/read/write the agent's real workspace for the remote-workspace UI.
    /// STRICTLY confined to `policy.workspace.allowed_roots`; `..` escapes are
    /// rejected after canonicalization. Returns Err((code, message)) on violation.
    async fn handle_workspace_req(
        &self,
        op: &str,
        rel: &str,
        root: Option<&str>,
        content_b64: Option<&str>,
    ) -> Result<Value, (String, String)> {
        const MAX_READ: u64 = 10 * 1024 * 1024;
        let err = |c: &str, m: String| (c.to_string(), m);

        let roots = &self.config.policy.workspace.allowed_roots;
        if roots.is_empty() {
            return Err(err("E_NO_ROOT", "no workspace roots configured".into()));
        }

        // Pick the root: an explicit (allow-listed) one, else default_cwd, else first.
        let chosen_root = match root {
            Some(r) => {
                let want = canonical_path(std::path::Path::new(r));
                roots
                    .iter()
                    .find(|ar| canonical_path(ar) == want)
                    .cloned()
                    .ok_or_else(|| err("E_FORBIDDEN_ROOT", format!("root not allowed: {r}")))?
            }
            None => self
                .config
                .policy
                .workspace
                .default_cwd
                .clone()
                .filter(|c| {
                    roots
                        .iter()
                        .any(|ar| canonical_path(ar) == canonical_path(c))
                })
                .or_else(|| roots.first().cloned())
                .ok_or_else(|| err("E_NO_ROOT", "no default workspace root".into()))?,
        };
        let root_canon = tokio::fs::canonicalize(&chosen_root)
            .await
            .map_err(|e| err("E_ROOT_MISSING", format!("root unavailable: {e}")))?;
        let target = root_canon.join(rel.trim_start_matches('/'));

        match op {
            "ls" => {
                let dir = tokio::fs::canonicalize(&target)
                    .await
                    .map_err(|e| err("E_NOT_FOUND", e.to_string()))?;
                if !dir.starts_with(&root_canon) {
                    return Err(err(
                        "E_FORBIDDEN_PATH",
                        "path escapes workspace root".into(),
                    ));
                }
                let mut rd = tokio::fs::read_dir(&dir)
                    .await
                    .map_err(|e| err("E_IO", e.to_string()))?;
                let mut entries = Vec::new();
                while let Some(ent) = rd
                    .next_entry()
                    .await
                    .map_err(|e| err("E_IO", e.to_string()))?
                {
                    let name = ent.file_name().to_string_lossy().to_string();
                    if name == ".git" {
                        continue;
                    }
                    let md = ent.metadata().await.ok();
                    let p = ent.path();
                    let rel_path = p
                        .strip_prefix(&root_canon)
                        .unwrap_or(&p)
                        .to_string_lossy()
                        .to_string();
                    entries.push(serde_json::json!({
                        "name": name,
                        "path": rel_path,
                        "is_dir": md.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                        "size_bytes": md.as_ref().map(|m| m.len()).unwrap_or(0),
                    }));
                }
                entries.sort_by(|a, b| {
                    let (ad, bd) = (
                        a["is_dir"].as_bool().unwrap_or(false),
                        b["is_dir"].as_bool().unwrap_or(false),
                    );
                    bd.cmp(&ad).then_with(|| {
                        a["name"]
                            .as_str()
                            .unwrap_or("")
                            .cmp(b["name"].as_str().unwrap_or(""))
                    })
                });
                Ok(serde_json::json!({
                    "root": root_canon.to_string_lossy(),
                    "path": rel.trim_start_matches('/'),
                    "entries": entries,
                }))
            }
            "read" => {
                let file = tokio::fs::canonicalize(&target)
                    .await
                    .map_err(|e| err("E_NOT_FOUND", e.to_string()))?;
                if !file.starts_with(&root_canon) {
                    return Err(err(
                        "E_FORBIDDEN_PATH",
                        "path escapes workspace root".into(),
                    ));
                }
                let md = tokio::fs::metadata(&file)
                    .await
                    .map_err(|e| err("E_IO", e.to_string()))?;
                if md.is_dir() {
                    return Err(err("E_IS_DIR", "path is a directory".into()));
                }
                if md.len() > MAX_READ {
                    return Err(err(
                        "E_TOO_LARGE",
                        format!("file exceeds {}MB read cap", MAX_READ / 1024 / 1024),
                    ));
                }
                let bytes = tokio::fs::read(&file)
                    .await
                    .map_err(|e| err("E_IO", e.to_string()))?;
                let filename = file
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file")
                    .to_string();
                let content_type = mime_guess::from_path(&filename)
                    .first_raw()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let is_text = !bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok();
                Ok(serde_json::json!({
                    "root": root_canon.to_string_lossy(),
                    "path": rel.trim_start_matches('/'),
                    "filename": filename,
                    "content_type": content_type,
                    "size_bytes": bytes.len(),
                    "is_text": is_text,
                    "content": if is_text { Some(String::from_utf8_lossy(&bytes).to_string()) } else { None },
                    "content_b64": BASE64.encode(&bytes),
                }))
            }
            "write" => {
                let b64 =
                    content_b64.ok_or_else(|| err("E_INVALID", "content_b64 required".into()))?;
                let bytes = BASE64
                    .decode(b64)
                    .map_err(|e| err("E_INVALID", format!("bad base64: {e}")))?;
                let parent = target
                    .parent()
                    .ok_or_else(|| err("E_INVALID", "invalid path".into()))?;
                let parent_canon = tokio::fs::canonicalize(parent)
                    .await
                    .map_err(|e| err("E_NOT_FOUND", e.to_string()))?;
                if !parent_canon.starts_with(&root_canon) {
                    return Err(err(
                        "E_FORBIDDEN_PATH",
                        "path escapes workspace root".into(),
                    ));
                }
                let filename = target
                    .file_name()
                    .ok_or_else(|| err("E_INVALID", "no filename".into()))?;
                let dest = parent_canon.join(filename);
                // Symlink-escape guard: the parent is canonical & in-root, but the
                // FINAL component is not yet resolved. A symlink at `dest` pointing
                // outside the root would let `fs::write` follow it and escape
                // allowed_roots. lstat (no-follow) the final component: refuse to
                // write through a symlink, and if it's a pre-existing real entry,
                // re-verify it canonicalizes back inside the root. (A new file under
                // an already-in-root canonical parent is safe to create.)
                // Residual: a sub-millisecond TOCTOU between this lstat and the
                // write, and hardlinks, are not covered here — acceptable for the
                // human-driven workspace browser; revisit with O_NOFOLLOW if this
                // path is ever driven by an agent.
                match tokio::fs::symlink_metadata(&dest).await {
                    Ok(md) if md.file_type().is_symlink() => {
                        return Err(err(
                            "E_FORBIDDEN_PATH",
                            "refusing to write through a symlink".into(),
                        ));
                    }
                    Ok(md) if md.is_dir() => {
                        return Err(err("E_IS_DIR", "path is a directory".into()));
                    }
                    Ok(_) => {
                        let dest_canon = tokio::fs::canonicalize(&dest)
                            .await
                            .map_err(|e| err("E_IO", e.to_string()))?;
                        if !dest_canon.starts_with(&root_canon) {
                            return Err(err(
                                "E_FORBIDDEN_PATH",
                                "path escapes workspace root".into(),
                            ));
                        }
                    }
                    Err(_) => {}
                }
                tokio::fs::write(&dest, &bytes)
                    .await
                    .map_err(|e| err("E_IO", e.to_string()))?;
                Ok(
                    serde_json::json!({ "path": rel.trim_start_matches('/'), "size_bytes": bytes.len(), "ok": true }),
                )
            }
            other => Err(err(
                "E_UNKNOWN_OP",
                format!("unknown workspace op: {other}"),
            )),
        }
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
            RuntimeEvent::LoadSessionFence { acp_session_id } => {
                if let Some(run) = self
                    .shared
                    .lock()
                    .await
                    .by_acp_session
                    .get(&acp_session_id)
                    .cloned()
                {
                    run.lock().await.streaming_started = true;
                }
            }
        }
        Ok(())
    }

    async fn handle_loopback_request(
        self: Arc<Self>,
        request: LoopbackRequest,
    ) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        let req_id = request.req_id.clone();
        let resource = request.resource.clone();
        // Captured before request.params is moved into the ResourceReq frame below;
        // used to attach files the agent creates this turn to its reply (see end).
        let attach_channel_id = request
            .params
            .as_ref()
            .and_then(|p| p.get("channel_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        self.shared
            .lock()
            .await
            .pending_resources
            .insert(request.req_id.clone(), tx);
        tracing::debug!(%req_id, %resource, "loopback resource_req sent");
        self.io
            .send_data(DataOutbound::ResourceReq {
                v: BRIDGE_PROTOCOL_VERSION,
                req_id: request.req_id.clone(),
                resource: request.resource,
                params: request.params,
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
        // inbox_deliver / inbox_stage create a channel file; record its id on the
        // active run so the Done reply attaches it as a chat attachment.
        if response.ok && (resource == "channel.files.create" || resource == "channel.files.stage")
        {
            if let Some(file_id) = response
                .data
                .as_ref()
                .and_then(|d| d.get("file_id"))
                .and_then(Value::as_str)
            {
                let runs: Vec<Arc<Mutex<ActiveRun>>> =
                    self.shared.lock().await.by_msg.values().cloned().collect();
                for run in runs {
                    let mut guard = run.lock().await;
                    let matches = match attach_channel_id.as_deref() {
                        Some(c) => c == guard.channel_id,
                        None => true,
                    };
                    if matches {
                        guard.created_file_ids.push(file_id.to_string());
                        break;
                    }
                }
            }
        }
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
            mcp_servers: self.mcp_servers_for_task(&task).await,
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
            created_file_ids: Vec::new(),
            streaming_started: false,
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
        let channel_name = self
            .shared
            .lock()
            .await
            .channel_names
            .get(&task.channel_id)
            .cloned();
        // Only push image content blocks when local policy allows it AND the
        // agent advertised `promptCapabilities.image`; otherwise images degrade
        // to a text summary inside build_prompt.
        let send_images = self.config.policy.prompt.allow_images
            && self.adapter.lock().await.supports_prompt_image();
        let prompt = build_prompt(
            &task,
            &self.config.policy.prompt,
            channel_name.as_deref(),
            send_images,
        );
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
        // Inject the fence through the adapter event channel (the same FIFO that
        // history-replay agent_message_chunk notifications flow through).  The forwarding
        // task will forward it to runtime_tx strictly after all preceding history events,
        // so run_loop sets streaming_started=true only once the history is fully drained.
        self.adapter
            .lock()
            .await
            .inject_fence(acp_session_id.clone())
            .await;
        // Lock the adapter only long enough to clone a transport handle, then
        // await the prompt WITHOUT the lock. The prompt can block for minutes
        // (e.g. paused on an approval card), so holding the adapter Mutex here
        // would freeze every other session's turn on this bot. Per-session
        // ordering is still guaranteed by `session_lock` above; the pending-id
        // map routes each session's response independently.
        let requester = self.adapter.lock().await.requester();
        let prompt_result = requester
            .prompt(&acp_session_id, prompt, self.config.agent.prompt_timeout_ms)
            .await;

        match prompt_result {
            Ok(result) => {
                self.trace(
                    &run,
                    "prompt_finished",
                    stop_reason_to_status(result.stop_reason.as_deref()),
                    "ACP prompt finished",
                    result.stop_reason.as_deref(),
                )
                .await?;
                let (final_text, file_ids) = {
                    let guard = run.lock().await;
                    (guard.text.clone(), guard.created_file_ids.clone())
                };
                let terminal_ack = self
                    .io
                    .send_data_expect_terminal_ack(DataOutbound::Done {
                        v: BRIDGE_PROTOCOL_VERSION,
                        client_msg_id: Uuid::new_v4().to_string(),
                        msg_id: task.msg_id.clone(),
                        file_ids,
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
                    pinned: Vec::new(),
                };
                let options = SessionStartOptions {
                    cwd: self
                        .config
                        .agent
                        .cwd
                        .as_ref()
                        .map(|path| path.display().to_string()),
                    mcp_servers: self.mcp_servers_for_task(&task).await,
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
                // Discard history-replay chunks emitted by codex-acp's streamThreadHistory
                // during load_session, before our prompt has started streaming.
                if !guard.streaming_started {
                    return Ok(());
                }
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
        } else if let Some(SessionUpdateTrace {
            title,
            status,
            data,
        }) = describe_session_update(kind, &update)
        {
            // Structure the trace from the ACP update's OWN fields. tool_call /
            // tool_call_update carry `title` ("ls -la …"), `kind` and `status`
            // per the ACP schema; we pass those through instead of a generic
            // label. A `plan` update also carries structured `data` (its to-do
            // entries) so the channel can render a live task panel. Noise
            // (usage_update, mode/config) is filtered by the helper.
            self.trace_with_data(&run, kind, &status, &title, None, data)
                .await?;
        }
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

    async fn mcp_servers_for_task(&self, _task: &TaskCommand) -> Value {
        // stdio MCP is the ACP baseline transport (always supported); only the
        // optional http/sse transports are gated by mcpCapabilities. We drop a
        // configured http/sse server the agent can't speak with a LOUD warning
        // rather than injecting it silently — otherwise the fs-via-MCP virtual
        // filesystem would just vanish with no signal.
        let (supports_http, supports_sse) = {
            let adapter = self.adapter.lock().await;
            (adapter.supports_mcp_http(), adapter.supports_mcp_sse())
        };
        let configured = self
            .config
            .agent
            .mcp_servers
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut servers: Vec<Value> = Vec::with_capacity(configured.len() + 1);
        for server in configured {
            if mcp_server_supported(&server, supports_http, supports_sse) {
                servers.push(server);
            } else {
                let transport = mcp_server_transport(&server);
                let name = server
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("<unnamed>");
                tracing::warn!(
                    account = %self.account_id,
                    transport,
                    server = name,
                    "dropping MCP server: agent does not advertise the required \
                     mcpCapabilities transport (its MCP tools will be unavailable)"
                );
            }
        }
        if self.config.policy.mcp.inject_cheers {
            // The cheers server is stdio (command-based) — the ACP baseline
            // transport, supported by every agent — so it needs no capability
            // gate (mcpCapabilities only advertises the optional http/sse
            // transports).
            // Single shared MCP server process across all sessions.
            // CHANNEL_ID is not set via env — the ACP agent must pass
            // channel_id explicitly in every tool call (it knows the
            // channel context from the task trigger).
            // This avoids spawning one process per channel.
            servers.push(json!({
                "name": "cheers",
                "command": resolve_mcp_server_command(),
                "args": [],
                // ACP (claude-agent-acp >=0.36) requires env as an array of
                // {name, value} entries, not a map. See session/new schema.
                "env": [
                    {"name": "CHEERS_RESOURCE_URL", "value": self.loopback.url.clone()},
                    {"name": "CHEERS_RESOURCE_TOKEN", "value": self.loopback.token.clone()},
                    {"name": "CHEERS_BOT_ID", "value": self.account_id.clone()},
                    {"name": "CHEERS_REQUEST_TIMEOUT_MS", "value": self.config.policy.loopback.request_timeout_ms.to_string()}
                ]
            }));
        }
        Value::Array(servers)
    }

    async fn trace(
        &self,
        run: &Arc<Mutex<ActiveRun>>,
        phase: &str,
        status: &str,
        title: &str,
        message: Option<&str>,
    ) -> anyhow::Result<()> {
        self.trace_with_data(run, phase, status, title, message, None)
            .await
    }

    /// Like [`trace`], but also carries a structured `data` payload (e.g. an
    /// agent plan's to-do entries) so a remote observer gets more than a label.
    async fn trace_with_data(
        &self,
        run: &Arc<Mutex<ActiveRun>>,
        phase: &str,
        status: &str,
        title: &str,
        message: Option<&str>,
        data: Option<Value>,
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
                data,
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
    channel_names: std::collections::HashMap<String, String>,
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
    /// File ids the agent created this turn via inbox_deliver / inbox_stage
    /// (channel.files.create / .stage). Attached to the Done reply so they surface
    /// as chat attachments — a staged file otherwise has no UI entry point to realize.
    created_file_ids: Vec<String>,
    /// False until adapter.prompt() is called; guards against codex-acp replaying
    /// prior-session history as agent_message_chunk notifications during load_session.
    streaming_started: bool,
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
    /// Pinned convention/prompt blocks, prepended to the prompt every request.
    pinned: Vec<String>,
}

enum RuntimeInput {
    Control(ControlInbound),
    Data(DataInbound),
    Adapter(RuntimeEvent),
    Loopback(LoopbackRequest),
    SocketClosed(&'static str),
    SocketError {
        stream: &'static str,
        error: String,
    },
    /// Broadcast to all pending loopback requests when the data WS closes mid-flight.
    AbortPendingResources,
}

mod config;
mod frames;
mod io;
mod permission;
mod prompt;
mod signing;

use frames::*;
use io::*;
use prompt::*;
use signing::*;

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
            pinned: vec!["[Pinned: prompts/review.md]\nYou are a strict reviewer.".to_string()],
        };
        let prompt = build_prompt(&task, &test_prompt_policy(true), Some("#general"), false);
        let text = prompt[0]["text"].as_str().expect("text block");
        assert!(text.contains("@bot summarize"));
        assert!(text.contains("report.pdf"));
        assert!(text.contains("channel_id=channel-1"));
        assert!(text.contains("channel_name=\"#general\""));
        assert!(
            text.contains("You are a strict reviewer."),
            "pinned convention block must be injected every prompt"
        );
    }

    fn image_attachment() -> AttachmentInfo {
        AttachmentInfo {
            file_id: Some("img-1".to_string()),
            filename: Some("shot.png".to_string()),
            content_type: Some("image/png".to_string()),
            size_bytes: Some(8),
            summary: None,
            is_image: Some(json!(true)),
            image_b64: Some("aGVsbG8=".to_string()),
            extra: serde_json::Map::new(),
        }
    }

    fn image_task() -> TaskCommand {
        TaskCommand {
            task_id: "task-1".to_string(),
            channel_id: "channel-1".to_string(),
            msg_id: "msg-1".to_string(),
            provider_session_key: "provider".to_string(),
            session_id: None,
            trigger_message: Some(json!({"text": "@bot look"})),
            attachments: vec![image_attachment()],
            pinned: Vec::new(),
        }
    }

    #[test]
    fn build_prompt_emits_image_block_only_when_capability_allows() {
        // Agent advertised promptCapabilities.image → real ACP image block, and
        // no redundant text summary line for that image.
        let prompt = build_prompt(&image_task(), &test_prompt_policy(true), Some("#c"), true);
        let image = prompt
            .iter()
            .find(|block| block["type"] == "image")
            .expect("image content block present when capability allows");
        assert_eq!(image["mimeType"], "image/png");
        assert_eq!(image["data"], "aGVsbG8=");
        assert!(
            !prompt[0]["text"]
                .as_str()
                .unwrap()
                .contains("Cheers attachments:"),
            "image sent as a block should not also appear as a text summary"
        );
    }

    #[test]
    fn build_prompt_degrades_image_to_text_when_capability_absent() {
        // Agent did NOT advertise image support → no image block; the image
        // degrades to a text summary line so the agent still knows it exists.
        let prompt = build_prompt(&image_task(), &test_prompt_policy(true), Some("#c"), false);
        assert!(
            prompt.iter().all(|block| block["type"] != "image"),
            "no image block may be sent when the agent can't read images"
        );
        assert!(prompt[0]["text"].as_str().unwrap().contains("shot.png"));
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

    #[test]
    fn resource_req_serializes_without_session_id() {
        let req = DataOutbound::ResourceReq {
            v: BRIDGE_PROTOCOL_VERSION,
            req_id: "req-1".to_string(),
            resource: "channel.info".to_string(),
            params: Some(json!({"channel_id": "ch-1"})),
            encrypted: None,
            encrypted_payload: None,
            acp_capability: None,
        };
        let json = serde_json::to_value(&req).expect("serialize");
        assert_eq!(json["type"], "resource_req");
        assert_eq!(json["req_id"], "req-1");
        assert_eq!(json["resource"], "channel.info");
        // session_id must NOT appear in the wire format
        assert!(
            json.get("session_id").is_none(),
            "session_id is dead metadata and must not be serialized"
        );
    }

    #[test]
    fn prompt_includes_channel_id_and_name() {
        let task = TaskCommand {
            task_id: "task-1".to_string(),
            channel_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            msg_id: "msg-1".to_string(),
            provider_session_key: "default:testbot".to_string(),
            session_id: None,
            trigger_message: Some(json!({"text": "@testbot hello"})),
            attachments: Vec::new(),
            pinned: Vec::new(),
        };
        let prompt = build_prompt(&task, &test_prompt_policy(true), Some("#general"), false);
        let text = prompt[0]["text"].as_str().expect("text block");
        assert!(
            text.contains("channel_id=550e8400"),
            "prompt must include channel_id"
        );
        assert!(
            text.contains("channel_name=\"#general\""),
            "prompt must include channel_name"
        );
        assert!(
            text.contains("@testbot hello"),
            "prompt must include trigger message"
        );
    }

    #[test]
    fn prompt_without_channel_name_still_includes_channel_id() {
        let task = TaskCommand {
            task_id: "task-1".to_string(),
            channel_id: "chan-1".to_string(),
            msg_id: "msg-1".to_string(),
            provider_session_key: "default:testbot".to_string(),
            session_id: None,
            trigger_message: None,
            attachments: Vec::new(),
            pinned: Vec::new(),
        };
        let prompt = build_prompt(&task, &test_prompt_policy(false), None, false);
        let text = prompt[0]["text"].as_str().expect("text block");
        assert!(
            text.contains("channel_id=chan-1"),
            "prompt must include channel_id even without channel_name"
        );
        // channel_name should NOT appear when absent
        assert!(
            !text.contains("channel_name="),
            "channel_name must not appear when not available"
        );
    }
}
