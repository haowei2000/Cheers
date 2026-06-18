#![allow(dead_code)]

use std::time::Duration;

use anyhow::{anyhow, Context};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, protocol::Message},
    MaybeTlsStream, WebSocketStream,
};

pub const BRIDGE_PROTOCOL_VERSION: u32 = 1;
pub const WS_CLOSE_AUTH_FAIL: u16 = 4401;
pub const WS_CLOSE_SUPERSEDED: u16 = 4402;
pub const WS_CLOSE_BOT_UNAVAILABLE: u16 = 4403;

pub fn is_fatal_close_code(code: u16) -> bool {
    matches!(
        code,
        WS_CLOSE_AUTH_FAIL | WS_CLOSE_SUPERSEDED | WS_CLOSE_BOT_UNAVAILABLE
    )
}

fn default_bridge_protocol_version() -> u32 {
    BRIDGE_PROTOCOL_VERSION
}

fn default_auth_frame_type() -> String {
    "auth".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorInfo {
    pub name: String,
    pub version: String,
}

impl Default for ConnectorInfo {
    fn default() -> Self {
        Self {
            name: "cce-acp-connector".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 退避：指数增长但封顶 max_ms，再乘 [0.5, 1.0] 的 jitter。
    /// jitter 随机，故对每个 attempt 多取样验证结果恒落在 [0.5×cap, cap]。
    #[test]
    fn backoff_stays_within_jittered_cap() {
        let opts = ReconnectOptions {
            base_ms: 1_000,
            max_ms: 30_000,
            reset_after_ms: 30_000,
        };
        for attempt in 1..=10u32 {
            let uncapped = 1_000u64.saturating_mul(2u64.saturating_pow(attempt - 1));
            let cap = uncapped.min(opts.max_ms);
            let lower = (cap as f64 * 0.5).round() as u64;
            for _ in 0..64 {
                let ms = compute_backoff(attempt, opts).as_millis() as u64;
                assert!(
                    ms >= lower && ms <= cap,
                    "attempt {attempt}: {ms}ms 不在 [{lower}, {cap}]"
                );
            }
        }
    }

    /// 大 attempt 不溢出，稳定封顶在 max_ms（含 jitter 下界）。
    #[test]
    fn backoff_caps_at_max() {
        let opts = ReconnectOptions::default();
        let lower = (opts.max_ms as f64 * 0.5).round() as u64;
        for _ in 0..64 {
            let ms = compute_backoff(32, opts).as_millis() as u64;
            assert!(ms >= lower && ms <= opts.max_ms, "{ms}ms 超出封顶");
        }
    }

    #[test]
    fn control_task_deserializes_from_agent_bridge_v1_shape() {
        let frame: ControlInbound = serde_json::from_value(json!({
            "type": "task",
            "v": 1,
            "task_id": "task-1",
            "channel_id": "channel-1",
            "trigger_msg_id": "message-1",
            "msg_id": "message-1",
            "trigger_seq": 42,
            "depth": 0,
            "trigger": "user_message",
            "placeholder_msg_id": "placeholder-1",
            "provider_session_key": "agentnexus:workspace:w1:bot:b1",
            "session_id": "session-1",
            "session_policy": {
                "on_missing": "create",
                "on_paused": "resume",
                "after_task": "keep_active"
            },
            "trigger_message": {
                "msg_id": "message-1",
                "user": "user-1",
                "text": "@helper summarize this"
            },
            "attachments": [
                {
                    "file_id": "file-1",
                    "filename": "report.pdf",
                    "content_type": "application/pdf",
                    "size_bytes": 12345,
                    "is_image": false
                }
            ],
            "session": {
                "id": "session-1",
                "provider_session_key": "agentnexus:workspace:w1:bot:b1",
                "task_scope_id": "task-1"
            },
            "enqueued_at": "2026-06-01T10:15:30Z"
        }))
        .expect("task frame should deserialize");

        match frame {
            ControlInbound::Task {
                task_id,
                placeholder_msg_id,
                provider_session_key,
                session_policy,
                attachments,
                ..
            } => {
                assert_eq!(task_id, "task-1");
                assert_eq!(placeholder_msg_id, "placeholder-1");
                assert_eq!(provider_session_key, "agentnexus:workspace:w1:bot:b1");
                assert_eq!(
                    session_policy.expect("session_policy").after_task,
                    "keep_active"
                );
                assert_eq!(attachments.len(), 1);
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn runtime_session_control_deserializes() {
        let frame: ControlInbound = serde_json::from_value(json!({
            "type": "runtime_session_control",
            "v": 1,
            "request_id": "req-1",
            "action": "create",
            "session": {
                "id": "session-1",
                "provider_session_key": "provider-key",
                "primary_scope_type": "workspace",
                "primary_scope_id": "workspace-1"
            },
            "runtime": {
                "protocol": "acp",
                "provider_session_id": null,
                "config": {
                    "cwd": "/repo",
                    "model": "gpt-5"
                }
            },
            "reason": "user_opened_channel",
            "deadline_ms": 30000
        }))
        .expect("runtime_session_control should deserialize");

        match frame {
            ControlInbound::RuntimeSessionControl {
                request_id,
                action,
                session,
                runtime,
                deadline_ms,
                ..
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(action, "create");
                assert_eq!(session.provider_session_key, "provider-key");
                assert_eq!(runtime.protocol, "acp");
                assert_eq!(deadline_ms, Some(30000));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn data_done_serializes_with_v1_terminal_shape() {
        let frame = DataOutbound::Done {
            v: BRIDGE_PROTOCOL_VERSION,
            client_msg_id: "client-1".to_string(),
            msg_id: "placeholder-1".to_string(),
            file_ids: vec!["file-1".to_string()],
            mention_ids: vec!["user-1".to_string()],
            content: Some("final answer".to_string()),
            provider_session_key: Some("provider-key".to_string()),
            provider_session_id: Some("acp-session-1".to_string()),
            session_id: Some("session-1".to_string()),
            acp_capability: None,
        };
        let value = serde_json::to_value(frame).expect("done should serialize");
        assert_eq!(value["type"], "done");
        assert_eq!(value["v"], 1);
        assert_eq!(value["client_msg_id"], "client-1");
        assert_eq!(value["msg_id"], "placeholder-1");
        assert_eq!(value["mention_ids"][0], "user-1");
    }

    #[test]
    fn data_terminal_ack_deserializes() {
        let frame: DataInbound = serde_json::from_value(json!({
            "type": "terminal_ack",
            "v": 1,
            "client_msg_id": "client-1",
            "ok": true,
            "msg_id": "placeholder-1"
        }))
        .expect("terminal ack should deserialize");

        match frame {
            DataInbound::TerminalAck {
                client_msg_id,
                ok,
                msg_id,
                ..
            } => {
                assert_eq!(client_msg_id, "client-1");
                assert!(ok);
                assert_eq!(msg_id.as_deref(), Some("placeholder-1"));
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn resource_response_deserializes_by_req_id() {
        let frame: DataInbound = serde_json::from_value(json!({
            "type": "resource_res",
            "v": 1,
            "req_id": "r1",
            "ok": true,
            "data": {
                "channel_id": "channel-1"
            }
        }))
        .expect("resource response should deserialize");

        match frame {
            DataInbound::ResourceRes { response } => {
                assert_eq!(response.req_id, "r1");
                assert!(response.ok);
                assert_eq!(response.data.expect("data")["channel_id"], "channel-1");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBridgeAuth {
    #[serde(rename = "type", default = "default_auth_frame_type")]
    pub frame_type: String,
    #[serde(default = "default_bridge_protocol_version")]
    pub v: u32,
    pub token: String,
    #[serde(default = "default_bridge_protocol_version")]
    pub bridge_protocol_version: u32,
    #[serde(default)]
    pub connector: ConnectorInfo,
}

impl AgentBridgeAuth {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            frame_type: default_auth_frame_type(),
            v: BRIDGE_PROTOCOL_VERSION,
            token: token.into(),
            bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
            connector: ConnectorInfo::default(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReconnectOptions {
    pub base_ms: u64,
    pub max_ms: u64,
    pub reset_after_ms: u64,
}

impl Default for ReconnectOptions {
    fn default() -> Self {
        Self {
            base_ms: 1_000,
            max_ms: 30_000,
            reset_after_ms: 30_000,
        }
    }
}

pub fn compute_backoff(attempt: u32, opts: ReconnectOptions) -> Duration {
    let exp = opts
        .base_ms
        .saturating_mul(2_u64.saturating_pow(attempt.saturating_sub(1)));
    let capped = exp.min(opts.max_ms);
    let jitter = rand::thread_rng().gen_range(0.5..=1.0);
    Duration::from_millis((capped as f64 * jitter).round() as u64)
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub bot_token: String,
    pub control_url: String,
    pub data_url: String,
    pub reconnect: ReconnectOptions,
    pub heartbeat_interval_ms: u64,
    pub send_ack_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub channel_id: String,
    #[serde(default)]
    pub channel_name: Option<String>,
    #[serde(default)]
    pub channel_type: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub joined_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpSecurityHello {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub algorithm: Option<String>,
    #[serde(default)]
    pub require_capability: Option<bool>,
    #[serde(default)]
    pub allow_plaintext_fallback: Option<bool>,
    #[serde(default)]
    pub phase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpCapabilityEnvelope {
    pub delegation_id: String,
    pub ts: i64,
    pub nonce: String,
    pub signature: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub algorithm: Option<String>,
    #[serde(default)]
    pub kid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorControlSettings {
    #[serde(default, rename = "agentNativePermissionMode")]
    pub agent_native_permission_mode: Option<String>,
    #[serde(default, rename = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(default, rename = "requestTimeoutMs")]
    pub request_timeout_ms: Option<u64>,
    #[serde(default, rename = "promptTimeoutMs")]
    pub prompt_timeout_ms: Option<u64>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "configOptions")]
    pub config_options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorControlConfig {
    #[serde(default)]
    pub revision: Option<Value>,
    #[serde(default)]
    pub settings: Option<ConnectorControlSettings>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub last_status: Option<Value>,
    #[serde(default)]
    pub options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    #[serde(default)]
    pub auth: Option<Value>,
    #[serde(default)]
    pub task_stream: Option<String>,
    #[serde(default)]
    pub runtime_session_control: Option<bool>,
    #[serde(default)]
    pub task: Option<bool>,
    #[serde(default)]
    pub cancel: Option<bool>,
    #[serde(default)]
    pub permission_resolution: Option<bool>,
    #[serde(default)]
    pub connector_config: Option<bool>,
    #[serde(default)]
    pub config_option_set: Option<bool>,
    #[serde(default)]
    pub membership_events: Option<bool>,
    #[serde(default)]
    pub resource_req: Option<bool>,
    #[serde(default)]
    pub file_upload: Option<Value>,
    #[serde(default)]
    pub send: Option<bool>,
    #[serde(default)]
    pub send_ack: Option<bool>,
    #[serde(default)]
    pub terminal_ack: Option<bool>,
    #[serde(default)]
    pub trace: Option<bool>,
    #[serde(default)]
    pub session_update: Option<bool>,
    #[serde(default)]
    pub resume: Option<Value>,
    #[serde(default)]
    pub acp_security: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentInfo {
    #[serde(default)]
    pub file_id: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub is_image: Option<Value>,
    #[serde(default)]
    pub image_b64: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSessionRef {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub provider_session_key: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub provider_account_id: Option<String>,
    #[serde(default)]
    pub provider_agent_id: Option<String>,
    #[serde(default)]
    pub primary_scope_type: Option<String>,
    #[serde(default)]
    pub primary_scope_id: Option<String>,
    #[serde(default)]
    pub task_scope_id: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPolicy {
    pub on_missing: String,
    pub on_paused: String,
    pub after_task: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeDescriptor {
    pub protocol: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub config: Option<Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSessionControlSession {
    pub id: String,
    pub provider_session_key: String,
    #[serde(default)]
    pub primary_scope_type: Option<String>,
    #[serde(default)]
    pub primary_scope_id: Option<String>,
    #[serde(default)]
    pub task_scope_id: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSessionAckSession {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub provider_session_key: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionOption {
    pub option_id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionResolution {
    pub request_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    pub resolution: String,
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub resolved_by: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigStatusRejectedField {
    pub field: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceResponse {
    #[serde(default = "default_bridge_protocol_version")]
    pub v: u32,
    pub req_id: String,
    pub ok: bool,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeErrorFrame {
    #[serde(default = "default_bridge_protocol_version")]
    pub v: u32,
    pub code: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub client_msg_id: Option<String>,
    #[serde(default)]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ControlInbound {
    #[serde(rename = "hello")]
    Hello {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default = "default_bridge_protocol_version")]
        bridge_protocol_version: u32,
        #[serde(default)]
        stream: Option<String>,
        bot_id: String,
        bot_username: String,
        #[serde(default)]
        bot_display_name: Option<String>,
        #[serde(default)]
        connection_id: Option<String>,
        session_id: String,
        #[serde(default)]
        memberships: Vec<ChannelInfo>,
        #[serde(default)]
        acp_security: Option<AcpSecurityHello>,
        #[serde(default)]
        connector_config: Option<ConnectorControlConfig>,
        #[serde(default)]
        server_capabilities: Option<ServerCapabilities>,
    },
    #[serde(rename = "runtime_session_control")]
    RuntimeSessionControl {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        action: String,
        session: RuntimeSessionControlSession,
        runtime: RuntimeDescriptor,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        deadline_ms: Option<u64>,
    },
    #[serde(rename = "task")]
    Task {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        task_id: String,
        channel_id: String,
        trigger_msg_id: String,
        #[serde(default)]
        msg_id: Option<String>,
        #[serde(default)]
        trigger_seq: Option<i64>,
        #[serde(default)]
        depth: Option<i32>,
        #[serde(default)]
        trigger: Option<String>,
        placeholder_msg_id: String,
        provider_session_key: String,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        session_policy: Option<SessionPolicy>,
        #[serde(default)]
        trigger_message: Option<Value>,
        #[serde(default)]
        attachments: Vec<AttachmentInfo>,
        #[serde(default)]
        binding_config: Option<Value>,
        #[serde(default)]
        session: Option<RuntimeSessionRef>,
        #[serde(default)]
        enqueued_at: Option<String>,
    },
    #[serde(rename = "channel_joined")]
    ChannelJoined {
        channel: ChannelInfo,
        #[serde(default)]
        invited_by: Option<String>,
    },
    #[serde(rename = "channel_left")]
    ChannelLeft { channel_id: String, reason: String },
    #[serde(rename = "cancel")]
    Cancel {
        msg_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    #[serde(rename = "config_update")]
    ConfigUpdate {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default)]
        revision: Option<Value>,
        #[serde(default)]
        settings: Option<ConnectorControlSettings>,
        #[serde(default)]
        updated_at: Option<String>,
    },
    #[serde(rename = "config_option_set")]
    ConfigOptionSet {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        provider_session_key: Option<String>,
        config_id: String,
        value: String,
        #[serde(default)]
        updated_at: Option<String>,
    },
    #[serde(rename = "permission_resolution")]
    PermissionResolution {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(flatten)]
        resolution: PermissionResolution,
    },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "error")]
    Error {
        #[serde(flatten)]
        error: BridgeErrorFrame,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ControlOutbound {
    #[serde(rename = "auth")]
    Auth {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        token: String,
        #[serde(default = "default_bridge_protocol_version")]
        bridge_protocol_version: u32,
        #[serde(default)]
        connector: ConnectorInfo,
    },
    #[serde(rename = "ready")]
    Ready {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        connector_version: String,
        runtime: RuntimeDescriptor,
        #[serde(default)]
        connector_capabilities: Option<Value>,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "runtime_session_control_ack")]
    RuntimeSessionControlAck {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        action: String,
        ok: bool,
        #[serde(default)]
        session: Option<RuntimeSessionAckSession>,
        #[serde(default)]
        applied_at: Option<String>,
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        retryable: Option<bool>,
    },
    #[serde(rename = "config_status")]
    ConfigStatus {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default)]
        revision: Option<Value>,
        ok: bool,
        #[serde(default)]
        applied: Vec<String>,
        #[serde(default)]
        rejected: Vec<ConfigStatusRejectedField>,
    },
    #[serde(rename = "config_options")]
    ConfigOptions {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        options: Value,
    },
    #[serde(rename = "config_option_status")]
    ConfigOptionStatus {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        ok: bool,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        config_id: Option<String>,
        #[serde(default)]
        value: Option<String>,
        #[serde(default)]
        options: Option<Value>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        code: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DataInbound {
    #[serde(rename = "hello")]
    Hello {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default = "default_bridge_protocol_version")]
        bridge_protocol_version: u32,
        stream: String,
        bot_id: String,
        #[serde(default)]
        connection_id: Option<String>,
        session_id: String,
        #[serde(default)]
        last_event_seq: u64,
        #[serde(default)]
        acp_security: Option<AcpSecurityHello>,
        #[serde(default)]
        server_capabilities: Option<ServerCapabilities>,
    },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "resume_ack")]
    ResumeAck {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        replayed: u64,
        up_to_seq: u64,
    },
    #[serde(rename = "send_ack")]
    SendAck {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        ok: bool,
        #[serde(default)]
        message_id: Option<String>,
        #[serde(default)]
        finalized_placeholder: Option<bool>,
        #[serde(default)]
        permission_resolution: Option<Value>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        code: Option<String>,
    },
    #[serde(rename = "terminal_ack")]
    TerminalAck {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        ok: bool,
        #[serde(default)]
        msg_id: Option<String>,
        #[serde(default)]
        queued: Option<bool>,
        #[serde(default)]
        job_id: Option<String>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        code: Option<String>,
    },
    #[serde(rename = "file_upload_ack")]
    FileUploadAck {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default)]
        client_file_id: Option<String>,
        ok: bool,
        #[serde(default)]
        file_id: Option<String>,
        #[serde(default)]
        filename: Option<String>,
        #[serde(default)]
        content_type: Option<String>,
        #[serde(default)]
        size_bytes: Option<u64>,
        #[serde(default)]
        preview_url: Option<String>,
        #[serde(default)]
        download_url: Option<String>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        code: Option<String>,
    },
    #[serde(rename = "resource_res")]
    ResourceRes {
        #[serde(flatten)]
        response: ResourceResponse,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(flatten)]
        error: BridgeErrorFrame,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DataOutbound {
    #[serde(rename = "auth")]
    Auth {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        token: String,
        #[serde(default = "default_bridge_protocol_version")]
        bridge_protocol_version: u32,
        #[serde(default)]
        connector: ConnectorInfo,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "resume")]
    Resume {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        last_event_seq: u64,
    },
    #[serde(rename = "delta")]
    Delta {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        msg_id: String,
        seq: u64,
        delta: String,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        provider_session_id: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "done")]
    Done {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        msg_id: String,
        #[serde(default)]
        file_ids: Vec<String>,
        #[serde(default)]
        mention_ids: Vec<String>,
        #[serde(default)]
        content: Option<String>,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        provider_session_id: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        msg_id: String,
        message: String,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        provider_session_id: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "send")]
    Send {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        channel_id: String,
        text: String,
        #[serde(default)]
        in_reply_to_msg_id: Option<String>,
        #[serde(default)]
        file_ids: Vec<String>,
        #[serde(default)]
        mention_ids: Vec<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        provider_session_id: Option<String>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "file_upload")]
    FileUpload {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_file_id: String,
        channel_id: String,
        filename: String,
        #[serde(default)]
        content_type: Option<String>,
        data_b64: String,
    },
    #[serde(rename = "resource_req")]
    ResourceReq {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        req_id: String,
        resource: String,
        #[serde(default)]
        params: Option<Value>,
        #[serde(default)]
        encrypted: Option<bool>,
        #[serde(default)]
        encrypted_payload: Option<Value>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "permission_request")]
    PermissionRequest {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        channel_id: String,
        request_id: String,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        msg_id: Option<String>,
        #[serde(default)]
        acp_session_id: Option<String>,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        provider_session_id: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        body: String,
        #[serde(default)]
        tool: Option<String>,
        #[serde(default)]
        options: Vec<PermissionOption>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "session_update")]
    SessionUpdate {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        provider_session_id: Option<String>,
        #[serde(default)]
        metadata: Option<Value>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "trace")]
    Trace {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        msg_id: String,
        #[serde(default)]
        task_id: Option<String>,
        #[serde(default)]
        channel_id: Option<String>,
        #[serde(default)]
        run_id: Option<String>,
        #[serde(default)]
        session_key: Option<String>,
        #[serde(default)]
        provider_session_key: Option<String>,
        #[serde(default)]
        provider_session_id: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        stream: String,
        #[serde(default)]
        seq: Option<u64>,
        #[serde(default)]
        ts: Option<i64>,
        #[serde(default)]
        phase: Option<String>,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        data: Option<Value>,
        #[serde(default)]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
}

pub struct BridgeWebSocket {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl BridgeWebSocket {
    pub async fn connect(url: &str, bot_token: &str) -> anyhow::Result<Self> {
        let request = url
            .into_client_request()
            .with_context(|| format!("invalid websocket URL: {url}"))?;
        let (stream, _response) = connect_async(request)
            .await
            .with_context(|| format!("failed to connect websocket: {url}"))?;
        let mut socket = Self { stream };
        socket.send_json(&AgentBridgeAuth::new(bot_token)).await?;
        Ok(socket)
    }

    pub async fn send_json<T: Serialize>(&mut self, frame: &T) -> anyhow::Result<()> {
        let text = serde_json::to_string(frame)?;
        self.stream.send(Message::Text(text)).await?;
        Ok(())
    }

    pub async fn next_json(&mut self) -> anyhow::Result<Option<Value>> {
        while let Some(next) = self.stream.next().await {
            match next? {
                Message::Text(text) => return Ok(Some(serde_json::from_str(&text)?)),
                Message::Binary(bytes) => return Ok(Some(serde_json::from_slice(&bytes)?)),
                Message::Close(frame) => {
                    if let Some(frame) = frame {
                        let code = u16::from(frame.code);
                        if is_fatal_close_code(code) {
                            return Err(anyhow!(
                                "websocket closed with fatal code={} reason={}",
                                code,
                                frame.reason
                            ));
                        }
                    }
                    return Ok(None);
                }
                Message::Ping(payload) => {
                    self.stream.send(Message::Pong(payload)).await?;
                }
                Message::Pong(_) | Message::Frame(_) => {}
            }
        }
        Ok(None)
    }
}
