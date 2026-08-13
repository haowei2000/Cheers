//! Data-only presentation profiles for native Agent MCP authentication.
//!
//! Profiles provide operator hints and tested version ranges. They never select
//! runtime behavior, mutate credentials, or branch the Connector's ACP flow.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
/// Presentation-only metadata for a supported native ACP Agent.
pub struct AgentProfile {
    pub id: &'static str,
    pub display_name: &'static str,
    pub login_hint: &'static str,
    pub verified_version_range: Option<&'static str>,
}

const CODEX: AgentProfile = AgentProfile {
    id: "codex",
    display_name: "Codex",
    login_hint: "Run `codex mcp login cheers` on the Agent host, then retry.",
    verified_version_range: None,
};
const CLAUDE: AgentProfile = AgentProfile {
    id: "claude",
    display_name: "Claude",
    login_hint: "Open `/mcp`, select Cheers, and choose Authenticate.",
    verified_version_range: None,
};
const GEMINI: AgentProfile = AgentProfile {
    id: "gemini",
    display_name: "Gemini",
    login_hint: "Run `/mcp auth cheers` in Gemini CLI.",
    verified_version_range: None,
};
const OPENCODE: AgentProfile = AgentProfile {
    id: "opencode",
    display_name: "OpenCode",
    login_hint: "Run `opencode mcp auth cheers` or use `/connect`.",
    verified_version_range: None,
};
const GENERIC: AgentProfile = AgentProfile {
    id: "generic",
    display_name: "ACP Agent",
    login_hint: "Complete the Agent's native HTTP MCP OAuth flow, then retry.",
    verified_version_range: None,
};

/// Returns presentation metadata without selecting runtime behavior.
pub fn profile(agent_type: &str) -> AgentProfile {
    let normalized = agent_type.trim().to_ascii_lowercase();
    if normalized.contains("codex") {
        CODEX
    } else if normalized.contains("claude") {
        CLAUDE
    } else if normalized.contains("gemini") {
        GEMINI
    } else if normalized.contains("opencode") {
        OPENCODE
    } else {
        GENERIC
    }
}

#[cfg(test)]
mod tests {
    use super::profile;

    #[test]
    fn profiles_are_data_only_and_match_registry_style_ids() {
        assert_eq!(profile("codex-acp").id, "codex");
        assert_eq!(profile("claude-agent-acp").id, "claude");
        assert_eq!(profile("unknown").id, "generic");
    }
}
