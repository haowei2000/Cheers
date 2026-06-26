use super::*;

#[derive(Clone)]
pub(super) struct BridgeIoHandle {
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
    pub(super) async fn send_control(&self, frame: ControlOutbound) -> anyhow::Result<()> {
        self.control_tx
            .send(frame)
            .await
            .context("control writer closed")
    }

    pub(super) async fn send_data(&self, frame: DataOutbound) -> anyhow::Result<()> {
        self.data_tx.send(frame).await.context("data writer closed")
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

pub(super) fn spawn_control_socket(
    mut socket: crate::bridge::BridgeWebSocket,
    mut out_rx: mpsc::Receiver<ControlOutbound>,
    runtime_tx: mpsc::Sender<RuntimeInput>,
    config: BridgeSessionConfig,
    _ready: BridgeReady,
) {
    tokio::spawn(async move {
        let mut next_heartbeat = Instant::now() + config.heartbeat_interval;
        tracing::debug!("control socket read loop started");
        loop {
            while let Ok(frame) = out_rx.try_recv() {
                if socket.send_json(&frame).await.is_err() {
                    tracing::warn!("control socket send failed → closing");
                    let _ = runtime_tx.send(RuntimeInput::SocketClosed("control")).await;
                    return;
                }
            }
            if Instant::now() >= next_heartbeat {
                if socket.send_json(&ControlOutbound::Ping).await.is_err() {
                    tracing::warn!("control socket heartbeat failed → closing");
                    let _ = runtime_tx.send(RuntimeInput::SocketClosed("control")).await;
                    return;
                }
                next_heartbeat = Instant::now() + config.heartbeat_interval;
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
                Ok(Ok(None)) | Ok(Err(_)) => {
                    let _ = runtime_tx.send(RuntimeInput::SocketClosed("control")).await;
                    return;
                }
                Err(_elapsed) => {
                    // Timeout — expected, just loop back to check heartbeats/outgoing
                }
            }
        }
    });
}

pub(super) fn spawn_data_socket(
    mut socket: crate::bridge::BridgeWebSocket,
    mut out_rx: mpsc::Receiver<DataOutbound>,
    runtime_tx: mpsc::Sender<RuntimeInput>,
    config: BridgeSessionConfig,
    mut signer: Option<CapabilitySigner>,
    _last_event_seq: Arc<AtomicU64>,
) {
    tokio::spawn(async move {
        let mut next_heartbeat = Instant::now() + config.heartbeat_interval;
        tracing::debug!("data socket read loop started");
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
                if socket.send_json(&frame).await.is_err() {
                    let _ = runtime_tx.send(RuntimeInput::SocketClosed("data")).await;
                    return;
                }
            }
            if Instant::now() >= next_heartbeat {
                if socket.send_json(&DataOutbound::Ping).await.is_err() {
                    let _ = runtime_tx.send(RuntimeInput::SocketClosed("data")).await;
                    return;
                }
                next_heartbeat = Instant::now() + config.heartbeat_interval;
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
                Ok(Ok(None)) | Ok(Err(_)) => {
                    let _ = runtime_tx.send(RuntimeInput::SocketClosed("data")).await;
                    return;
                }
                Err(_elapsed) => {
                    // Timeout — expected
                }
            }
        }
    });
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
