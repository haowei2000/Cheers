//! Catalog of the ACP agents Cheers knows by name — the single place agent ids,
//! aliases, presentation profiles, and hand-tuned connector launch settings live.
//!
//! Every other agent is resolved from the live ACP registry
//! ([`crate::domain::acp_registry`]); entries here only add what the registry
//! cannot express. Callers look agents up by exact id/alias — never by substring.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
/// Presentation-only metadata for a supported native ACP Agent.
pub struct AgentProfile {
    pub id: &'static str,
    pub display_name: &'static str,
    pub login_hint: &'static str,
    pub verified_version_range: Option<&'static str>,
}

/// Hand-tuned connector launch settings that override the registry recipe.
#[derive(Debug, Clone, Copy)]
pub struct BuiltinLaunch {
    /// adapter.command — the stdio ACP agent binary.
    pub command: &'static str,
    /// adapter.args — non-empty when ACP is a subcommand of the main binary.
    pub args: &'static [&'static str],
    /// policy.env.allow beyond the base `HOME` / `PATH`.
    pub env_allow: &'static [&'static str],
    /// adapter.permission_mode — host default the bot posture overrides; None omits it.
    pub permission_mode: Option<&'static str>,
    /// policy.permission.allowed_modes — empty = any mode the agent advertises.
    pub allowed_modes: &'static [&'static str],
    /// policy.config.allowed_config_options.
    pub allowed_config_options: &'static [&'static str],
}

#[derive(Debug, Clone, Copy)]
pub struct CatalogAgent {
    pub profile: AgentProfile,
    /// Other ids naming the same agent (ACP registry id, adapter binary name).
    pub aliases: &'static [&'static str],
    /// Hand-tuned launch; None derives the launch from the ACP registry.
    pub launch: Option<BuiltinLaunch>,
    /// Env keys the agent needs that its registry entry does not advertise.
    pub extra_env_allow: &'static [&'static str],
    /// Env var for headless API-key auth, surfaced by setup UIs.
    pub api_key_env: Option<&'static str>,
}

const GENERIC_LOGIN_HINT: &str = "Complete the Agent's native HTTP MCP OAuth flow, then retry.";

/// Agent type for "something else": a placeholder, not a catalog agent.
pub const GENERIC_ID: &str = "generic";

const GENERIC: AgentProfile = AgentProfile {
    id: GENERIC_ID,
    display_name: "ACP Agent",
    login_hint: GENERIC_LOGIN_HINT,
    verified_version_range: None,
};

/// Builtins (entries with a `launch`) are listed in setup-UI order.
const AGENTS: &[CatalogAgent] = &[
    CatalogAgent {
        profile: AgentProfile {
            id: "claude",
            display_name: "Claude",
            login_hint: "Open `/mcp`, select Cheers, and choose Authenticate.",
            verified_version_range: None,
        },
        aliases: &["claude-acp", "claude-agent-acp"],
        launch: Some(BuiltinLaunch {
            command: "claude-agent-acp",
            args: &[],
            env_allow: &["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
            // "default" = Claude's "prompts for dangerous operations" mode, which
            // routes un-pre-approved tools through ACP request_permission → an
            // in-channel approval card.
            permission_mode: Some("default"),
            // Claude's advertised modes minus "bypassPermissions".
            allowed_modes: &["default", "plan", "acceptEdits", "dontAsk", "auto"],
            allowed_config_options: &["model", "reasoning_effort", "thinking_mode"],
        }),
        extra_env_allow: &[],
        api_key_env: Some("ANTHROPIC_API_KEY"),
    },
    CatalogAgent {
        profile: AgentProfile {
            id: "codex",
            display_name: "Codex",
            login_hint: "Run `codex mcp login cheers` on the Agent host, then retry.",
            verified_version_range: None,
        },
        aliases: &["codex-acp"],
        launch: Some(BuiltinLaunch {
            command: "codex-acp",
            args: &[],
            env_allow: &["OPENAI_API_KEY", "CODEX_API_KEY"],
            permission_mode: None,
            allowed_modes: &[],
            allowed_config_options: &["model", "reasoning_effort", "approval_policy", "sandbox"],
        }),
        extra_env_allow: &[],
        api_key_env: Some("OPENAI_API_KEY"),
    },
    CatalogAgent {
        profile: AgentProfile {
            id: "opencode",
            display_name: "OpenCode",
            login_hint: "Run `opencode mcp auth cheers` or use `/connect`.",
            verified_version_range: None,
        },
        aliases: &[],
        // OpenCode ships ACP as a subcommand of its main binary (`opencode acp`) —
        // there is no separate adapter, and the registry lists it binary-only.
        launch: Some(BuiltinLaunch {
            command: "opencode",
            args: &["acp"],
            env_allow: &[],
            permission_mode: None,
            allowed_modes: &[],
            allowed_config_options: &["model"],
        }),
        extra_env_allow: &[],
        api_key_env: None,
    },
    CatalogAgent {
        profile: AgentProfile {
            id: "gemini",
            display_name: "Gemini",
            login_hint: "Run `/mcp auth cheers` in Gemini CLI.",
            verified_version_range: None,
        },
        aliases: &[],
        launch: None,
        extra_env_allow: &[],
        api_key_env: None,
    },
    CatalogAgent {
        profile: AgentProfile {
            id: "cursor",
            display_name: "Cursor",
            login_hint: GENERIC_LOGIN_HINT,
            verified_version_range: None,
        },
        aliases: &[],
        launch: None,
        // Cursor Agent CLI needs its auth env when not already logged in.
        extra_env_allow: &["CURSOR_API_KEY", "CURSOR_API_ENDPOINT"],
        api_key_env: None,
    },
];

fn normalize(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

/// Exact lookup by catalog id or alias (case-insensitive).
pub fn lookup(raw: &str) -> Option<&'static CatalogAgent> {
    let id = normalize(raw);
    AGENTS
        .iter()
        .find(|a| a.profile.id == id || a.aliases.contains(&id.as_str()))
}

/// Agents with a hand-tuned launch, in setup-UI order.
pub fn builtins() -> impl Iterator<Item = &'static CatalogAgent> {
    AGENTS.iter().filter(|a| a.launch.is_some())
}

/// Returns presentation metadata without selecting runtime behavior.
pub fn profile(agent_type: &str) -> AgentProfile {
    lookup(agent_type).map_or(GENERIC, |a| a.profile)
}

/// The ACP registry id for an agent type (Cheers short names map to theirs).
pub fn registry_id(agent_type: &str) -> String {
    let id = lookup(agent_type).map_or_else(|| normalize(agent_type), |a| a.profile.id.into());
    cheers_acp_registry::registry_id_for(&id).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_resolve_by_exact_id_or_alias() {
        assert_eq!(profile("codex-acp").id, "codex");
        assert_eq!(profile("claude-agent-acp").id, "claude");
        assert_eq!(profile(" Claude ").id, "claude");
        assert_eq!(profile("unknown").id, "generic");
        // No substring guessing: a third-party wrapper is not Codex or Claude.
        assert_eq!(profile("claude-codex-bridge").id, "generic");
    }

    #[test]
    fn registry_ids_map_short_names() {
        assert_eq!(registry_id("Claude"), "claude-acp");
        assert_eq!(registry_id("codex"), "codex-acp");
        assert_eq!(registry_id("opencode"), "opencode");
        assert_eq!(registry_id("gemini"), "gemini");
        assert_eq!(registry_id("Some-Agent"), "some-agent");
    }

    #[test]
    fn ids_and_aliases_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for a in AGENTS {
            for id in std::iter::once(&a.profile.id).chain(a.aliases) {
                assert!(seen.insert(*id), "duplicate catalog id {id}");
            }
        }
    }
}
