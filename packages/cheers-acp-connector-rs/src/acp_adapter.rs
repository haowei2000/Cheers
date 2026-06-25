#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
        self.initialize_response
            .as_ref()
            .and_then(|value| value.get("agentCapabilities"))
            .and_then(|value| value.get("loadSession"))
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

    /// Temporary stopgap: if a permission mode is configured, push it to the
    /// agent via ACP `session/set_mode`. Best-effort — a rejected/unknown mode
    /// is logged, not fatal. The full design stores this in platform bot config.
    async fn apply_permission_mode(&mut self, session_id: &str) {
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

#[async_trait]
impl RuntimeAdapter for AcpAdapter {
    async fn start(&mut self) -> anyhow::Result<Value> {
        self.spawn_peer().await?;
        let response = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": self.config.client_capabilities.clone().unwrap_or_else(|| json!({
                        "fs": {
                            "readTextFile": false,
                            "writeTextFile": false
                        },
                        "terminal": false
                    })),
                    "clientInfo": {
                        "name": "cce-acp-connector",
                        "title": "Cheers ACP Connector",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
                self.request_timeout_ms(),
            )
            .await?;
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
        self.apply_permission_mode(&session_id).await;
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
                    "mcpServers": options.mcp_servers,
                }),
                self.request_timeout_ms(),
            )
            .await?;
        self.apply_permission_mode(session_id).await;
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
            handle_peer_request(account_id, writer, event_tx, id, value).await?;
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
        handle_peer_notification(event_tx, value).await?;
    }
    Ok(())
}

async fn handle_peer_notification(
    event_tx: &mpsc::Sender<RuntimeEvent>,
    value: Value,
) -> anyhow::Result<()> {
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "session/update" {
        return Ok(());
    }
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let acp_session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if acp_session_id.is_empty() {
        return Ok(());
    }
    let update = params.get("update").cloned().unwrap_or(Value::Null);
    event_tx
        .send(RuntimeEvent::SessionUpdate {
            acp_session_id,
            update,
        })
        .await
        .context("failed to forward ACP session/update")?;
    Ok(())
}

async fn handle_peer_request(
    account_id: &str,
    writer: &SharedWriter,
    event_tx: &mpsc::Sender<RuntimeEvent>,
    id: u64,
    value: Value,
) -> anyhow::Result<()> {
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "session/request_permission" {
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
        write_json_line(
            writer,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "outcome": {
                        "outcome": "cancelled"
                    }
                }
            }),
        )
        .await?;
        return Ok(());
    }

    let (tx, rx) = oneshot::channel();
    event_tx
        .send(RuntimeEvent::PermissionRequest {
            acp_session_id,
            params,
            respond_to: tx,
        })
        .await
        .with_context(|| {
            format!("failed to forward ACP permission request account={account_id}")
        })?;
    let outcome = rx.await.unwrap_or(PermissionOutcome::Cancelled);
    write_json_line(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "outcome": outcome.to_acp_value()
            }
        }),
    )
    .await?;
    Ok(())
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
    fn permission_options_normalize_acp_option_ids() {
        let (tx, _rx) = mpsc::channel(4);
        let adapter = AcpAdapter::new(
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
                mcp_servers: Value::Array(Vec::new()),
                client_capabilities: None,
            },
            tx,
        );
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
