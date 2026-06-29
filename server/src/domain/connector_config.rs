//! Connector config (TOML) generator for the 3-mode bot onboarding flow.
//!
//! Renders a ready-to-run `cheers-daemon.<name>.toml` for the host-side
//! `cce-acp-connector` from a bot + a chosen agent type. The schema mirrors the
//! connector's own parser (see `packages/cheers-acp-connector-rs/src/config.rs`)
//! and the hand-written examples; this is the single place the gateway produces
//! that file so the manual / script / agent modes can never drift apart.
//!
//! The token is NEVER inlined here. The config points at a `bot_token_file`
//! sidecar (mode 3 manual + mode 2 script write the plaintext there with 0600),
//! keeping the secret out of the (potentially copied / committed) config body.

/// WS sub-paths the connector dials on the gateway's agent-bridge.
const CONTROL_PATH: &str = "/ws/agent-bridge/control";
const DATA_PATH: &str = "/ws/agent-bridge/data";

/// Fallback public base when `CHEERS_CONNECTOR_PUBLIC_BASE` is unset. Points at
/// the gateway directly; for local kind this requires a `kubectl port-forward`
/// (or set the env to the frontend NodePort `ws://localhost:30080`, which nginx
/// proxies to the gateway). Surfaced honestly via [`Reachability`].
pub const DEFAULT_PUBLIC_BASE: &str = "ws://localhost:8000";

/// How the rendered config references the bot token.
pub enum TokenRef {
    /// `bot_token_file = "<path>"` — a 0600 sidecar written next to the config.
    File(String),
    /// `bot_token_env = "<NAME>"` — read from the connector process environment.
    Env(String),
}

/// A built-in agent profile: which ACP adapter binary to spawn and the minimal
/// env it needs. Unknown agent types fall back to a clearly-marked placeholder
/// the user must edit (`needs_edit`).
struct AgentPreset {
    /// adapter.command — the stdio ACP agent binary.
    command: &'static str,
    /// policy.env.allow — only these are copied from the connector env into the
    /// child (env.inherit stays false, the safe default).
    env_allow: &'static [&'static str],
    /// adapter.permission_mode (session/set_mode stopgap); None omits the key.
    permission_mode: Option<&'static str>,
    /// policy.permission.allowed_modes — opaque ACP modeIds the platform may select
    /// at runtime (L0 set-mode envelope). Agent-SPECIFIC, so it lives here, not in
    /// the shared template or the connector. Empty = any mode the agent advertises.
    /// (Omitting an agent's bypass mode is how we keep bypass off by default.)
    allowed_modes: &'static [&'static str],
    /// True when `command` is a placeholder the user must replace before it runs.
    needs_edit: bool,
}

fn preset_for(agent_type: &str) -> AgentPreset {
    match agent_type.trim().to_ascii_lowercase().as_str() {
        "claude" => AgentPreset {
            command: "claude-agent-acp",
            env_allow: &["HOME", "PATH", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
            // "default" = Claude's "prompts for dangerous operations" mode, which
            // routes un-pre-approved tools through ACP request_permission → an
            // in-channel approval card. ("plan" was wrong: it means "no tool
            // execution", not "ask per tool" — see BOT_CONFIG_GOVERNANCE.md §3.)
            // This is only the DEFAULT; the live value is meant to be platform-set
            // (L1/L2) and clamped by an L0 gate — that plumbing is still TODO.
            permission_mode: Some("default"),
            // Claude's advertised modes minus "bypassPermissions" → the platform
            // can switch posture but can't opt into bypass by default.
            allowed_modes: &["default", "plan", "acceptEdits", "dontAsk", "auto"],
            needs_edit: false,
        },
        "codex" => AgentPreset {
            command: "codex-acp",
            env_allow: &["HOME", "PATH", "OPENAI_API_KEY"],
            permission_mode: None,
            // We don't presume codex's modeIds; empty = any mode it advertises.
            allowed_modes: &[],
            needs_edit: false,
        },
        "opencode" => AgentPreset {
            // Best-effort binary name; verify against your OpenCode ACP build.
            command: "opencode-acp",
            env_allow: &["HOME", "PATH"],
            permission_mode: None,
            allowed_modes: &[],
            needs_edit: true,
        },
        _ => AgentPreset {
            command: "/path/to/your-acp-agent",
            env_allow: &["HOME", "PATH"],
            permission_mode: None,
            allowed_modes: &[],
            needs_edit: true,
        },
    }
}

/// Inputs for [`render_toml`]. `account_id` is the TOML table key under
/// `[accounts.<id>...]` and the daemon `--name`; it is sanitized for you.
pub struct RenderParams<'a> {
    /// Bot display/login name; sanitized into a TOML bare key.
    pub account_id: &'a str,
    /// One of claude | codex | opencode | generic (anything else → generic).
    pub agent_type: &'a str,
    /// Public WS base, e.g. `ws://localhost:30080` or `wss://host`. No trailing
    /// path — the control/data sub-paths are appended here.
    pub public_base: &'a str,
    /// How the config should reference the bot token.
    pub token_ref: TokenRef,
}

/// Sanitize an arbitrary bot name into a TOML bare key (`[A-Za-z0-9_-]`),
/// lowercased, non-empty. TOML table keys and the daemon `--name` both accept
/// this set; everything else collapses to `_`.
pub fn sanitize_account_id(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned
        .trim_matches(|c| c == '_' || c == '-')
        .to_string();
    if trimmed.is_empty() {
        "bot".to_string()
    } else {
        trimmed
    }
}

/// Join a public base with the control WS sub-path (trailing slash tolerant).
pub fn control_url(public_base: &str) -> String {
    format!("{}{CONTROL_PATH}", public_base.trim_end_matches('/'))
}

/// Join a public base with the data WS sub-path.
pub fn data_url(public_base: &str) -> String {
    format!("{}{DATA_PATH}", public_base.trim_end_matches('/'))
}

/// Minimal TOML basic-string escaping for the few values we interpolate.
fn toml_str(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Render a complete, loadable connector config. The output mirrors the
/// connector's parser exactly; a missing `~/.cheers/workspace` (referenced by
/// the workspace policy) must be created before start — the install script and
/// manual docs both do this.
pub fn render_toml(params: &RenderParams) -> String {
    let id = sanitize_account_id(params.account_id);
    let preset = preset_for(params.agent_type);
    let control = control_url(params.public_base);
    let data = data_url(params.public_base);

    let token_line = match &params.token_ref {
        TokenRef::File(path) => format!("bot_token_file        = {}", toml_str(path)),
        TokenRef::Env(name) => format!("bot_token_env         = {}", toml_str(name)),
    };

    let env_allow = preset
        .env_allow
        .iter()
        .map(|v| toml_str(v))
        .collect::<Vec<_>>()
        .join(", ");

    let permission_mode_line = match preset.permission_mode {
        Some(mode) => format!("\npermission_mode = {}", toml_str(mode)),
        None => String::new(),
    };

    let allowed_modes = preset
        .allowed_modes
        .iter()
        .map(|v| toml_str(v))
        .collect::<Vec<_>>()
        .join(", ");

    let edit_banner = if preset.needs_edit {
        "#\n# ⚠ adapter.command below is a PLACEHOLDER — replace it with your ACP\n#   agent binary (absolute path or a command on PATH) before starting.\n"
    } else {
        ""
    };

    format!(
        r#"# Cheers ACP connector config for bot "{id}" (agent: {agent_type}).
# Generated by the Cheers onboarding flow.
{edit_banner}#
# Before first start:
#   mkdir -p ~/.cheers/workspace ~/.cheers/secrets
#   # write the one-time bot token to the sidecar referenced below (chmod 600)
#   # then: cce-acp-connector start --config <this file> --name {id}

version = 1

[daemon]
name       = {id_str}
state_path = {state_path}
log_dir    = {log_dir}

[accounts.{id}.bridge]
control_url           = {control}
data_url              = {data}
{token_line}
heartbeat_interval_ms = 25000
ack_timeout_ms        = 600000

[accounts.{id}.bridge.reconnect]
base_ms = 500
max_ms  = 30000

[accounts.{id}.adapter]
type    = "stdio"
command = {command}
args    = []{permission_mode_line}

[accounts.{id}.policy.sessions]
create             = true
load               = true
cancel             = true
terminate          = true
request_timeout_ms = 120000

[accounts.{id}.policy.prompt]
allow                 = true
max_concurrent        = 1
max_prompt_bytes      = 200000
max_duration_ms       = 900000
allow_attachments     = true
allow_images          = true
allow_local_file_refs = false

[accounts.{id}.policy.workspace]
default_cwd         = "~/.cheers/workspace"
allowed_roots       = ["~/.cheers/workspace"]
backend_may_set_cwd = true

[accounts.{id}.policy.env]
inherit = false
allow   = [{env_allow}]

[accounts.{id}.policy.permission]
forward_to_backend = true
wait_timeout_ms    = 900000
on_timeout         = "cancel"
# auto_allow = false routes each ACP tool-permission prompt to the channel so a
# human (owner / delegate) decides. Set true to approve locally and skip cards.
auto_allow         = false
# ── L0 set-mode envelope (host-sovereign; see BOT_CONFIG_GOVERNANCE.md) ──
# backend_may_set_mode: may the platform change the session permission mode at
#   runtime (L2 session/set_mode). allowed_modes: opaque ACP modeIds the platform
#   may select (empty = any mode the agent advertises in session/new). The connector
#   matches these by exact string — it has no notion of what a mode means.
backend_may_set_mode = true
allowed_modes        = [{allowed_modes}]

[accounts.{id}.policy.send]
allow          = true
max_text_bytes = 200000
max_files      = 10

[accounts.{id}.policy.mcp]
inject_cheers                    = true
backend_may_inject_extra_servers = false
allowed_servers                  = ["cheers"]

[accounts.{id}.policy.loopback]
request_timeout_ms = 30000
"#,
        id = id,
        id_str = toml_str(&id),
        agent_type = params.agent_type,
        edit_banner = edit_banner,
        state_path = toml_str(&format!("state-{id}.json")),
        log_dir = toml_str(&format!("logs-{id}")),
        control = toml_str(&control),
        data = toml_str(&data),
        token_line = token_line,
        command = toml_str(preset.command),
        permission_mode_line = permission_mode_line,
        env_allow = env_allow,
        allowed_modes = allowed_modes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_account_ids() {
        assert_eq!(sanitize_account_id("Codex Bot!"), "codex_bot");
        assert_eq!(sanitize_account_id("  --weird--  "), "weird");
        assert_eq!(sanitize_account_id("中文"), "bot");
        assert_eq!(sanitize_account_id(""), "bot");
        assert_eq!(sanitize_account_id("my-agent_1"), "my-agent_1");
    }

    #[test]
    fn urls_tolerate_trailing_slash() {
        assert_eq!(
            control_url("ws://localhost:30080/"),
            "ws://localhost:30080/ws/agent-bridge/control"
        );
        assert_eq!(
            data_url("wss://host"),
            "wss://host/ws/agent-bridge/data"
        );
    }

    #[test]
    fn renders_codex_with_file_token() {
        let toml = render_toml(&RenderParams {
            account_id: "Codex",
            agent_type: "codex",
            public_base: "ws://localhost:30080",
            token_ref: TokenRef::File("secrets/codex.token".into()),
        });
        assert!(toml.contains("[accounts.codex.bridge]"));
        assert!(toml.contains("bot_token_file        = \"secrets/codex.token\""));
        assert!(toml.contains("command = \"codex-acp\""));
        assert!(toml.contains("\"OPENAI_API_KEY\""));
        // codex has no permission_mode override.
        assert!(!toml.contains("permission_mode"));
        assert!(toml.contains("ws://localhost:30080/ws/agent-bridge/control"));
        // The token plaintext must never be inlined.
        assert!(!toml.contains("agb_"));
    }

    #[test]
    fn renders_claude_with_env_token_and_permission_mode() {
        let toml = render_toml(&RenderParams {
            account_id: "claude",
            agent_type: "claude",
            public_base: "wss://cheers.example.com",
            token_ref: TokenRef::Env("CHEERS_CLAUDE_BOT_TOKEN".into()),
        });
        assert!(toml.contains("bot_token_env         = \"CHEERS_CLAUDE_BOT_TOKEN\""));
        // "default" = prompts per tool (not "plan", which means no execution).
        assert!(toml.contains("permission_mode = \"default\""));
        // L0 set-mode envelope: claude's safe modes, no "bypassPermissions".
        assert!(toml.contains(r#"allowed_modes        = ["default", "plan", "acceptEdits", "dontAsk", "auto"]"#));
        assert!(!toml.contains("bypassPermissions"));
        assert!(toml.contains("\"ANTHROPIC_API_KEY\""));
        assert!(toml.contains("command = \"claude-agent-acp\""));
    }

    #[test]
    fn generic_agent_is_marked_for_edit() {
        let toml = render_toml(&RenderParams {
            account_id: "mybot",
            agent_type: "something-else",
            public_base: DEFAULT_PUBLIC_BASE,
            token_ref: TokenRef::File("secrets/mybot.token".into()),
        });
        assert!(toml.contains("PLACEHOLDER"));
        assert!(toml.contains("/path/to/your-acp-agent"));
    }
}
