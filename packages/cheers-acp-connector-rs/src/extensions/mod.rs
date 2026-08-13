//! Compile-time Agent extensions isolated from ACP runtime orchestration.
//!
//! Extensions may only enrich presentation metadata or rank advertised auth
//! methods. They cannot alter permissions, capabilities, sessions, MCP scopes,
//! credentials, or raw ACP payloads.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::acp_semantics::AuthMethodInfo;
use crate::bridge::NormalizedPresentation;

/// Read-only decoder for optional vendor metadata.
pub trait PresentationDecoder: Send + Sync {
    /// Returns an additive normalized view, or `None` when the payload does not match.
    fn decode(&self, payload: &Value) -> Option<NormalizedPresentation>;
}

/// Read-only policy that ranks advertised auth methods for presentation only.
pub trait AuthMethodPolicy: Send + Sync {
    /// Returns a higher score for a more convenient method, or `None` when this
    /// policy does not recognize the advertised method set.
    fn rank(
        &self,
        method: &AuthMethodInfo,
        methods: &[AuthMethodInfo],
        agent_env: &BTreeMap<String, String>,
    ) -> Option<i16>;
}

struct CodexExtension;

struct ClaudeExtension;

impl PresentationDecoder for CodexExtension {
    fn decode(&self, payload: &Value) -> Option<NormalizedPresentation> {
        let codex = payload.get("_meta")?.get("codex")?;
        let params = codex.get("params").unwrap_or(&Value::Null);
        let string = |value: Option<&Value>| {
            value
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let presentation = NormalizedPresentation {
            reason: string(params.get("reason")),
            command: string(params.get("command")),
            cwd: string(params.get("cwd")),
            tool_name: string(codex.get("toolName")),
        };
        (!presentation.is_empty()).then_some(presentation)
    }
}

impl PresentationDecoder for ClaudeExtension {
    fn decode(&self, payload: &Value) -> Option<NormalizedPresentation> {
        let tool_name = payload
            .pointer("/_meta/claudeCode/toolName")?
            .as_str()?
            .trim();
        (!tool_name.is_empty()).then(|| NormalizedPresentation {
            tool_name: Some(tool_name.to_string()),
            ..Default::default()
        })
    }
}

impl AuthMethodPolicy for CodexExtension {
    fn rank(
        &self,
        method: &AuthMethodInfo,
        methods: &[AuthMethodInfo],
        agent_env: &BTreeMap<String, String>,
    ) -> Option<i16> {
        let is_codex = methods.iter().any(|item| {
            matches!(
                item.id.as_str(),
                "chat-gpt" | "chat-gpt-device-code" | "chatgpt" | "chat_gpt"
            )
        });
        if !is_codex {
            return None;
        }
        let has_key = ["CODEX_API_KEY", "OPENAI_API_KEY"].iter().any(|key| {
            agent_env
                .get(*key)
                .is_some_and(|value| !value.trim().is_empty())
        });
        Some(match method.id.as_str() {
            "api-key" | "api_key" if has_key => 300,
            "chat-gpt-device-code" => 200,
            "chat-gpt" | "chatgpt" | "chat_gpt" => 100,
            _ => 0,
        })
    }
}

static CODEX: CodexExtension = CodexExtension;
static CLAUDE: ClaudeExtension = ClaudeExtension;

/// Runs every built-in decoder and merges additive normalized fields.
pub fn decode_presentation(payload: &Value) -> Option<NormalizedPresentation> {
    let mut normalized = NormalizedPresentation::default();
    for decoded in [
        &CODEX as &dyn PresentationDecoder,
        &CLAUDE as &dyn PresentationDecoder,
    ]
    .into_iter()
    .filter_map(|decoder| decoder.decode(payload))
    {
        normalized.reason = normalized.reason.or(decoded.reason);
        normalized.command = normalized.command.or(decoded.command);
        normalized.cwd = normalized.cwd.or(decoded.cwd);
        normalized.tool_name = normalized.tool_name.or(decoded.tool_name);
    }
    (!normalized.is_empty()).then_some(normalized)
}

/// Orders methods for display while preserving Agent order when no policy matches.
pub fn rank_auth_methods(
    methods: &[AuthMethodInfo],
    agent_env: &BTreeMap<String, String>,
) -> Vec<AuthMethodInfo> {
    let policies = [&CODEX as &dyn AuthMethodPolicy];
    let mut ranked: Vec<_> = methods
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, method)| {
            let score = policies
                .iter()
                .find_map(|policy| policy.rank(&method, methods, agent_env))
                .unwrap_or(0);
            (score, index, method)
        })
        .collect();
    ranked.sort_by_key(|(score, index, _)| (std::cmp::Reverse(*score), *index));
    ranked.into_iter().map(|(_, _, method)| method).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_metadata_becomes_vendor_neutral_presentation() {
        let decoded = decode_presentation(&json!({
            "_meta": {"codex": {"toolName":"shell", "params": {
                "reason":"Run tests", "command":"cargo test", "cwd":"/work"
            }}}
        }))
        .expect("decoded");
        assert_eq!(decoded.command.as_deref(), Some("cargo test"));
        assert_eq!(decoded.cwd.as_deref(), Some("/work"));
        assert_eq!(decoded.reason.as_deref(), Some("Run tests"));
    }

    #[test]
    fn codex_auth_policy_only_orders_display_methods() {
        let methods = vec![
            AuthMethodInfo::test("api-key"),
            AuthMethodInfo::test("chat-gpt"),
            AuthMethodInfo::test("chat-gpt-device-code"),
        ];
        let ranked = rank_auth_methods(&methods, &BTreeMap::new());
        assert_eq!(ranked[0].id, "chat-gpt-device-code");
    }

    #[test]
    fn claude_tool_name_becomes_vendor_neutral_presentation() {
        let decoded = decode_presentation(&json!({
            "_meta": {"claudeCode": {"toolName": "Write"}}
        }))
        .expect("decoded");
        assert_eq!(decoded.tool_name.as_deref(), Some("Write"));
    }
}
