#![allow(dead_code)]

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context};
use serde::Deserialize;
use serde_json::Value;
use tokio::fs;
use toml::Value as TomlValue;

const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub struct ConnectorConfig {
    pub accounts: BTreeMap<String, AccountConfig>,
    pub state_path: PathBuf,
    pub log_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct DaemonFileConfig {
    pub state_path: PathBuf,
    pub log_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct AccountConfig {
    pub bot_token: String,
    pub control_url: String,
    pub data_url: String,
    pub advanced: AdvancedConfig,
    pub agent: StdioAgentConfig,
    pub acp_capability: Option<AcpCapabilityConfig>,
    pub policy: LocalPolicy,
}

#[derive(Debug, Clone)]
pub struct AdvancedConfig {
    pub reconnect_base_ms: u64,
    pub reconnect_max_ms: u64,
    pub heartbeat_interval_ms: u64,
    pub send_ack_timeout_ms: u64,
}

impl Default for AdvancedConfig {
    fn default() -> Self {
        Self {
            reconnect_base_ms: 500,
            reconnect_max_ms: 30_000,
            heartbeat_interval_ms: 25_000,
            send_ack_timeout_ms: 10 * 60_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StdioAgentConfig {
    pub command: String,
    pub args: Vec<String>,
    pub model: Option<String>,
    pub cwd: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub inherit_env: bool,
    pub request_timeout_ms: u64,
    pub prompt_timeout_ms: u64,
    pub agent_native_permission_mode: Option<String>,
    /// Backend-desired ACP config options (`{configId: value}`), applied per
    /// session via `session/set_config_option` at session start — mirrors how
    /// `agent_native_permission_mode` is applied via `set_mode`. Already clamped
    /// to `allowed_config_options` at the `config_update` boundary, so the adapter
    /// applies it verbatim (ACP-generic — opaque ids/values).
    pub config_options: Option<Value>,
    pub mcp_servers: Value,
    pub client_capabilities: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct AcpCapabilityConfig {
    pub delegation_id: String,
    pub private_key: String,
    pub kid: Option<String>,
    pub algorithm: String,
    pub request_id_prefix: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LocalPolicy {
    pub sessions: SessionsPolicy,
    pub prompt: PromptPolicy,
    pub workspace: WorkspacePolicy,
    pub env: EnvPolicy,
    pub config: RuntimeConfigPolicy,
    pub permission: PermissionPolicy,
    pub send: SendPolicy,
    pub file_upload: FileUploadPolicy,
    pub trace: TracePolicy,
    pub session_update: SessionUpdatePolicy,
    pub mcp: McpPolicy,
    pub loopback: LoopbackPolicy,
}

#[derive(Debug, Clone)]
pub struct SessionsPolicy {
    pub create: bool,
    pub load: bool,
    pub cancel: bool,
    pub terminate: bool,
    pub request_timeout_ms: u64,
}

#[derive(Debug, Clone)]
pub struct PromptPolicy {
    pub allow: bool,
    pub max_concurrent: usize,
    pub max_prompt_bytes: usize,
    pub max_duration_ms: u64,
    pub allow_attachments: bool,
    pub allow_images: bool,
    pub allow_local_file_refs: bool,
}

#[derive(Debug, Clone)]
pub struct WorkspacePolicy {
    pub default_cwd: Option<PathBuf>,
    pub backend_may_set_cwd: bool,
    pub allowed_roots: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct EnvPolicy {
    pub inherit: bool,
    pub allow: Vec<String>,
    pub set: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfigPolicy {
    pub backend_may_set_model: bool,
    pub backend_may_set_native_options: bool,
    pub allowed_config_options: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PermissionPolicy {
    pub forward_to_backend: bool,
    pub wait_timeout_ms: u64,
    pub on_timeout: PermissionTimeoutAction,
    /// Auto-approve ACP tool-permission requests locally (select the "allow"
    /// option) without forwarding to the backend. Use when the gateway already
    /// enforces resource authz (channel membership + role), making the per-tool
    /// ACP prompt redundant. Default false.
    pub auto_allow: bool,
    // ── L0 set-mode envelope (ACP-generic; see BOT_CONFIG_GOVERNANCE.md) ──
    /// Whether the platform may change the session permission mode at runtime
    /// (L2 `session/set_mode`). Default true.
    pub backend_may_set_mode: bool,
    /// Opaque allow-list of ACP modeIds the platform may select via set_mode. The
    /// connector clamps a platform request by exact string match (it has NO notion
    /// of what any mode means — that's agent-specific). Empty = allow any mode the
    /// agent advertised in `session/new` → `availableModes`. The host (or the
    /// gateway's per-agent preset) decides which ids belong here.
    pub allowed_modes: Vec<String>,
}

impl PermissionPolicy {
    /// L0 clamp: whether the platform may switch the session to `mode`. Requires
    /// `backend_may_set_mode`; then `mode` must be in `allowed_modes` (empty = any).
    /// Pure string match — no agent-specific semantics. Consulted (alongside
    /// `backend_may_set_native_options`) when the backend pushes a posture mode via
    /// `config_update` → `agentNativePermissionMode`.
    pub fn may_set_mode(&self, mode: &str) -> bool {
        self.backend_may_set_mode
            && (self.allowed_modes.is_empty() || self.allowed_modes.iter().any(|m| m == mode))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionTimeoutAction {
    Cancel,
    Deny,
}

impl PermissionTimeoutAction {
    fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "cancel" => Ok(Self::Cancel),
            "deny" => Ok(Self::Deny),
            other => Err(anyhow!(
                "policy.permission.on_timeout must be \"cancel\" or \"deny\", got {other}"
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SendPolicy {
    pub allow: bool,
    pub max_text_bytes: usize,
    pub max_files: usize,
}

#[derive(Debug, Clone)]
pub struct FileUploadPolicy {
    pub allow: bool,
    pub max_bytes: u64,
    pub allowed_content_types: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TracePolicy {
    pub allow: bool,
    pub max_message_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct SessionUpdatePolicy {
    pub allow: bool,
    pub include_metadata: bool,
}

#[derive(Debug, Clone)]
pub struct McpPolicy {
    pub inject_cheers: bool,
    pub backend_may_inject_extra_servers: bool,
    pub allowed_servers: Vec<String>,
    pub servers: Value,
}

#[derive(Debug, Clone)]
pub struct LoopbackPolicy {
    pub request_timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    daemon: RawDaemon,
    accounts: BTreeMap<String, RawAccount>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDaemon {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    home_dir: Option<String>,
    #[serde(default)]
    state_path: Option<String>,
    #[serde(default)]
    log_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAccount {
    bridge: RawBridge,
    adapter: RawAdapter,
    #[serde(default)]
    policy: RawPolicy,
    #[serde(default)]
    security: RawSecurity,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBridge {
    control_url: String,
    data_url: String,
    #[serde(default)]
    bot_token_env: Option<String>,
    #[serde(default)]
    bot_token_file: Option<String>,
    #[serde(default = "default_heartbeat_interval_ms")]
    heartbeat_interval_ms: u64,
    #[serde(default = "default_send_ack_timeout_ms")]
    ack_timeout_ms: u64,
    #[serde(default)]
    reconnect: RawReconnect,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawReconnect {
    #[serde(default = "default_reconnect_base_ms")]
    base_ms: u64,
    #[serde(default = "default_reconnect_max_ms")]
    max_ms: u64,
}

impl Default for RawReconnect {
    fn default() -> Self {
        Self {
            base_ms: default_reconnect_base_ms(),
            max_ms: default_reconnect_max_ms(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAdapter {
    #[serde(rename = "type")]
    kind: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    /// Temporary stopgap: force the agent's ACP session mode on session start
    /// via `session/set_mode` (e.g. "default" to make it ask for permissions).
    /// The full design moves this into platform bot config — see
    /// docs/arch/ACP_APPROVAL_FLOW.md.
    #[serde(default)]
    permission_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPolicy {
    #[serde(default)]
    sessions: RawSessionsPolicy,
    #[serde(default)]
    prompt: RawPromptPolicy,
    #[serde(default)]
    workspace: RawWorkspacePolicy,
    #[serde(default)]
    env: RawEnvPolicy,
    #[serde(default)]
    config: RawRuntimeConfigPolicy,
    #[serde(default)]
    permission: RawPermissionPolicy,
    #[serde(default)]
    send: RawSendPolicy,
    #[serde(default)]
    file_upload: RawFileUploadPolicy,
    #[serde(default)]
    trace: RawTracePolicy,
    #[serde(default)]
    session_update: RawSessionUpdatePolicy,
    #[serde(default)]
    mcp: RawMcpPolicy,
    #[serde(default)]
    loopback: RawLoopbackPolicy,
}

impl Default for RawPolicy {
    fn default() -> Self {
        Self {
            sessions: RawSessionsPolicy::default(),
            prompt: RawPromptPolicy::default(),
            workspace: RawWorkspacePolicy::default(),
            env: RawEnvPolicy::default(),
            config: RawRuntimeConfigPolicy::default(),
            permission: RawPermissionPolicy::default(),
            send: RawSendPolicy::default(),
            file_upload: RawFileUploadPolicy::default(),
            trace: RawTracePolicy::default(),
            session_update: RawSessionUpdatePolicy::default(),
            mcp: RawMcpPolicy::default(),
            loopback: RawLoopbackPolicy::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSessionsPolicy {
    #[serde(default = "default_true")]
    create: bool,
    #[serde(default = "default_true")]
    load: bool,
    #[serde(default = "default_true")]
    cancel: bool,
    #[serde(default = "default_true")]
    terminate: bool,
    #[serde(default = "default_request_timeout_ms")]
    request_timeout_ms: u64,
}

impl Default for RawSessionsPolicy {
    fn default() -> Self {
        Self {
            create: true,
            load: true,
            cancel: true,
            terminate: true,
            request_timeout_ms: default_request_timeout_ms(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPromptPolicy {
    #[serde(default = "default_true")]
    allow: bool,
    #[serde(default = "default_one")]
    max_concurrent: usize,
    #[serde(default = "default_max_prompt_bytes")]
    max_prompt_bytes: usize,
    #[serde(default = "default_prompt_timeout_ms")]
    max_duration_ms: u64,
    #[serde(default = "default_true")]
    allow_attachments: bool,
    #[serde(default = "default_true")]
    allow_images: bool,
    #[serde(default)]
    allow_local_file_refs: bool,
}

impl Default for RawPromptPolicy {
    fn default() -> Self {
        Self {
            allow: true,
            max_concurrent: 1,
            max_prompt_bytes: default_max_prompt_bytes(),
            max_duration_ms: default_prompt_timeout_ms(),
            allow_attachments: true,
            allow_images: true,
            allow_local_file_refs: false,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWorkspacePolicy {
    #[serde(default)]
    default_cwd: Option<String>,
    #[serde(default)]
    backend_may_set_cwd: bool,
    #[serde(default)]
    allowed_roots: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEnvPolicy {
    #[serde(default)]
    inherit: bool,
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    set: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRuntimeConfigPolicy {
    #[serde(default)]
    backend_may_set_model: bool,
    #[serde(default)]
    backend_may_set_native_options: bool,
    #[serde(default)]
    allowed_config_options: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPermissionPolicy {
    #[serde(default = "default_true")]
    forward_to_backend: bool,
    #[serde(default = "default_permission_wait_timeout_ms")]
    wait_timeout_ms: u64,
    #[serde(default = "default_permission_on_timeout")]
    on_timeout: String,
    #[serde(default)]
    auto_allow: bool,
    #[serde(default = "default_true")]
    backend_may_set_mode: bool,
    #[serde(default)]
    allowed_modes: Vec<String>,
}

impl Default for RawPermissionPolicy {
    fn default() -> Self {
        Self {
            forward_to_backend: true,
            wait_timeout_ms: default_permission_wait_timeout_ms(),
            on_timeout: default_permission_on_timeout(),
            auto_allow: false,
            backend_may_set_mode: true,
            allowed_modes: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSendPolicy {
    #[serde(default = "default_true")]
    allow: bool,
    #[serde(default = "default_max_send_text_bytes")]
    max_text_bytes: usize,
    #[serde(default = "default_max_send_files")]
    max_files: usize,
}

impl Default for RawSendPolicy {
    fn default() -> Self {
        Self {
            allow: true,
            max_text_bytes: default_max_send_text_bytes(),
            max_files: default_max_send_files(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFileUploadPolicy {
    #[serde(default)]
    allow: bool,
    #[serde(default = "default_file_upload_max_bytes")]
    max_bytes: u64,
    #[serde(default)]
    allowed_content_types: Vec<String>,
}

impl Default for RawFileUploadPolicy {
    fn default() -> Self {
        Self {
            allow: false,
            max_bytes: default_file_upload_max_bytes(),
            allowed_content_types: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTracePolicy {
    #[serde(default = "default_true")]
    allow: bool,
    #[serde(default = "default_trace_max_message_bytes")]
    max_message_bytes: usize,
}

impl Default for RawTracePolicy {
    fn default() -> Self {
        Self {
            allow: true,
            max_message_bytes: default_trace_max_message_bytes(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSessionUpdatePolicy {
    #[serde(default = "default_true")]
    allow: bool,
    #[serde(default = "default_true")]
    include_metadata: bool,
}

impl Default for RawSessionUpdatePolicy {
    fn default() -> Self {
        Self {
            allow: true,
            include_metadata: true,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMcpPolicy {
    #[serde(default = "default_true")]
    inject_cheers: bool,
    #[serde(default)]
    backend_may_inject_extra_servers: bool,
    #[serde(default)]
    allowed_servers: Vec<String>,
    #[serde(default)]
    servers: Vec<TomlValue>,
}

impl Default for RawMcpPolicy {
    fn default() -> Self {
        Self {
            inject_cheers: true,
            backend_may_inject_extra_servers: false,
            allowed_servers: Vec::new(),
            servers: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLoopbackPolicy {
    #[serde(default = "default_loopback_timeout_ms")]
    request_timeout_ms: u64,
}

impl Default for RawLoopbackPolicy {
    fn default() -> Self {
        Self {
            request_timeout_ms: default_loopback_timeout_ms(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSecurity {
    #[serde(default)]
    acp_capability: Option<RawAcpCapability>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAcpCapability {
    delegation_id: String,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    private_key_env: Option<String>,
    #[serde(default)]
    private_key_file: Option<String>,
    #[serde(default = "default_acp_capability_algorithm")]
    algorithm: String,
    #[serde(default)]
    kid: Option<String>,
    #[serde(default)]
    request_id_prefix: Option<String>,
}

pub async fn load_config(config_path: &Path) -> anyhow::Result<ConnectorConfig> {
    let (raw, base_dir) = read_raw_config(config_path).await?;
    if raw.accounts.is_empty() {
        return Err(anyhow!("config.accounts must include at least one account"));
    }
    let daemon_config = normalize_daemon_file_config(raw.daemon, &base_dir)?;
    let mut accounts = BTreeMap::new();
    for (id, raw_account) in raw.accounts {
        accounts.insert(
            id.clone(),
            normalize_account(&id, raw_account, &base_dir).await?,
        );
    }

    Ok(ConnectorConfig {
        accounts,
        state_path: daemon_config.state_path,
        log_dir: daemon_config.log_dir,
    })
}

pub async fn load_daemon_file_config(config_path: &Path) -> anyhow::Result<DaemonFileConfig> {
    let (raw, base_dir) = read_raw_config(config_path).await?;
    normalize_daemon_file_config(raw.daemon, &base_dir)
}

async fn read_raw_config(config_path: &Path) -> anyhow::Result<(RawConfig, PathBuf)> {
    let abs = std::fs::canonicalize(config_path)
        .with_context(|| format!("config file does not exist: {}", config_path.display()))?;
    let base_dir = abs
        .parent()
        .ok_or_else(|| anyhow!("config path has no parent: {}", abs.display()))?;
    let text = fs::read_to_string(&abs).await?;
    let raw: RawConfig = toml::from_str(&text)
        .with_context(|| format!("failed to parse TOML config {}", abs.display()))?;
    if raw.version.unwrap_or(CONFIG_VERSION) != CONFIG_VERSION {
        return Err(anyhow!(
            "unsupported config version {}; expected {}",
            raw.version.unwrap_or_default(),
            CONFIG_VERSION
        ));
    }
    Ok((raw, base_dir.to_path_buf()))
}

fn normalize_daemon_file_config(
    raw: RawDaemon,
    base_dir: &Path,
) -> anyhow::Result<DaemonFileConfig> {
    let state_path = match raw.state_path.as_deref() {
        Some(value) => resolve_path(value, base_dir)?,
        None => base_dir.join("state.json"),
    };
    let log_dir = raw
        .log_dir
        .as_deref()
        .map(|value| resolve_path(value, base_dir))
        .transpose()?;
    Ok(DaemonFileConfig {
        state_path,
        log_dir,
    })
}

async fn normalize_account(
    id: &str,
    raw: RawAccount,
    base_dir: &Path,
) -> anyhow::Result<AccountConfig> {
    if raw.adapter.kind != "stdio" {
        return Err(anyhow!(
            "accounts.{id}.adapter.type must be \"stdio\" for the ACP adapter"
        ));
    }
    let bot_token = read_bot_token(id, &raw.bridge, base_dir).await?;
    let policy = normalize_policy(id, raw.policy, base_dir)?;
    let env = materialize_env_policy(&policy.env)?;
    let command = normalize_command_for_env_policy(&raw.adapter.command, policy.env.inherit)?;
    let acp_capability = normalize_acp_capability(id, raw.security.acp_capability, base_dir)?;

    Ok(AccountConfig {
        bot_token,
        control_url: raw.bridge.control_url,
        data_url: raw.bridge.data_url,
        advanced: AdvancedConfig {
            reconnect_base_ms: raw.bridge.reconnect.base_ms,
            reconnect_max_ms: raw.bridge.reconnect.max_ms,
            heartbeat_interval_ms: raw.bridge.heartbeat_interval_ms,
            send_ack_timeout_ms: raw.bridge.ack_timeout_ms,
        },
        agent: StdioAgentConfig {
            command,
            args: raw.adapter.args,
            model: None,
            cwd: policy.workspace.default_cwd.clone(),
            env,
            inherit_env: policy.env.inherit,
            request_timeout_ms: policy.sessions.request_timeout_ms,
            prompt_timeout_ms: policy.prompt.max_duration_ms,
            agent_native_permission_mode: raw.adapter.permission_mode,
            config_options: None,
            mcp_servers: policy.mcp.servers.clone(),
            client_capabilities: Some(client_capabilities()),
        },
        acp_capability,
        policy,
    })
}

fn normalize_policy(id: &str, raw: RawPolicy, base_dir: &Path) -> anyhow::Result<LocalPolicy> {
    let workspace_roots = resolve_existing_dirs(
        &raw.workspace.allowed_roots,
        base_dir,
        &format!("accounts.{id}.policy.workspace.allowed_roots"),
    )?;
    let default_cwd = match raw.workspace.default_cwd.as_deref() {
        Some(value) => {
            let path = resolve_existing_dir(
                value,
                base_dir,
                &format!("accounts.{id}.policy.workspace.default_cwd"),
            )?;
            if !workspace_roots.is_empty() && !path_is_allowed(&path, &workspace_roots) {
                return Err(anyhow!(
                    "accounts.{id}.policy.workspace.default_cwd must be under allowed_roots"
                ));
            }
            Some(path)
        }
        None => None,
    };
    let mcp_servers = toml_values_to_json_array(raw.mcp.servers)?;

    Ok(LocalPolicy {
        sessions: SessionsPolicy {
            create: raw.sessions.create,
            load: raw.sessions.load,
            cancel: raw.sessions.cancel,
            terminate: raw.sessions.terminate,
            request_timeout_ms: raw.sessions.request_timeout_ms,
        },
        prompt: PromptPolicy {
            allow: raw.prompt.allow,
            max_concurrent: raw.prompt.max_concurrent.max(1),
            max_prompt_bytes: raw.prompt.max_prompt_bytes.max(1),
            max_duration_ms: raw.prompt.max_duration_ms.max(1),
            allow_attachments: raw.prompt.allow_attachments,
            allow_images: raw.prompt.allow_images,
            allow_local_file_refs: raw.prompt.allow_local_file_refs,
        },
        workspace: WorkspacePolicy {
            default_cwd,
            backend_may_set_cwd: raw.workspace.backend_may_set_cwd,
            allowed_roots: workspace_roots,
        },
        env: EnvPolicy {
            inherit: raw.env.inherit,
            allow: raw.env.allow,
            set: raw.env.set,
        },
        config: RuntimeConfigPolicy {
            backend_may_set_model: raw.config.backend_may_set_model,
            backend_may_set_native_options: raw.config.backend_may_set_native_options,
            allowed_config_options: raw.config.allowed_config_options,
        },
        permission: PermissionPolicy {
            forward_to_backend: raw.permission.forward_to_backend,
            wait_timeout_ms: raw.permission.wait_timeout_ms.max(1),
            on_timeout: PermissionTimeoutAction::from_str(&raw.permission.on_timeout)?,
            auto_allow: raw.permission.auto_allow,
            backend_may_set_mode: raw.permission.backend_may_set_mode,
            allowed_modes: raw.permission.allowed_modes,
        },
        send: SendPolicy {
            allow: raw.send.allow,
            max_text_bytes: raw.send.max_text_bytes.max(1),
            max_files: raw.send.max_files,
        },
        file_upload: FileUploadPolicy {
            allow: raw.file_upload.allow,
            max_bytes: raw.file_upload.max_bytes.max(1),
            allowed_content_types: raw.file_upload.allowed_content_types,
        },
        trace: TracePolicy {
            allow: raw.trace.allow,
            max_message_bytes: raw.trace.max_message_bytes.max(1),
        },
        session_update: SessionUpdatePolicy {
            allow: raw.session_update.allow,
            include_metadata: raw.session_update.include_metadata,
        },
        mcp: McpPolicy {
            inject_cheers: raw.mcp.inject_cheers,
            backend_may_inject_extra_servers: raw.mcp.backend_may_inject_extra_servers,
            allowed_servers: raw.mcp.allowed_servers,
            servers: mcp_servers,
        },
        loopback: LoopbackPolicy {
            request_timeout_ms: raw.loopback.request_timeout_ms,
        },
    })
}

async fn read_bot_token(id: &str, bridge: &RawBridge, base_dir: &Path) -> anyhow::Result<String> {
    match (&bridge.bot_token_env, &bridge.bot_token_file) {
        (Some(env_name), None) => {
            let token = env::var(env_name).with_context(|| {
                format!("accounts.{id}.bridge.bot_token_env {env_name} is not set")
            })?;
            non_empty_secret(token, &format!("accounts.{id}.bridge.bot_token_env"))
        }
        (None, Some(path)) => {
            let path = resolve_path(path, base_dir)
                .with_context(|| format!("accounts.{id}.bridge.bot_token_file is invalid"))?;
            let token = fs::read_to_string(&path)
                .await
                .with_context(|| format!("failed to read bot token file {}", path.display()))?;
            non_empty_secret(token.trim().to_string(), "bot token file")
        }
        (None, None) => Err(anyhow!(
            "accounts.{id}.bridge must set exactly one of bot_token_env or bot_token_file"
        )),
        (Some(_), Some(_)) => Err(anyhow!(
            "accounts.{id}.bridge must not set both bot_token_env and bot_token_file"
        )),
    }
}

fn non_empty_secret(value: String, field: &str) -> anyhow::Result<String> {
    if value.trim().is_empty() {
        Err(anyhow!("{field} resolved to an empty value"))
    } else {
        Ok(value)
    }
}

fn normalize_acp_capability(
    id: &str,
    raw: Option<RawAcpCapability>,
    base_dir: &Path,
) -> anyhow::Result<Option<AcpCapabilityConfig>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let private_key = match (raw.private_key, raw.private_key_env, raw.private_key_file) {
        (Some(value), None, None) => expand_env_value(&value, false)?,
        (None, Some(env_name), None) => env::var(&env_name).with_context(|| {
            format!("accounts.{id}.security.acp_capability.private_key_env {env_name} is not set")
        })?,
        (None, None, Some(path)) => {
            format!("file:{}", resolve_path(&path, base_dir)?.display())
        }
        _ => {
            return Err(anyhow!(
                "accounts.{id}.security.acp_capability must set exactly one private_key source"
            ))
        }
    };
    Ok(Some(AcpCapabilityConfig {
        delegation_id: raw.delegation_id,
        private_key,
        kid: raw.kid,
        algorithm: raw.algorithm,
        request_id_prefix: raw.request_id_prefix,
    }))
}

fn materialize_env_policy(policy: &EnvPolicy) -> anyhow::Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for name in &policy.allow {
        if !valid_env_name(name) {
            return Err(anyhow!("policy.env.allow contains invalid env name {name}"));
        }
        if let Ok(value) = env::var(name) {
            out.insert(name.clone(), value);
        }
    }
    for (name, value) in &policy.set {
        if !valid_env_name(name) {
            return Err(anyhow!("policy.env.set contains invalid env name {name}"));
        }
        out.insert(name.clone(), expand_env_value(value, false)?);
    }
    Ok(out)
}

fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn normalize_command_for_env_policy(command: &str, inherit_env: bool) -> anyhow::Result<String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(anyhow!("adapter.command must not be empty"));
    }
    if inherit_env || command.contains(std::path::MAIN_SEPARATOR) {
        return Ok(command.to_string());
    }
    find_command_in_path(command)
        .map(|path| path.display().to_string())
        .ok_or_else(|| {
            anyhow!(
                "adapter.command {command} is not absolute and was not found in PATH; set policy.env.inherit=true or use an absolute command path"
            )
        })
}

fn find_command_in_path(command: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn client_capabilities() -> Value {
    // Single source of truth lives in the ACP protocol layer so the configured
    // value and the adapter's in-code fallback can never diverge.
    crate::acp_adapter::default_client_capabilities()
}

fn toml_values_to_json_array(values: Vec<TomlValue>) -> anyhow::Result<Value> {
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        out.push(serde_json::to_value(value).context("failed to convert TOML MCP server entry")?);
    }
    Ok(Value::Array(out))
}

fn resolve_existing_dirs(
    values: &[String],
    base_dir: &Path,
    field: &str,
) -> anyhow::Result<Vec<PathBuf>> {
    values
        .iter()
        .map(|value| resolve_existing_dir(value, base_dir, field))
        .collect()
}

fn resolve_existing_dir(value: &str, base_dir: &Path, field: &str) -> anyhow::Result<PathBuf> {
    let path = resolve_path(value, base_dir).with_context(|| format!("{field} is invalid"))?;
    let metadata = std::fs::metadata(&path)
        .with_context(|| format!("{field} does not exist: {}", path.display()))?;
    if !metadata.is_dir() {
        return Err(anyhow!("{field} is not a directory: {}", path.display()));
    }
    path.canonicalize()
        .with_context(|| format!("failed to canonicalize {}", path.display()))
}

fn path_is_allowed(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn resolve_path(value: &str, base_dir: &Path) -> anyhow::Result<PathBuf> {
    let mut expanded = expand_env_value(value.trim(), true)?;
    if expanded == "~" {
        expanded = home_dir()?;
    } else if let Some(rest) = expanded.strip_prefix("~/") {
        expanded = format!("{}/{}", home_dir()?, rest);
    }
    let path = PathBuf::from(expanded);
    Ok(if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    })
}

fn expand_env_value(value: &str, strict: bool) -> anyhow::Result<String> {
    if let Some(name) = value.strip_prefix('$') {
        if valid_env_name(name) {
            return lookup_env(name, strict);
        }
    }

    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let name = &after[..end];
        out.push_str(&lookup_env(name, strict)?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn lookup_env(name: &str, strict: bool) -> anyhow::Result<String> {
    if name == "PWD" {
        if let Ok(cwd) = env::current_dir() {
            return Ok(cwd.display().to_string());
        }
    }
    match env::var(name) {
        Ok(value) => Ok(value),
        Err(_) if strict => Err(anyhow!("environment variable {name} is not set")),
        Err(_) => Ok(String::new()),
    }
}

fn home_dir() -> anyhow::Result<String> {
    env::var("HOME").map_err(|_| anyhow!("HOME is not set"))
}

fn default_true() -> bool {
    true
}

fn default_one() -> usize {
    1
}

fn default_max_prompt_bytes() -> usize {
    200_000
}

fn default_request_timeout_ms() -> u64 {
    120_000
}

fn default_prompt_timeout_ms() -> u64 {
    900_000
}

fn default_reconnect_base_ms() -> u64 {
    500
}

fn default_reconnect_max_ms() -> u64 {
    30_000
}

fn default_heartbeat_interval_ms() -> u64 {
    25_000
}

fn default_send_ack_timeout_ms() -> u64 {
    10 * 60_000
}

fn default_loopback_timeout_ms() -> u64 {
    10 * 60_000
}

fn default_permission_wait_timeout_ms() -> u64 {
    15 * 60_000
}

fn default_permission_on_timeout() -> String {
    "cancel".to_string()
}

fn default_max_send_text_bytes() -> usize {
    200_000
}

fn default_max_send_files() -> usize {
    10
}

fn default_file_upload_max_bytes() -> u64 {
    25 * 1024 * 1024
}

fn default_trace_max_message_bytes() -> usize {
    32_000
}

fn default_acp_capability_algorithm() -> String {
    "ed25519".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loads_toml_config_with_local_policy() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        std::env::set_var("CHEERS_TEST_TOKEN", "token-1");
        std::env::set_var("CHEERS_TEST_SECRET", "secret-1");
        let config_path = dir.path().join("cheers-daemon.toml");
        std::fs::write(
            &config_path,
            format!(
                r#"
version = 1

[daemon]
state_path = "state.json"
log_dir = "logs"

[accounts.local.bridge]
control_url = "wss://example.test/control"
data_url = "wss://example.test/data"
bot_token_env = "CHEERS_TEST_TOKEN"
heartbeat_interval_ms = 10000
ack_timeout_ms = 120000

[accounts.local.bridge.reconnect]
base_ms = 250
max_ms = 5000

[accounts.local.adapter]
type = "stdio"
command = "{}"
args = ["--flag"]

[accounts.local.policy.workspace]
default_cwd = "{}"
allowed_roots = ["{}"]
backend_may_set_cwd = true

[accounts.local.policy.sessions]
request_timeout_ms = 333000

[accounts.local.policy.prompt]
max_duration_ms = 444000
max_prompt_bytes = 12345

[accounts.local.policy.env]
inherit = false
allow = ["CHEERS_TEST_SECRET"]

[accounts.local.policy.config]
backend_may_set_model = false
backend_may_set_native_options = false
allowed_config_options = ["mode"]

[accounts.local.policy.permission]
forward_to_backend = true
wait_timeout_ms = 555000
on_timeout = "cancel"

[accounts.local.policy.send]
allow = true
max_text_bytes = 7777
max_files = 2

[accounts.local.policy.file_upload]
allow = false
max_bytes = 4096
allowed_content_types = ["text/plain"]

[accounts.local.policy.trace]
allow = true
max_message_bytes = 888

[accounts.local.policy.session_update]
allow = true
include_metadata = false

[accounts.local.policy.loopback]
request_timeout_ms = 666000
"#,
                std::env::current_exe().unwrap().display(),
                workspace.display(),
                workspace.display()
            ),
        )
        .unwrap();

        let config = load_config(&config_path).await.unwrap();
        let expected_state_path = config_path
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap()
            .join("state.json");
        assert_eq!(config.state_path, expected_state_path);
        assert_eq!(
            config.log_dir.as_ref().unwrap(),
            &config_path
                .canonicalize()
                .unwrap()
                .parent()
                .unwrap()
                .join("logs")
        );
        let account = config.accounts.get("local").unwrap();
        assert_eq!(account.bot_token, "token-1");
        assert_eq!(account.advanced.reconnect_base_ms, 250);
        assert_eq!(account.agent.args, vec!["--flag"]);
        assert_eq!(account.agent.request_timeout_ms, 333000);
        assert_eq!(account.agent.prompt_timeout_ms, 444000);
        assert_eq!(account.policy.prompt.max_prompt_bytes, 12345);
        assert!(!account.agent.inherit_env);
        assert_eq!(
            account.agent.env.get("CHEERS_TEST_SECRET"),
            Some(&"secret-1".to_string())
        );
        assert_eq!(
            account.agent.client_capabilities.as_ref().unwrap()["fs"]["readTextFile"],
            false
        );
        assert_eq!(
            account.agent.client_capabilities.as_ref().unwrap()["fs"]["writeTextFile"],
            false
        );
        assert_eq!(
            account.agent.client_capabilities.as_ref().unwrap()["terminal"],
            false
        );
        // Dedup invariant: config must advertise EXACTLY the ACP protocol
        // layer's single source of truth, never a divergent literal.
        assert_eq!(
            account.agent.client_capabilities.as_ref().unwrap(),
            &crate::acp_adapter::default_client_capabilities()
        );
        assert_eq!(account.policy.loopback.request_timeout_ms, 666000);
        assert_eq!(account.policy.permission.wait_timeout_ms, 555000);
        assert!(matches!(
            account.policy.permission.on_timeout,
            PermissionTimeoutAction::Cancel
        ));
        assert_eq!(account.policy.send.max_text_bytes, 7777);
        assert_eq!(account.policy.file_upload.max_bytes, 4096);
        assert_eq!(
            account.policy.file_upload.allowed_content_types,
            vec!["text/plain".to_string()]
        );
        assert_eq!(account.policy.trace.max_message_bytes, 888);
        assert!(!account.policy.session_update.include_metadata);
    }

    #[tokio::test]
    async fn rejects_inline_or_missing_bot_token_source() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("cheers-daemon.toml");
        std::fs::write(
            &config_path,
            r#"
version = 1

[accounts.local.bridge]
control_url = "wss://example.test/control"
data_url = "wss://example.test/data"

[accounts.local.adapter]
type = "stdio"
command = "/bin/echo"
"#,
        )
        .unwrap();

        let err = load_config(&config_path).await.unwrap_err().to_string();
        assert!(err.contains("bot_token_env") || err.contains("bot_token_file"));
    }
}
