//! Agent Bridge WS protocol — the frame types shared by the Cheers gateway
//! (`server/`, which SENDS `*Inbound` and PARSES `*Outbound`) and the
//! `cce-acp-connector` binary (the WS client).
//!
//! Naming is from the CONNECTOR's perspective: `ControlInbound`/`DataInbound`
//! travel gateway→connector, `ControlOutbound`/`DataOutbound` travel
//! connector→gateway. The `ControlToConnector`-style aliases below read
//! naturally from either end.
//!
//! ## Wire-compat rules
//!
//! The golden fixtures in `../fixtures/` are the wire source of truth; both
//! ends' tests are pinned to them. Safe without coordination: adding optional
//! fields, dropping an explicit `null` for an absent Option, key order. NOT
//! safe without a fleet version floor: removing the `task` frame's duplicated
//! `msg_id`/session identifiers, dropping one of hello's two version fields,
//! adding `v` to the version-less frames (`cancel`, `realize_file`,
//! `workspace_req`, `pong`), or renaming `config_update.settings`' camelCase
//! keys (that casing IS the contract). `fixtures/compat/*` may only change
//! together with an explicit version gate.
//!
//! ## Future v2 negotiation (documented, deliberately not built)
//!
//! Additive `supported_versions: [..]` on `auth` and `hello`; absent ⇒
//! `[bridge_protocol_version]`; both ends select max(intersection) and stamp
//! it as `v`; empty intersection ⇒ close 4400.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BRIDGE_PROTOCOL_VERSION: u32 = 1;
pub const WS_CLOSE_AUTH_FAIL: u16 = 4401;
pub const WS_CLOSE_SUPERSEDED: u16 = 4402;
pub const WS_CLOSE_BOT_UNAVAILABLE: u16 = 4403;
/// Gateway 4400: protocol error / unsupported bridge protocol version. Fatal —
/// retrying the same handshake can never succeed, the binary must be updated.
pub const WS_CLOSE_UNSUPPORTED_PROTOCOL: u16 = 4400;

pub fn is_fatal_close_code(code: u16) -> bool {
    matches!(
        code,
        WS_CLOSE_AUTH_FAIL
            | WS_CLOSE_SUPERSEDED
            | WS_CLOSE_BOT_UNAVAILABLE
            | WS_CLOSE_UNSUPPORTED_PROTOCOL
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

impl ConnectorInfo {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
        }
    }
}

/// Deliberately anonymous: in a SHARED crate `env!("CARGO_PKG_VERSION")` would
/// report this crate's version, not the connector's — the binary passes its
/// real identity via `AgentBridgeAuth::new` (see `local_connector_info()` in
/// the connector's bridge.rs).
impl Default for ConnectorInfo {
    fn default() -> Self {
        Self::new("unknown", "0.0.0")
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
    pub fn new(token: impl Into<String>, connector: ConnectorInfo) -> Self {
        Self {
            frame_type: default_auth_frame_type(),
            v: BRIDGE_PROTOCOL_VERSION,
            token: token.into(),
            bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
            connector,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelInfo {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpSecurityHello {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_capability: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_plaintext_fallback: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpCapabilityEnvelope {
    pub delegation_id: String,
    pub ts: i64,
    pub nonce: String,
    pub signature: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnectorControlSettings {
    #[serde(
        default,
        rename = "agentNativePermissionMode",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_native_permission_mode: Option<String>,
    #[serde(
        default,
        rename = "permissionMode",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_mode: Option<String>,
    #[serde(
        default,
        rename = "requestTimeoutMs",
        skip_serializing_if = "Option::is_none"
    )]
    pub request_timeout_ms: Option<u64>,
    #[serde(
        default,
        rename = "promptTimeoutMs",
        skip_serializing_if = "Option::is_none"
    )]
    pub prompt_timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(
        default,
        rename = "configOptions",
        skip_serializing_if = "Option::is_none"
    )]
    pub config_options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorControlConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<ConnectorControlSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_stream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_session_control: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_resolution: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connector_config: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_option_set: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub membership_events: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_req: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_upload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub send_ack: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_ack: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_update: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_security: Option<bool>,
    /// Version of the connector release this gateway serves via its download
    /// proxy — the self-updater's trigger signal (see `self_update`). Absent on
    /// gateways that pin no release version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_connector_version: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_image: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_audio: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_b64: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSessionRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_scope_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSessionControlSession {
    pub id: String,
    pub provider_session_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_scope_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_scope_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_scope_id: Option<String>,
    /// The session's ACP `cwd` (absolute), if the Backend pinned one for an
    /// eager create/resume. Re-validated against `allowed_roots` by the connector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The session's ACP `additionalDirectories`, re-validated against `allowed_roots`.
    #[serde(default)]
    pub additional_dirs: Vec<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSessionAckSession {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionOption {
    pub option_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionResolution {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub resolution: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Human acknowledgment of a forwarded `auth_required` card.
/// `action` is `"retry"` (re-run ACP authenticate) or `"cancel"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthAcknowledgment {
    pub request_id: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeErrorFrame {
    #[serde(default = "default_bridge_protocol_version")]
    pub v: u32,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream: Option<String>,
        bot_id: String,
        bot_username: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bot_display_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        session_id: String,
        #[serde(default)]
        memberships: Vec<ChannelInfo>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_security: Option<AcpSecurityHello>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connector_config: Option<ConnectorControlConfig>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deadline_ms: Option<u64>,
    },
    #[serde(rename = "task")]
    Task {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        task_id: String,
        channel_id: String,
        trigger_msg_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        msg_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trigger_seq: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        depth: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trigger: Option<String>,
        placeholder_msg_id: String,
        provider_session_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_policy: Option<SessionPolicy>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trigger_message: Option<Value>,
        #[serde(default)]
        attachments: Vec<AttachmentInfo>,
        /// Pinned context blocks (already formatted strings) prepended to the prompt
        /// every request — the channel's "convention prompt" (e.g. a prompt template).
        #[serde(default)]
        pinned: Vec<String>,
        /// Per-message resource context (docs/design/RESOURCE_CONTEXT.md): an
        /// ordered list of references to Cheers resources (plan / file / message /
        /// activity) attached to THIS invocation by a human pick or a bot handoff.
        /// Distinct from `pinned` (channel-standing, inlined): these are references
        /// the agent resolves on demand via the resource protocol, as itself
        /// (consumer-governed). Absent when the message carried no bundle.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context_bundle: Option<Value>,
        /// The session's primary working directory (ACP `cwd`), if the Backend
        /// pinned one for this session. Absolute; the connector re-validates it
        /// against `allowed_roots` and falls back to `default_cwd` when unset or
        /// rejected. Immutable for the session's lifetime.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// Extra roots for this session's effective root set (ACP
        /// `additionalDirectories`). Each is re-validated against `allowed_roots`;
        /// out-of-policy entries are dropped.
        #[serde(default)]
        additional_dirs: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding_config: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<RuntimeSessionRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enqueued_at: Option<String>,
    },
    #[serde(rename = "claim_evaluation")]
    ClaimEvaluation {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        evaluation_id: String,
        channel_id: String,
        provider_session_key: String,
        #[serde(default)]
        scope: String,
        confidence_threshold: f64,
        source_seq_from: i64,
        source_seq_to: i64,
        #[serde(default)]
        activity: Vec<Value>,
    },
    #[serde(rename = "channel_joined")]
    ChannelJoined {
        channel: ChannelInfo,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invited_by: Option<String>,
    },
    #[serde(rename = "channel_left")]
    ChannelLeft { channel_id: String, reason: String },
    #[serde(rename = "cancel")]
    Cancel {
        msg_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "config_update")]
    ConfigUpdate {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settings: Option<ConnectorControlSettings>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_at: Option<String>,
    },
    #[serde(rename = "config_option_set")]
    ConfigOptionSet {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        config_id: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_at: Option<String>,
    },
    // Session-targeted mode change (ACP session/set_mode). Distinct from the
    // bot-wide config_update.agentNativePermissionMode AND from config_option_set:
    // it value-gates on the L0 allowed_modes envelope (config_option_set checks
    // only the config id), so a delegated mode change can't escape the clamp.
    #[serde(rename = "mode_set")]
    ModeSet {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        mode: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_at: Option<String>,
    },
    #[serde(rename = "permission_resolution")]
    PermissionResolution {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(flatten)]
        resolution: PermissionResolution,
    },
    /// Human acknowledged an `auth_required` card — connector should retry
    /// ACP `authenticate` (action=`retry`) or abort the waiting turn (`cancel`).
    #[serde(rename = "auth_acknowledged")]
    AuthAcknowledged {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        /// `"retry"` | `"cancel"`
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_by: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolved_at: Option<String>,
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
        /// Optional only for PARSING legacy frames (the retired TS connector
        /// sent `plugin_version` instead) — this connector always sets it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connector_version: Option<String>,
        // wire-compat: legacy alias for connector_version, kept so a typed
        // gateway parse still accepts the retired TS connector's ready frame
        // (pinned by fixtures/compat/ready_plugin_version.json).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plugin_version: Option<String>,
        /// Optional only for PARSING (a malformed/ancient ready without a
        /// runtime descriptor must still reach the ready handler, not fall
        /// through to Unknown) — this connector always sets it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime: Option<RuntimeDescriptor>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<RuntimeSessionAckSession>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        applied_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retryable: Option<bool>,
    },
    #[serde(rename = "config_status")]
    ConfigStatus {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        options: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(other)]
    Unknown,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        session_id: String,
        #[serde(default)]
        last_event_seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_security: Option<AcpSecurityHello>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finalized_placeholder: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        permission_resolution: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(rename = "terminal_ack")]
    TerminalAck {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        msg_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queued: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(rename = "file_upload_ack")]
    FileUploadAck {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_file_id: Option<String>,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size_bytes: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preview_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        download_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
    /// Gateway → connector: realize a staged file. Connector reads the local path,
    /// base64-encodes it, and calls channel.files.realize to upload to S3.
    #[serde(rename = "realize_file")]
    RealizeFile {
        file_id: String,
        remote_ref: String,
        channel_id: String,
        /// The owning session's ACP root set (`cwd` + `additionalDirectories`). The
        /// connector confines `remote_ref` to these (∩ `allowed_roots`); empty ⇒
        /// the session's implicit root is the connector `default_cwd`.
        #[serde(default)]
        roots: Vec<String>,
    },
    /// Gateway → connector: browse/read/write the agent's real workspace, confined
    /// to `policy.workspace.allowed_roots`. Connector replies with `workspace_res`
    /// correlated by `req_id`. `op` ∈ { "ls", "read", "write", "validate_cwd",
    /// "git_status", "git_diff", "git_log", "git_show", "git_commit_files",
    /// "workspace_meta", "watch", "unwatch" }. The git ops are READ-ONLY.
    /// `workspace_meta` describes the workspace policy (allowed/effective roots,
    /// default_cwd, git availability) without touching the filesystem. `watch`
    /// starts a debounced recursive fs watcher on the resolved (clamped) dir and
    /// streams unsolicited `workspace_event` frames; `unwatch` (by `watch_id`)
    /// stops it.
    #[serde(rename = "workspace_req")]
    WorkspaceReq {
        req_id: String,
        op: String,
        #[serde(default)]
        path: String,
        /// Which allowed root to resolve `path` against (absolute path string).
        /// Defaults to the connector's default_cwd / first allowed root.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
        /// base64 file bytes for `op == "write"`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_b64: Option<String>,
        /// `op == "write"` precondition (safe remote writes). Absent/null ⇒
        /// unconditional overwrite (back-compat). `""` ⇒ create-only (fail if the
        /// file already exists). A 64-char lowercase-hex SHA-256 ⇒ overwrite only
        /// if the current file's bytes hash to it, else `E_CONFLICT`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        if_etag: Option<String>,
        /// Optional session root set to scope this browse to (`cwd` +
        /// `additionalDirectories`). Empty ⇒ the full `allowed_roots` (bot-wide
        /// browse). When set, the effective roots are these ∩ `allowed_roots`.
        #[serde(default)]
        roots: Vec<String>,
        /// `op == "git_diff"`: diff the staged index (`--staged`) instead of the
        /// working tree.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        staged: Option<bool>,
        /// `op == "git_log"`: max commits to return (clamped to ≤100 by the
        /// connector).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
        /// `op == "git_log"`: commits to skip before collecting (`--skip`), for
        /// pagination (clamped to ≤100000 by the connector).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skip: Option<u32>,
        /// `op == "git_show" | "git_commit_files"`: the commit ref (a hex hash, as
        /// emitted by `git_log`; validated `^[0-9a-fA-F]{7,64}$` before use as argv).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
        /// `op == "git_show"`: optional repo-root-relative path filter — limits the
        /// commit diff to one file (as listed by `git_commit_files`). Validated
        /// (relative, no `..`, no leading `-`/`:`) and passed as a `:(top)`-anchored
        /// pathspec after `--`, never as a flag.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        commit_path: Option<String>,
        /// `op == "unwatch"`: the `watch_id` returned by a prior `watch` reply,
        /// identifying the fs watcher to stop.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        watch_id: Option<String>,
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
    #[serde(rename = "claim_evaluation_result")]
    ClaimEvaluationResult {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        evaluation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "delta")]
    Delta {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        msg_id: String,
        seq: u64,
        delta: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        msg_id: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "send")]
    Send {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        channel_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        in_reply_to_msg_id: Option<String>,
        #[serde(default)]
        file_ids: Vec<String>,
        #[serde(default)]
        mention_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "file_upload")]
    FileUpload {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_file_id: String,
        channel_id: String,
        filename: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
        data_b64: String,
    },
    #[serde(rename = "resource_req")]
    ResourceReq {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        req_id: String,
        resource: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted_payload: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    /// Connector → gateway: reply to a `workspace_req`, correlated by `req_id`.
    #[serde(rename = "workspace_res")]
    WorkspaceRes {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        req_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Connector → gateway: UNSOLICITED filesystem-change notification for an active
    /// `watch`. Bot-scoped (no channel_id — the gateway maps bot → channels and
    /// fans out to the workspace panels). `root` is the browse root the paths are
    /// relative to; `paths` is the coalesced, de-duplicated, capped (≤50) set of
    /// changed entries; `kind` is the change class (currently always "change").
    #[serde(rename = "workspace_event")]
    WorkspaceEvent {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        root: String,
        paths: Vec<String>,
        kind: String,
    },
    #[serde(rename = "permission_request")]
    PermissionRequest {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        channel_id: String,
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        msg_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        body: String,
        /// Structured tool detail derived from the ACP `toolCall`
        /// (title / kind / raw_input / locations) so the channel card can show
        /// WHAT is being approved + a risk badge. None when the agent sent no
        /// toolCall (e.g. a plain message permission).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool: Option<Value>,
        #[serde(default)]
        options: Vec<PermissionOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    /// Tell the gateway a previously-forwarded permission request reached a
    /// terminal state locally (timeout / agent cancel) with no human decision,
    /// so the channel card stops hanging "pending" forever.
    #[serde(rename = "permission_cancel")]
    PermissionCancel {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        /// "timeout" | "cancelled"
        reason: String,
    },
    /// ACP agent authentication expired / failed mid-turn. Surfaces as a channel
    /// card so the bot owner can complete login (or set env credentials) and ack.
    #[serde(rename = "auth_required")]
    AuthRequired {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        client_msg_id: String,
        channel_id: String,
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        msg_id: Option<String>,
        method_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        link: Option<String>,
        /// ACP auth method type when known (`agent` / `env_var` / `terminal`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    /// Finalize a previously-forwarded `auth_required` card locally (timeout).
    #[serde(rename = "auth_cancel")]
    AuthCancel {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        request_id: String,
        /// "timeout" | "cancelled"
        reason: String,
    },
    #[serde(rename = "session_update")]
    SessionUpdate {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    #[serde(rename = "trace")]
    Trace {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        msg_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        stream: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ts: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        acp_capability: Option<AcpCapabilityEnvelope>,
    },
    /// Generic ACP-event passthrough (docs/arch/ACP_EVENT_TAXONOMY.md): forwards an
    /// ACP `session/update` verbatim so Cheers sees the full event surface. `name`
    /// is the registry name (e.g. `session/update:tool_call`); `payload` is the raw
    /// update. The connector stays ACP-generic — it never interprets the payload.
    #[serde(rename = "acp_event")]
    AcpEvent {
        #[serde(default = "default_bridge_protocol_version")]
        v: u32,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        msg_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_session_key: Option<String>,
        payload: Value,
    },
    #[serde(other)]
    Unknown,
}

// Directional aliases so gateway-side code reads naturally.
pub type ControlToConnector = ControlInbound;
pub type ControlToGateway = ControlOutbound;
pub type DataToConnector = DataInbound;
pub type DataToGateway = DataOutbound;
