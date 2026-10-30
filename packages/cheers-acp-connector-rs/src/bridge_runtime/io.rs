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
    pending_terminal_acks: Arc<Mutex<HashMap<String, PendingTerminalAck>>>,
    pending_file_upload_acks: Arc<Mutex<HashMap<String, oneshot::Sender<DataInbound>>>>,
    pending_task_acceptances: Arc<Mutex<HashMap<String, PendingTaskAcceptance>>>,
    ack_timeout: Duration,
    terminal_ack_timeout: Duration,
    send_ack_enabled: bool,
    terminal_ack_enabled: bool,
    file_upload_enabled: bool,
    /// Largest decoded upload the gateway accepts, when it advertises one.
    file_upload_max_bytes: Option<u64>,
    task_acceptance_enabled: bool,
    terminal_replay_enabled: bool,
    #[cfg(test)]
    terminal_test_ack: bool,
    last_event_seq: Arc<AtomicU64>,
}

struct PendingTaskAcceptance {
    identity: tasks::TaskIdentity,
    reply: oneshot::Sender<ControlInbound>,
}

struct PendingTerminalAck {
    msg_id: String,
    reply: oneshot::Sender<DataInbound>,
}

impl BridgeIoHandle {
    pub(super) fn file_upload_enabled(&self) -> bool {
        self.file_upload_enabled
    }

    pub(super) fn file_upload_max_bytes(&self) -> Option<u64> {
        self.file_upload_max_bytes
    }

    pub(super) fn task_acceptance_enabled(&self) -> bool {
        self.task_acceptance_enabled
    }

    pub(super) fn terminal_replay_enabled(&self) -> bool {
        self.terminal_replay_enabled && self.terminal_ack_enabled
    }

    pub(super) async fn request_task_acceptance(
        &self,
        identity: tasks::TaskIdentity,
    ) -> anyhow::Result<ControlInbound> {
        if !self.task_acceptance_enabled {
            return Err(anyhow!("gateway does not support durable task acceptance"));
        }
        let key = identity.execution_id.clone();
        let request = identity.request();
        let (reply, receiver) = oneshot::channel();
        self.pending_task_acceptances
            .lock()
            .await
            .insert(key.clone(), PendingTaskAcceptance { identity, reply });
        // Cap both queueing and waiting. A missing grant never permits ACP work.
        let result = timeout(self.ack_timeout.min(Duration::from_secs(30)), async {
            self.send_control(request).await?;
            receiver.await.context("task acceptance waiter closed")
        })
        .await;
        self.pending_task_acceptances.lock().await.remove(&key);
        match result {
            Ok(result) => result,
            Err(_) => Err(anyhow!("task acceptance timeout execution_id={key}")),
        }
    }

    pub(super) async fn resolve_task_acceptance(&self, frame: &ControlInbound) -> bool {
        let ControlInbound::TaskAcceptance { execution_id, .. } = frame else {
            return false;
        };
        let mut pending = self.pending_task_acceptances.lock().await;
        if !pending
            .get(execution_id)
            .is_some_and(|entry| entry.identity.matches(frame))
        {
            return false;
        }
        pending
            .remove(execution_id)
            .is_some_and(|entry| entry.reply.send(frame.clone()).is_ok())
    }

    #[cfg(test)]
    pub(super) fn enable_task_acceptance_for_test(&mut self, wait: Duration) {
        self.task_acceptance_enabled = true;
        self.terminal_replay_enabled = true;
        self.ack_timeout = wait;
    }

    #[cfg(test)]
    pub(super) fn enable_file_upload_for_test(&mut self, wait: Duration) {
        self.file_upload_enabled = true;
        self.ack_timeout = wait;
    }

    #[cfg(test)]
    pub(super) fn real_terminal_ack_for_test(&mut self, wait: Duration) {
        self.terminal_test_ack = false;
        self.terminal_ack_timeout = wait;
        self.terminal_replay_enabled = true;
    }

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
            return Err(anyhow!(
                "gateway does not support committed terminal acknowledgements"
            ));
        }
        #[cfg(test)]
        if self.terminal_test_ack {
            let msg_id = crate::terminal_outbox::terminal_ids(&frame)
                .unwrap()
                .1
                .to_string();
            self.send_data(frame).await?;
            return Ok(DataInbound::TerminalAck {
                v: BRIDGE_PROTOCOL_VERSION,
                client_msg_id,
                ok: true,
                msg_id: Some(msg_id),
                queued: None,
                job_id: None,
                error: None,
                code: None,
                retryable: None,
            });
        }
        let (tx, rx) = oneshot::channel();
        self.pending_terminal_acks.lock().await.insert(
            client_msg_id.clone(),
            PendingTerminalAck {
                msg_id: crate::terminal_outbox::terminal_ids(&frame)
                    .unwrap()
                    .1
                    .to_string(),
                reply: tx,
            },
        );
        let result = timeout(self.terminal_ack_timeout, async {
            self.send_data(frame).await?;
            rx.await.context("terminal_ack waiter closed")
        })
        .await;
        self.pending_terminal_acks
            .lock()
            .await
            .remove(&client_msg_id);
        match result {
            Ok(result) => result,
            Err(_) => Err(anyhow!(
                "terminal_ack timeout client_msg_id={client_msg_id}"
            )),
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
            return Err(anyhow!("gateway does not accept file_upload"));
        }
        let wait = file_upload_ack_timeout(self.ack_timeout, &frame);
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
        match timeout(wait, rx).await {
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
            DataInbound::TerminalAck {
                v,
                client_msg_id,
                msg_id,
                ok,
                queued,
                job_id,
                ..
            } => {
                let mut pending = self.pending_terminal_acks.lock().await;
                let matches = *v == BRIDGE_PROTOCOL_VERSION
                    && pending.get(client_msg_id).is_some_and(|entry| {
                        msg_id
                            .as_ref()
                            .map_or(!ok, |message| message == &entry.msg_id)
                            && (!ok || (*queued != Some(true) && job_id.is_none()))
                    });
                if !matches {
                    return false;
                }
                pending
                    .remove(client_msg_id)
                    .is_some_and(|entry| entry.reply.send(frame.clone()).is_ok())
            }
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

/// A [`BridgeIoHandle`] plus the receiving ends its frames land in.
///
/// Holding every receiver matters: a sender whose receiver was dropped makes the
/// runtime's sends fail as "writer closed", which would look like a Bridge
/// outage rather than the test it is.
#[cfg(test)]
pub(super) struct TestIo {
    pub(super) handle: BridgeIoHandle,
    pub(super) control: mpsc::Receiver<ControlOutbound>,
    pub(super) priority: mpsc::Receiver<DataOutbound>,
    pub(super) stream: mpsc::Receiver<DataOutbound>,
}

/// Wire an io handle to plain channels instead of a socket.
///
/// The real handle can only come from [`spawn_bridge_io`], which needs two live
/// WebSockets, so a test of the runtime's orchestration would otherwise have to
/// stand up a Bridge. Both ack modes are off, matching a Gateway that advertises
/// neither for ordinary sends. Terminal tests explicitly emulate a committed
/// ACK on an enabled capability; disabling support still fails closed.
#[cfg(test)]
pub(super) fn test_io() -> TestIo {
    let (control_tx, control) = mpsc::channel(256);
    let (priority_data_tx, priority) = mpsc::channel(PRIORITY_DATA_QUEUE_CAPACITY);
    let (stream_data_tx, stream) = mpsc::channel(STREAM_DATA_QUEUE_CAPACITY);
    TestIo {
        handle: BridgeIoHandle {
            control_tx,
            priority_data_tx,
            stream_data_tx,
            pending_send_acks: Arc::new(Mutex::new(HashMap::new())),
            pending_terminal_acks: Arc::new(Mutex::new(HashMap::new())),
            pending_file_upload_acks: Arc::new(Mutex::new(HashMap::new())),
            pending_task_acceptances: Arc::new(Mutex::new(HashMap::new())),
            ack_timeout: Duration::from_secs(5),
            terminal_ack_timeout: Duration::from_secs(5),
            send_ack_enabled: false,
            terminal_ack_enabled: true,
            file_upload_enabled: false,
            file_upload_max_bytes: None,
            task_acceptance_enabled: false,
            terminal_replay_enabled: false,
            terminal_test_ack: true,
            last_event_seq: Arc::new(AtomicU64::new(0)),
        },
        control,
        priority,
        stream,
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
        control_hello,
        data_hello,
        memberships: _,
    } = session.into_parts();
    let (control_tx, control_rx) = mpsc::channel(256);
    let (priority_data_tx, priority_data_rx) = mpsc::channel(PRIORITY_DATA_QUEUE_CAPACITY);
    let (stream_data_tx, stream_data_rx) = mpsc::channel(STREAM_DATA_QUEUE_CAPACITY);
    let last_event_seq = Arc::new(AtomicU64::new(data_hello.last_event_seq));
    let data_capabilities = data_hello.server_capabilities.clone();
    let mut signer = signer;
    if let Some(signer) = signer.as_mut() {
        signer.set_delta_capability_mode(
            data_capabilities
                .as_ref()
                .and_then(|cap| cap.delta_capability.as_deref()),
        );
    }
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
        pending_task_acceptances: Arc::new(Mutex::new(HashMap::new())),
        ack_timeout,
        terminal_ack_timeout,
        send_ack_enabled: capability_enabled(&data_capabilities, |cap| cap.send_ack),
        terminal_ack_enabled: data_capabilities.as_ref().and_then(|cap| cap.terminal_ack)
            == Some(true),
        // `true` or a limits object enables it; an older gateway sends `false`.
        file_upload_enabled: data_capabilities
            .as_ref()
            .and_then(|cap| cap.file_upload.as_ref())
            .is_some_and(|value| matches!(value, Value::Bool(true) | Value::Object(_))),
        file_upload_max_bytes: data_capabilities
            .as_ref()
            .and_then(|cap| cap.file_upload.as_ref())
            .and_then(|value| value.get("max_bytes"))
            .and_then(Value::as_u64),
        task_acceptance_enabled: control_hello
            .server_capabilities
            .as_ref()
            .and_then(|cap| cap.task_acceptance)
            == Some(true),
        terminal_replay_enabled: terminal_replay_supported(
            &control_hello.server_capabilities,
            &data_capabilities,
        ),
        #[cfg(test)]
        terminal_test_ack: false,
        last_event_seq,
    }
}

fn terminal_replay_supported(
    control: &Option<ServerCapabilities>,
    data: &Option<ServerCapabilities>,
) -> bool {
    control.as_ref().and_then(|cap| cap.terminal_replay) == Some(true)
        && data.as_ref().and_then(|cap| cap.terminal_replay) == Some(true)
}

/// Bytes of payload granted one extra second of ack wait.
const FILE_UPLOAD_BYTES_PER_SEC: u64 = 256 * 1024;
const FILE_UPLOAD_MAX_ACK_WAIT: Duration = Duration::from_secs(120);

/// A file_upload ack arrives only after the gateway has stored the bytes, so its
/// wait grows with the payload instead of reusing the small-frame ack timeout.
fn file_upload_ack_timeout(base: Duration, frame: &DataOutbound) -> Duration {
    let payload = match frame {
        DataOutbound::FileUpload { data_b64, .. } => data_b64.len() as u64,
        _ => 0,
    };
    (base + Duration::from_secs(payload / FILE_UPLOAD_BYTES_PER_SEC))
        .min(FILE_UPLOAD_MAX_ACK_WAIT.max(base))
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
                            if runtime_tx
                                .send(RuntimeInput::Control(Box::new(frame)))
                                .await
                                .is_err()
                            {
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
                                    &mut delta_deadline,
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
                        if !push_or_flush_delta(
                            &mut socket,
                            &mut signer,
                            &runtime_tx,
                            &mut pending_delta,
                            &mut delta_deadline,
                            delta,
                        ).await {
                            return;
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
                            if let (Some(signer), DataInbound::Error { error }) =
                                (signer.as_mut(), &frame)
                            {
                                signer.observe_bridge_error(error);
                            }
                            if runtime_tx
                                .send(RuntimeInput::Data(Box::new(frame)))
                                .await
                                .is_err()
                            {
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
///
/// The flush deadline is armed only when a new batch starts. Re-arming it on
/// every merge would hold a fast token stream until the byte cap, turning
/// smooth streaming into large bursts.
async fn push_or_flush_delta(
    socket: &mut crate::bridge::BridgeWebSocket,
    signer: &mut Option<CapabilitySigner>,
    runtime_tx: &mpsc::Sender<RuntimeInput>,
    pending: &mut Option<DataOutbound>,
    deadline: &mut tokio::time::Instant,
    next: DataOutbound,
) -> bool {
    let Some(current) = pending.as_mut() else {
        *pending = Some(next);
        *deadline = tokio::time::Instant::now() + DELTA_COALESCE_WINDOW;
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
            *deadline = tokio::time::Instant::now() + DELTA_COALESCE_WINDOW;
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
    #[test]
    fn terminal_replay_requires_explicit_support_on_both_connections() {
        let enabled: ServerCapabilities =
            serde_json::from_value(json!({"terminal_replay": true})).unwrap();
        let disabled: ServerCapabilities =
            serde_json::from_value(json!({"terminal_replay": false})).unwrap();
        let absent: ServerCapabilities = serde_json::from_value(json!({})).unwrap();
        for control in [&None, &Some(disabled.clone()), &Some(absent.clone())] {
            assert!(!terminal_replay_supported(control, &Some(enabled.clone())));
        }
        for data in [&None, &Some(disabled), &Some(absent)] {
            assert!(!terminal_replay_supported(&Some(enabled.clone()), data));
        }
        assert!(terminal_replay_supported(
            &Some(enabled.clone()),
            &Some(enabled)
        ));
    }

    #[test]
    fn file_upload_ack_wait_scales_with_payload_and_is_capped() {
        let upload = |len: usize| DataOutbound::FileUpload {
            v: BRIDGE_PROTOCOL_VERSION,
            client_file_id: "f".into(),
            channel_id: "c".into(),
            filename: "a.png".into(),
            content_type: None,
            data_b64: "A".repeat(len),
        };
        let base = Duration::from_secs(5);
        assert_eq!(file_upload_ack_timeout(base, &upload(8)), base);
        assert_eq!(
            file_upload_ack_timeout(base, &upload(4 * 1024 * 1024)),
            Duration::from_secs(21)
        );
        assert_eq!(
            file_upload_ack_timeout(base, &upload(64 * 1024 * 1024)),
            FILE_UPLOAD_MAX_ACK_WAIT
        );
    }

    fn terminal_fixture() -> DataOutbound {
        serde_json::from_value(json!({"type":"done","v":1,"client_msg_id":"result","msg_id":"message","content":"durable"})).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn terminal_timeout_includes_a_full_priority_queue_and_unsupported_ack_is_not_success() {
        let mut taps = test_io();
        taps.handle.terminal_ack_enabled = false;
        assert!(taps
            .handle
            .send_data_expect_terminal_ack(terminal_fixture())
            .await
            .is_err());
        assert!(taps.priority.try_recv().is_err());
        taps.handle.terminal_ack_enabled = true;
        taps.handle
            .real_terminal_ack_for_test(Duration::from_secs(1));
        for _ in 0..PRIORITY_DATA_QUEUE_CAPACITY {
            taps.handle.send_data(DataOutbound::Unknown).await.unwrap();
        }
        let io = taps.handle.clone();
        let pending =
            tokio::spawn(async move { io.send_data_expect_terminal_ack(terminal_fixture()).await });
        while taps.handle.pending_terminal_acks.lock().await.is_empty() {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(pending.await.unwrap().is_err());
        assert!(taps.handle.pending_terminal_acks.lock().await.is_empty());
        assert_eq!(taps.priority.len(), PRIORITY_DATA_QUEUE_CAPACITY);
    }

    #[tokio::test]
    async fn wrong_terminal_ack_does_not_consume_the_waiter_before_the_matching_ack() {
        let mut taps = test_io();
        taps.handle
            .real_terminal_ack_for_test(Duration::from_secs(2));
        let io = taps.handle.clone();
        let pending =
            tokio::spawn(async move { io.send_data_expect_terminal_ack(terminal_fixture()).await });
        assert!(matches!(
            taps.priority.recv().await.unwrap(),
            DataOutbound::Done { .. }
        ));
        let good = json!({"type":"terminal_ack","v":1,"client_msg_id":"result","msg_id":"message","ok":true});
        for patch in [
            json!({"v":2,"ok":false,"retryable":false}),
            json!({"msg_id":"another","ok":false,"retryable":false}),
            json!({"queued":true}),
        ] {
            let mut value = good.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(
                !taps
                    .handle
                    .resolve_data_ack(&serde_json::from_value(value).unwrap())
                    .await
            );
            assert_eq!(taps.handle.pending_terminal_acks.lock().await.len(), 1);
        }
        assert!(
            taps.handle
                .resolve_data_ack(&serde_json::from_value(good).unwrap())
                .await
        );
        assert!(terminal_ack_ok(&pending.await.unwrap().unwrap()));
    }

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

    #[tokio::test]
    async fn coalesce_deadline_is_fixed_from_first_delta_of_a_batch() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let mut texts = Vec::new();
            while let Some(Ok(msg)) = futures_util::StreamExt::next(&mut ws).await {
                if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                    texts.push(text);
                }
            }
            texts
        });
        let mut socket = crate::bridge::BridgeWebSocket::connect(&format!("ws://{addr}"), "cred")
            .await
            .unwrap();
        let (runtime_tx, _runtime_rx) = mpsc::channel(4);
        let mut signer = None;
        let mut pending = None;
        let mut deadline = tokio::time::Instant::now();

        assert!(
            push_or_flush_delta(
                &mut socket,
                &mut signer,
                &runtime_tx,
                &mut pending,
                &mut deadline,
                delta("message", 1, "a"),
            )
            .await
        );
        let first_deadline = deadline;
        tokio::time::sleep(Duration::from_millis(3)).await;
        assert!(
            push_or_flush_delta(
                &mut socket,
                &mut signer,
                &runtime_tx,
                &mut pending,
                &mut deadline,
                delta("message", 2, "b"),
            )
            .await
        );
        assert_eq!(
            deadline, first_deadline,
            "a merge must not extend the window"
        );

        assert!(
            push_or_flush_delta(
                &mut socket,
                &mut signer,
                &runtime_tx,
                &mut pending,
                &mut deadline,
                delta("other", 3, "c"),
            )
            .await
        );
        assert!(deadline > first_deadline, "a new batch re-arms the window");
        drop(socket);
        let texts = server.await.unwrap();
        // Auth frame, then the flushed "ab" batch; "c" is still pending.
        assert_eq!(texts.len(), 2);
        assert!(texts[1].contains("\"delta\":\"ab\""));
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
