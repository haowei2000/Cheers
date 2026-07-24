//! Connector config (TOML) generator for the 3-mode bot onboarding flow.
//!
//! Renders a ready-to-run `cheers-daemon.<name>.toml` for the host-side
//! `cce-acp-connector` from a bot + a chosen agent type. The schema mirrors the
//! connector's own parser (see `packages/cheers-acp-connector-rs/src/config.rs`)
//! and the hand-written examples; this is the single place the gateway produces
//! that file so the manual / script / agent modes can never drift apart.
//!
//! Agent presets: Claude / Codex / OpenCode stay finely tuned here. Every other
//! id is resolved from the live ACP registry's **npx** distribution (see
//! [`crate::domain::acp_registry`]) so new registry agents need no gateway
//! release to get a usable config. Unknown / unreachable ids fall back to a
//! clearly-marked placeholder (`needs_edit`).
//!
//! The token is NEVER inlined here. The config points at a `bot_token_file`
//! sidecar (mode 3 manual + mode 2 script write the plaintext there with 0600),
//! keeping the secret out of the (potentially copied / committed) config body.

use crate::domain::acp_registry::{self, BinaryLaunch, PackageLaunch};

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

/// A built-in or registry-derived agent profile: which ACP adapter binary to
/// spawn and the minimal env it needs. Unknown agent types fall back to a
/// clearly-marked placeholder the user must edit (`needs_edit`).
struct AgentPreset {
    /// adapter.command — the stdio ACP agent binary.
    command: String,
    /// adapter.args — argv passed to `command`. Non-empty when the agent's ACP
    /// mode is a subcommand of its main binary rather than a dedicated adapter.
    args: Vec<String>,
    /// policy.env.allow — only these are copied from the connector env into the
    /// child (env.inherit stays false, the safe default).
    env_allow: Vec<String>,
    /// adapter.permission_mode (session/set_mode stopgap); None omits the key.
    permission_mode: Option<String>,
    /// policy.permission.allowed_modes — opaque ACP modeIds the platform may select
    /// at runtime (L0 set-mode envelope). Agent-SPECIFIC. Empty = any mode the
    /// agent advertises.
    allowed_modes: Vec<String>,
    /// policy.config.allowed_config_options — opaque ACP config option ids.
    allowed_config_options: Vec<String>,
    /// True when `command` is a placeholder the user must replace before it runs.
    needs_edit: bool,
}

fn strings(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| (*s).to_string()).collect()
}

fn claude_preset() -> AgentPreset {
    AgentPreset {
        command: "claude-agent-acp".into(),
        args: vec![],
        env_allow: strings(&[
            "HOME",
            "PATH",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ]),
        // "default" = Claude's "prompts for dangerous operations" mode, which
        // routes un-pre-approved tools through ACP request_permission → an
        // in-channel approval card.
        permission_mode: Some("default".into()),
        // Claude's advertised modes minus "bypassPermissions".
        allowed_modes: strings(&["default", "plan", "acceptEdits", "dontAsk", "auto"]),
        allowed_config_options: strings(&["model", "reasoning_effort", "thinking_mode"]),
        needs_edit: false,
    }
}

fn codex_preset() -> AgentPreset {
    AgentPreset {
        command: "codex-acp".into(),
        args: vec![],
        env_allow: strings(&["HOME", "PATH", "OPENAI_API_KEY"]),
        permission_mode: None,
        allowed_modes: vec![],
        allowed_config_options: strings(&[
            "model",
            "reasoning_effort",
            "approval_policy",
            "sandbox",
        ]),
        needs_edit: false,
    }
}

fn opencode_preset() -> AgentPreset {
    // OpenCode ships ACP as a subcommand of its main binary (`opencode acp`) —
    // there is no separate `opencode-acp` adapter (and the registry lists it as
    // binary-only, not npx).
    AgentPreset {
        command: "opencode".into(),
        args: vec!["acp".into()],
        env_allow: strings(&["HOME", "PATH"]),
        permission_mode: None,
        allowed_modes: vec![],
        allowed_config_options: strings(&["model"]),
        needs_edit: false,
    }
}

fn generic_preset() -> AgentPreset {
    AgentPreset {
        command: "/path/to/your-acp-agent".into(),
        args: vec![],
        env_allow: strings(&["HOME", "PATH"]),
        permission_mode: None,
        allowed_modes: vec![],
        allowed_config_options: vec![],
        needs_edit: true,
    }
}

fn preset_from_package(launch: &PackageLaunch) -> AgentPreset {
    let mut env_allow = strings(&["HOME", "PATH"]);
    for k in &launch.env_keys {
        if !env_allow.iter().any(|e| e == k) {
            env_allow.push(k.clone());
        }
    }
    AgentPreset {
        command: acp_registry::adapter_command_for(launch),
        args: acp_registry::adapter_args_for(launch),
        env_allow,
        permission_mode: None,
        allowed_modes: vec![],
        allowed_config_options: strings(&["model"]),
        needs_edit: false,
    }
}

fn preset_from_binary(launch: &BinaryLaunch) -> AgentPreset {
    let Some(target) = acp_registry::representative_binary_target(launch) else {
        return generic_preset();
    };
    let mut env_allow = strings(&["HOME", "PATH"]);
    for k in &target.env_keys {
        if !env_allow.iter().any(|e| e == k) {
            env_allow.push(k.clone());
        }
    }
    // Cursor Agent CLI needs its auth env when not already logged in.
    if launch.id == "cursor" {
        for k in ["CURSOR_API_KEY", "CURSOR_API_ENDPOINT"] {
            if !env_allow.iter().any(|e| e == k) {
                env_allow.push(k.into());
            }
        }
    }
    AgentPreset {
        command: acp_registry::bin_name_from_cmd(&target.cmd),
        args: target.args.clone(),
        env_allow,
        permission_mode: None,
        allowed_modes: vec![],
        allowed_config_options: strings(&["model"]),
        needs_edit: false,
    }
}

fn preset_for(agent_type: &str) -> AgentPreset {
    let id = acp_registry::canonicalize_agent_id(agent_type);
    match id.as_str() {
        // Fine-tuned builtins (also cover registry ids claude-acp / codex-acp).
        "claude" | "claude-acp" => return claude_preset(),
        "codex" | "codex-acp" => return codex_preset(),
        "opencode" => return opencode_preset(),
        "generic" => return generic_preset(),
        _ => {}
    }
    if let Some(launch) = acp_registry::package_launch_for(&id) {
        return preset_from_package(&launch);
    }
    if let Some(launch) = acp_registry::binary_launch_for(&id) {
        return preset_from_binary(&launch);
    }
    generic_preset()
}

/// Posture envelope for an agent type: `(preset default mode, L0 allowed_modes)`.
/// The owner posture API/UI uses this to validate a requested mode and populate
/// the dropdown — it mirrors the same per-agent `preset_for` source of truth that
/// renders the connector TOML, so platform and connector agree on selectable modes.
pub fn posture_preset(agent_type: &str) -> (Option<String>, Vec<String>) {
    let p = preset_for(agent_type);
    (p.permission_mode, p.allowed_modes)
}

/// Drop the `mode` config option for agents whose permission mode is a first-class
/// posture control (non-empty `allowed_modes`): mode is changed via `set_mode`, so
/// exposing it ALSO as a generic `set_config_option` (agents like Claude advertise a
/// `configOptions` entry with id/category `"mode"`) is a duplicate control. Agents
/// WITHOUT a preset keep it — an empty `allowed_modes` hides the posture control, so
/// the config option is then their only way to change mode.
pub fn dedup_mode_config_options(
    agent_type: &str,
    mut options: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    let (_, allowed) = posture_preset(agent_type);
    if allowed.is_empty() {
        return options;
    }
    options.retain(|o| {
        let field = |k: &str| o.get(k).and_then(serde_json::Value::as_str);
        field("id") != Some("mode") && field("category") != Some("mode")
    });
    options
}

/// Overlay the ACP native model-state API onto the advertised config options:
/// when the snapshot (`connector_control.options.options`) carries `models`
/// (SessionModelState: `availableModels` / `currentModelId`) but no config
/// option with id/category "model", synthesize a select option so the owner UI
/// gets a model dropdown for agents (e.g. older codex-acp) that expose models
/// only via `session/set_model`. The synthesized id is "model" — the same id
/// the connector's L0 `allowed_config_options` whitelists, and its set path
/// falls back to `session/set_model` when `session/set_config_option` fails.
pub fn overlay_model_state(
    snapshot: &serde_json::Value,
    mut options: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    use serde_json::{json, Value};
    let has_model = options.iter().any(|o| {
        let field = |k: &str| o.get(k).and_then(Value::as_str);
        field("id") == Some("model") || field("category") == Some("model")
    });
    if has_model {
        return options;
    }
    let Some(models) = snapshot.get("models") else {
        return options;
    };
    let values: Vec<Value> = models
        .get("availableModels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("modelId").and_then(Value::as_str)?;
                    Some(json!({
                        "value": id,
                        "name": m.get("name").and_then(Value::as_str).unwrap_or(id),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    if values.is_empty() {
        return options;
    }
    // The flattened top-level currentModelId (session snapshot / current_model_update)
    // wins over the possibly-stale one nested in the models state.
    let current = snapshot
        .get("currentModelId")
        .or_else(|| models.get("currentModelId"))
        .cloned()
        .unwrap_or(Value::Null);
    options.push(json!({
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": current,
        "options": values,
    }));
    options
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
    let trimmed = cleaned.trim_matches(|c| c == '_' || c == '-').to_string();
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

    let args = preset
        .args
        .iter()
        .map(|v| toml_str(v))
        .collect::<Vec<_>>()
        .join(", ");

    let permission_mode_line = match &preset.permission_mode {
        Some(mode) => format!("\npermission_mode = {}", toml_str(mode)),
        None => String::new(),
    };

    let allowed_modes = preset
        .allowed_modes
        .iter()
        .map(|v| toml_str(v))
        .collect::<Vec<_>>()
        .join(", ");
    let allowed_config_options = preset
        .allowed_config_options
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

# Optional: let the connector update itself when this server publishes a newer
# release (ed25519-signed manifest, sha256-verified binaries, auto-rollback).
# Kept commented out — executing downloaded code is the host owner's call, and
# connectors older than 0.1.27 reject configs containing this section.
# [update]
# auto = true

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
args    = [{args}]{permission_mode_line}

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

[accounts.{id}.policy.config]
backend_may_set_model = false
backend_may_set_native_options = false
allowed_config_options = [{allowed_config_options}]

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
        command = toml_str(&preset.command),
        args = args,
        permission_mode_line = permission_mode_line,
        env_allow = env_allow,
        allowed_modes = allowed_modes,
        allowed_config_options = allowed_config_options,
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
    fn dedup_mode_strips_mode_option_only_for_preset_agents() {
        let opts = || {
            vec![
                serde_json::json!({ "id": "mode", "category": "mode", "name": "Mode" }),
                serde_json::json!({ "id": "model", "category": "model", "name": "Model" }),
                serde_json::json!({ "id": "effort", "category": "thought_level", "name": "Effort" }),
            ]
        };
        // Claude has a posture preset (non-empty allowed_modes) → drop the duplicate mode option.
        let claude = dedup_mode_config_options("claude", opts());
        assert_eq!(claude.len(), 2);
        assert!(claude.iter().all(|o| o["id"] != "mode"));
        // A preset-less agent (empty allowed_modes) keeps it — the config option is its only mode knob.
        let generic = dedup_mode_config_options("generic", opts());
        assert_eq!(generic.len(), 3);
        assert!(generic.iter().any(|o| o["id"] == "mode"));
    }

    #[test]
    fn overlay_model_state_synthesizes_model_option() {
        // codex-style snapshot: models via the native model-state API, no
        // configOptions → a "model" select option is synthesized.
        let snapshot = serde_json::json!({
            "models": {
                "currentModelId": "gpt-5-codex",
                "availableModels": [
                    {"modelId": "gpt-5-codex", "name": "GPT-5 Codex"},
                    {"modelId": "gpt-5"},
                ],
            },
        });
        let out = overlay_model_state(&snapshot, Vec::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], "model");
        assert_eq!(out[0]["currentValue"], "gpt-5-codex");
        assert_eq!(out[0]["options"][0]["value"], "gpt-5-codex");
        // A missing name falls back to the model id.
        assert_eq!(out[0]["options"][1]["name"], "gpt-5");

        // Flattened top-level currentModelId (from a current_model_update)
        // wins over the nested one.
        let updated = serde_json::json!({
            "currentModelId": "gpt-5",
            "models": snapshot["models"].clone(),
        });
        let out = overlay_model_state(&updated, Vec::new());
        assert_eq!(out[0]["currentValue"], "gpt-5");

        // An advertised "model" configOption (claude-style) is left alone —
        // no duplicate synthesized option.
        let advertised = vec![serde_json::json!({"id": "model", "options": []})];
        let out = overlay_model_state(&snapshot, advertised);
        assert_eq!(out.len(), 1);
        assert!(out[0].get("currentValue").is_none());

        // No models state and no options → stays empty.
        assert!(overlay_model_state(&serde_json::json!({}), Vec::new()).is_empty());
    }

    #[test]
    fn urls_tolerate_trailing_slash() {
        assert_eq!(
            control_url("ws://localhost:30080/"),
            "ws://localhost:30080/ws/agent-bridge/control"
        );
        assert_eq!(data_url("wss://host"), "wss://host/ws/agent-bridge/data");
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
        assert!(toml.contains("[accounts.codex.policy.config]"));
        assert!(toml.contains(r#"allowed_config_options = ["model", "reasoning_effort", "approval_policy", "sandbox"]"#));
        // codex has no permission_mode override.
        assert!(!toml.contains("permission_mode"));
        assert!(toml.contains("ws://localhost:30080/ws/agent-bridge/control"));
        // The token plaintext must never be inlined.
        assert!(!toml.contains("agb_"));
    }

    /// OpenCode exposes ACP as `opencode acp`, not a standalone `opencode-acp`
    /// binary. Rendering the latter produced a config no host could resolve —
    /// and because the gateway mints (and thereby revokes) the bot token before
    /// the client writes anything, that stranded the bot on a token nobody had.
    #[test]
    fn renders_opencode_as_a_subcommand_of_its_own_binary() {
        let toml = render_toml(&RenderParams {
            account_id: "OpenCode",
            agent_type: "opencode",
            public_base: "wss://example.test",
            token_ref: TokenRef::File("secrets/opencode.token".into()),
        });
        assert!(toml.contains(r#"command = "opencode""#));
        assert!(toml.contains(r#"args    = ["acp"]"#));
        assert!(!toml.contains("opencode-acp"));
        // A real resolvable command is not a placeholder needing a hand edit.
        assert!(!toml.contains("PLACEHOLDER"));
    }

    /// Agents whose adapter is a dedicated binary take no argv.
    #[test]
    fn renders_empty_args_for_dedicated_adapters() {
        for agent_type in ["claude", "codex", "generic"] {
            let toml = render_toml(&RenderParams {
                account_id: "bot",
                agent_type,
                public_base: "wss://example.test",
                token_ref: TokenRef::File("secrets/bot.token".into()),
            });
            assert!(
                toml.contains("args    = []"),
                "{agent_type} should take no args"
            );
        }
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
        assert!(toml.contains(
            r#"allowed_modes        = ["default", "plan", "acceptEdits", "dontAsk", "auto"]"#
        ));
        assert!(toml.contains(
            r#"allowed_config_options = ["model", "reasoning_effort", "thinking_mode"]"#
        ));
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

    #[test]
    fn renders_registry_npx_agent_with_args() {
        let _lock = crate::domain::acp_registry::test_registry_lock();
        crate::domain::acp_registry::seed_cache_for_test(
            r#"{
              "agents": [{
                "id": "gemini",
                "name": "Gemini CLI",
                "version": "0.52.0",
                "distribution": {
                  "npx": {
                    "package": "@google/gemini-cli@0.52.0",
                    "args": ["--acp"]
                  }
                }
              }]
            }"#,
        );
        let toml = render_toml(&RenderParams {
            account_id: "gem",
            agent_type: "gemini",
            public_base: "ws://localhost:30080",
            token_ref: TokenRef::File("secrets/gem.token".into()),
        });
        assert!(toml.contains("command = \"gemini\""));
        assert!(toml.contains(r#"args    = ["--acp"]"#));
        assert!(!toml.contains("PLACEHOLDER"));
    }

    #[test]
    fn renders_registry_uvx_agent_via_uvx_launcher() {
        let _lock = crate::domain::acp_registry::test_registry_lock();
        crate::domain::acp_registry::seed_cache_for_test(
            r#"{
              "agents": [{
                "id": "fast-agent",
                "name": "fast-agent",
                "version": "0.9.22",
                "distribution": {
                  "uvx": {
                    "package": "fast-agent-acp==0.9.22",
                    "args": ["-x"]
                  }
                }
              }]
            }"#,
        );
        let toml = render_toml(&RenderParams {
            account_id: "fast",
            agent_type: "fast-agent",
            public_base: "ws://localhost:30080",
            token_ref: TokenRef::File("secrets/fast.token".into()),
        });
        assert!(toml.contains("command = \"uvx\""));
        assert!(toml.contains(r#"args    = ["fast-agent-acp==0.9.22", "-x"]"#));
        assert!(!toml.contains("PLACEHOLDER"));
    }

    #[test]
    fn renders_registry_binary_cursor() {
        let _lock = crate::domain::acp_registry::test_registry_lock();
        crate::domain::acp_registry::seed_cache_for_test(
            r#"{
              "agents": [{
                "id": "cursor",
                "name": "Cursor",
                "version": "1.0.0",
                "distribution": {
                  "binary": {
                    "darwin-aarch64": {
                      "archive": "https://example.com/cursor.tgz",
                      "cmd": "./dist-package/cursor-agent",
                      "args": ["acp"]
                    }
                  }
                }
              }]
            }"#,
        );
        let toml = render_toml(&RenderParams {
            account_id: "cur",
            agent_type: "cursor",
            public_base: "ws://localhost:30080",
            token_ref: TokenRef::File("secrets/cur.token".into()),
        });
        assert!(toml.contains("command = \"cursor-agent\""));
        assert!(toml.contains(r#"args    = ["acp"]"#));
        assert!(toml.contains("\"CURSOR_API_KEY\""));
        assert!(!toml.contains("PLACEHOLDER"));
    }
}
