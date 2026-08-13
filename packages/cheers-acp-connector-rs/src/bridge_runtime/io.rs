//! Concurrent Agent Bridge control/data I/O and acknowledgement correlation.
//!
//! Network waits happen outside session/run locks. Pending acknowledgements are
//! keyed by protocol identifiers and failed when their channel disconnects.

use super::*;

/// Small latency budget used to combine adjacent text chunks into one frame.
const DELTA_COALESCE_WINDOW: Duration = Duration::from_millis(12);
/// Flush before one combined frame grows large enough to hurt interactive latency.
const DELTA_COALESCE_MAX_BYTES: usize = 8 * 1024;
const PRIORITY_DATA_QUEUE_CAPACITY: usize = 64;
const STREAM_DATA_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
pub(super) struct BridgeIoHandle {
    control_tx: mpsc::Sender<ControlOutbound>,
    priority_data_tx: mpsc::Sender<DataOutbound>,
    stream_data_tx: mpsc::Sender<DataOutbound>,
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
    pub(super) async fn send_control(&self, frame: ControlOutbound) -> anyhow::Result<()> {
        self.control_tx
            .send(frame)
            .await
            .context("control writer closed")
    }

    pub(super) async fn send_data(&self, frame: DataOutbound) -> anyhow::Result<()> {
        if matches!(frame, DataOutbound::Delta { .. }) {
            self.stream_data_tx
                .send(frame)
                .await
                .context("stream data writer closed")
        } else {
            self.priority_data_tx
                .send(frame)
                .await
                .context("priority data writer closed")
        }
    }

    pub(super) async fn send_data_expect_send_ack(
        &self,
        frame: DataOutbound,
    ) -> anyhow::Result<DataInbound> {
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

    pub(super) async fn send_data_expect_terminal_ack(
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

    pub(super) async fn send_data_expect_file_upload_ack(
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

    pub(super) async fn resolve_data_ack(&self, frame: &DataInbound) -> bool {
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

pub(super) fn spawn_bridge_io(
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
    let (priority_data_tx, priority_data_rx) = mpsc::channel(PRIORITY_DATA_QUEUE_CAPACITY);
    let (stream_data_tx, stream_data_rx) = mpsc::channel(STREAM_DATA_QUEUE_CAPACITY);
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
        priority_data_rx,
        stream_data_rx,
        runtime_tx,
        config,
        signer,
        last_event_seq.clone(),
    );
    BridgeIoHandle {
        control_tx,
        priority_data_tx,
        stream_data_tx,
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

pub(super) fn spawn_control_socket(
    mut socket: crate::bridge::BridgeWebSocket,
    mut out_rx: mpsc::Receiver<ControlOutbound>,
    runtime_tx: mpsc::Sender<RuntimeInput>,
    config: BridgeSessionConfig,
    _ready: BridgeReady,
) {
    tokio::spawn(async move {
        use tokio::time::{interval_at, Instant as TokioInstant, MissedTickBehavior};
        // Event-driven instead of a 100ms poll: an outbound frame is written the instant
        // it's queued (no 0–100ms latency floor on every control frame), and the loop
        // idles with zero wakeups. First heartbeat one interval out; Delay so a stall
        // doesn't burst pings — matching the old `next_heartbeat = now + interval` reset.
        let mut hb = interval_at(
            TokioInstant::now() + config.heartbeat_interval,
            config.heartbeat_interval,
        );
        hb.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut out_open = true;
        tracing::debug!("control socket read loop started");
        loop {
            tokio::select! {
                maybe = out_rx.recv(), if out_open => match maybe {
                    Some(frame) => {
                        if socket.send_json(&frame).await.is_err() {
                            tracing::warn!("control socket send failed → closing");
                            let _ = runtime_tx.send(RuntimeInput::SocketClosed("control")).await;
                            return;
                        }
                        // Drain any further queued frames back-to-back (coalesce bursts).
                        while let Ok(frame) = out_rx.try_recv() {
                            if socket.send_json(&frame).await.is_err() {
                                tracing::warn!("control socket send failed → closing");
                                let _ = runtime_tx.send(RuntimeInput::SocketClosed("control")).await;
                                return;
                            }
                        }
                    }
                    // All senders dropped: stop forwarding outbound but keep serving inbound.
                    None => out_open = false,
                },
                _ = hb.tick() => {
                    if socket.send_json(&ControlOutbound::Ping).await.is_err() {
                        tracing::warn!("control socket heartbeat failed → closing");
                        let _ = runtime_tx.send(RuntimeInput::SocketClosed("control")).await;
                        return;
                    }
                }
                msg = socket.next_json() => match msg {
                    Ok(Some(value)) => match serde_json::from_value::<ControlInbound>(value) {
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
                    Ok(None) | Err(_) => {
                        let _ = runtime_tx.send(RuntimeInput::SocketClosed("control")).await;
                        return;
                    }
                }
            }
        }
    });
}

pub(super) fn spawn_data_socket(
    mut socket: crate::bridge::BridgeWebSocket,
    mut priority_rx: mpsc::Receiver<DataOutbound>,
    mut stream_rx: mpsc::Receiver<DataOutbound>,
    runtime_tx: mpsc::Sender<RuntimeInput>,
    config: BridgeSessionConfig,
    mut signer: Option<CapabilitySigner>,
    _last_event_seq: Arc<AtomicU64>,
) {
    tokio::spawn(async move {
        use tokio::time::{interval_at, Instant as TokioInstant, MissedTickBehavior};
        // Interactive frames bypass the short Delta coalescing window. Ordered
        // non-interactive frames flush queued Delta first and therefore remain
        // barriers for done/error/trace semantics.
        let mut hb = interval_at(
            TokioInstant::now() + config.heartbeat_interval,
            config.heartbeat_interval,
        );
        hb.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut priority_open = true;
        let mut stream_open = true;
        let mut pending_delta: Option<DataOutbound> = None;
        let mut delta_deadline = TokioInstant::now() + DELTA_COALESCE_WINDOW;
        tracing::debug!("data socket read loop started");

        loop {
            if !priority_open && !stream_open && pending_delta.is_none() {
                // Keep serving inbound frames, matching the old single-channel behavior.
                tracing::debug!("all data socket outbound senders dropped");
            }
            tokio::select! {
                maybe = priority_rx.recv(), if priority_open => match maybe {
                    Some(frame) => {
                        if !is_interactive_priority_frame(&frame) {
                            if let Some(delta) = pending_delta.take() {
                                if !write_data_frame(&mut socket, &mut signer, &runtime_tx, delta).await {
                                    return;
                                }
                            }
                            while let Ok(delta) = stream_rx.try_recv() {
                                if !push_or_flush_delta(
                                    &mut socket,
                                    &mut signer,
                                    &runtime_tx,
                                    &mut pending_delta,
                                    delta,
                                ).await {
                                    return;
                                }
                            }
                            if let Some(delta) = pending_delta.take() {
                                if !write_data_frame(&mut socket, &mut signer, &runtime_tx, delta).await {
                                    return;
                                }
                            }
                        }
                        if !write_data_frame(&mut socket, &mut signer, &runtime_tx, frame).await {
                            return;
                        }
                    }
                    None => priority_open = false,
                },
                maybe = stream_rx.recv(), if stream_open => match maybe {
                    Some(delta) => {
                        let was_empty = pending_delta.is_none();
                        if !push_or_flush_delta(
                            &mut socket,
                            &mut signer,
                            &runtime_tx,
                            &mut pending_delta,
                            delta,
                        ).await {
                            return;
                        }
                        if was_empty || pending_delta.is_some() {
                            delta_deadline = TokioInstant::now() + DELTA_COALESCE_WINDOW;
                        }
                    }
                    None => {
                        stream_open = false;
                        if let Some(delta) = pending_delta.take() {
                            if !write_data_frame(&mut socket, &mut signer, &runtime_tx, delta).await {
                                return;
                            }
                        }
                    },
                },
                _ = tokio::time::sleep_until(delta_deadline), if pending_delta.is_some() => {
                    if let Some(delta) = pending_delta.take() {
                        if !write_data_frame(&mut socket, &mut signer, &runtime_tx, delta).await {
                            return;
                        }
                    }
                },
                _ = hb.tick() => {
                    if socket.send_json(&DataOutbound::Ping).await.is_err() {
                        let _ = runtime_tx.send(RuntimeInput::SocketClosed("data")).await;
                        return;
                    }
                }
                msg = socket.next_json() => match msg {
                    Ok(Some(value)) => match serde_json::from_value::<DataInbound>(value) {
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
                    Ok(None) | Err(_) => {
                        let _ = runtime_tx.send(RuntimeInput::SocketClosed("data")).await;
                        return;
                    }
                }
            }
        }
    });
}

/// Returns true for user-blocking interaction frames that may overtake text Delta.
fn is_interactive_priority_frame(frame: &DataOutbound) -> bool {
    matches!(
        frame,
        DataOutbound::PermissionRequest { .. }
            | DataOutbound::PermissionCancel { .. }
            | DataOutbound::ElicitationRequest { .. }
            | DataOutbound::ElicitationCancel { .. }
            | DataOutbound::ElicitationComplete { .. }
            | DataOutbound::AuthRequired { .. }
            | DataOutbound::AuthCancel { .. }
    )
}

/// Signs and writes one frame, reporting a terminal socket error on failure.
async fn write_data_frame(
    socket: &mut crate::bridge::BridgeWebSocket,
    signer: &mut Option<CapabilitySigner>,
    runtime_tx: &mpsc::Sender<RuntimeInput>,
    mut frame: DataOutbound,
) -> bool {
    if let Some(signer) = signer {
        if let Err(err) = signer.attach(&mut frame) {
            let _ = runtime_tx
                .send(RuntimeInput::SocketError {
                    stream: "data",
                    error: err.to_string(),
                })
                .await;
            return false;
        }
    }
    if socket.send_json(&frame).await.is_err() {
        let _ = runtime_tx.send(RuntimeInput::SocketClosed("data")).await;
        return false;
    }
    true
}

/// Adds one Delta to the current adjacent batch or flushes the previous batch.
async fn push_or_flush_delta(
    socket: &mut crate::bridge::BridgeWebSocket,
    signer: &mut Option<CapabilitySigner>,
    runtime_tx: &mpsc::Sender<RuntimeInput>,
    pending: &mut Option<DataOutbound>,
    next: DataOutbound,
) -> bool {
    let Some(current) = pending.as_mut() else {
        *pending = Some(next);
        return true;
    };
    match merge_adjacent_delta(current, next) {
        Ok(()) => {}
        Err(next) => {
            if let Some(current) = pending.take() {
                if !write_data_frame(socket, signer, runtime_tx, current).await {
                    return false;
                }
            }
            *pending = Some(next);
        }
    }
    true
}

/// Merges compatible adjacent Delta frames and keeps the newest diagnostic seq.
fn merge_adjacent_delta(
    current: &mut DataOutbound,
    next: DataOutbound,
) -> Result<(), DataOutbound> {
    let DataOutbound::Delta {
        v: current_v,
        msg_id: current_msg_id,
        seq: current_seq,
        delta: current_delta,
        provider_session_key: current_provider_key,
        provider_session_id: current_provider_id,
        session_id: current_session_id,
        acp_capability: current_capability,
    } = current
    else {
        return Err(next);
    };
    let DataOutbound::Delta {
        v,
        msg_id,
        seq,
        delta,
        provider_session_key,
        provider_session_id,
        session_id,
        acp_capability,
    } = next
    else {
        return Err(next);
    };
    let compatible = *current_v == v
        && *current_msg_id == msg_id
        && *current_provider_key == provider_session_key
        && *current_provider_id == provider_session_id
        && *current_session_id == session_id
        && current_capability.is_none()
        && acp_capability.is_none()
        && current_delta.len().saturating_add(delta.len()) <= DELTA_COALESCE_MAX_BYTES;
    if !compatible {
        return Err(DataOutbound::Delta {
            v,
            msg_id,
            seq,
            delta,
            provider_session_key,
            provider_session_id,
            session_id,
            acp_capability,
        });
    }
    current_delta.push_str(&delta);
    *current_seq = seq;
    Ok(())
}

pub(super) async fn reconnect_control_stream(
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

pub(super) async fn reconnect_data_stream(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(msg_id: &str, seq: u64, text: impl Into<String>) -> DataOutbound {
        DataOutbound::Delta {
            v: BRIDGE_PROTOCOL_VERSION,
            msg_id: msg_id.to_string(),
            seq,
            delta: text.into(),
            provider_session_key: Some("provider-key".to_string()),
            provider_session_id: Some("acp-session".to_string()),
            session_id: Some("session".to_string()),
            acp_capability: None,
        }
    }

    #[test]
    fn adjacent_delta_frames_merge_and_keep_latest_seq() {
        let mut current = delta("message", 1, "hello ");
        merge_adjacent_delta(&mut current, delta("message", 2, "world")).expect("merge");
        match current {
            DataOutbound::Delta { seq, delta, .. } => {
                assert_eq!(seq, 2);
                assert_eq!(delta, "hello world");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn delta_merge_preserves_message_boundary_and_size_cap() {
        let mut current = delta("message-a", 1, "a");
        assert!(merge_adjacent_delta(&mut current, delta("message-b", 2, "b")).is_err());

        let mut current = delta("message", 1, "a".repeat(DELTA_COALESCE_MAX_BYTES));
        assert!(merge_adjacent_delta(&mut current, delta("message", 2, "b")).is_err());
    }

    #[test]
    fn interactive_frames_bypass_pending_delta() {
        let frame = DataOutbound::PermissionCancel {
            v: BRIDGE_PROTOCOL_VERSION,
            request_id: "request".to_string(),
            reason: "timeout".to_string(),
        };
        assert!(is_interactive_priority_frame(&frame));
        assert!(!is_interactive_priority_frame(&delta("message", 1, "text")));
    }
}
