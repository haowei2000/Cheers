//! Compile-time Agent extensions isolated from ACP runtime orchestration.
//!
//! Extensions may only enrich presentation metadata, rank advertised auth
//! methods, or recognize vendor-shaped MCP tool approval prompts. They cannot
//! alter permissions, capabilities, sessions, MCP scopes, credentials, or raw ACP
//! payloads — what to do with a recognized approval stays a runtime policy.

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

/// An MCP tool approval recognized in an elicitation request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolApproval {
    pub server_name: String,
    pub tool_name: String,
}

impl McpToolApproval {
    /// Reads the structured server/tool fields agents attach to the request.
    pub fn from_structured_fields(params: &Value) -> Self {
        let field = |key: &str| {
            params
                .get(key)
                .or_else(|| params.get("_meta").and_then(|m| m.get(key)))
        };
        let server_name = field("serverName")
            .and_then(Value::as_str)
            .unwrap_or("mcp")
            .to_string();
        let tool_name = field("toolName")
            .or_else(|| {
                params
                    .get("toolCall")
                    .and_then(|t| t.get("name").or_else(|| t.get("tool")))
            })
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        Self {
            server_name,
            tool_name,
        }
    }
}

/// Read-only recognizer for vendor-specific MCP tool approval elicitations.
pub trait McpApprovalDecoder: Send + Sync {
    /// Returns the approval's server/tool, or `None` when the request is not one.
    fn decode_mcp_approval(&self, params: &Value) -> Option<McpToolApproval>;
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

/// Parses the approval prompt text Codex sends for MCP tool calls:
/// `Allow the <server> MCP server to run tool "<tool>"?`.
pub fn parse_mcp_approval_message(message: &str) -> Option<(String, String)> {
    let marker = " MCP server to run tool ";
    let pos = message.find(marker)?;
    let before = &message[..pos];
    let after = &message[pos + marker.len()..];
    let server = before
        .strip_prefix("Allow the ")
        .or_else(|| before.strip_prefix("Allow "))
        .unwrap_or(before)
        .trim();
    let tool_trimmed = after.trim().trim_end_matches('?').trim();
    let tool = tool_trimmed
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .or_else(|| {
            tool_trimmed
                .strip_prefix('\'')
                .and_then(|t| t.strip_suffix('\''))
        })
        .unwrap_or(tool_trimmed);
    (!server.is_empty() && !tool.is_empty()).then(|| (server.to_string(), tool.to_string()))
}

impl McpApprovalDecoder for CodexExtension {
    fn decode_mcp_approval(&self, params: &Value) -> Option<McpToolApproval> {
        let message = params.get("message").and_then(Value::as_str).unwrap_or("");
        if let Some((server_name, tool_name)) = parse_mcp_approval_message(message) {
            return Some(McpToolApproval {
                server_name,
                tool_name,
            });
        }
        let tagged = params
            .pointer("/_meta/codex_approval_kind")
            .and_then(Value::as_str)
            == Some("mcp_tool_call");
        // Codex's approval form has a `persist` field titled "Approval scope".
        let scope_form = params
            .pointer("/requestedSchema/properties/persist/title")
            .and_then(Value::as_str)
            == Some("Approval scope");
        (tagged || scope_form).then(|| McpToolApproval::from_structured_fields(params))
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

/// Runs every built-in recognizer; the first match wins.
pub fn decode_mcp_approval(params: &Value) -> Option<McpToolApproval> {
    [&CODEX as &dyn McpApprovalDecoder]
        .into_iter()
        .find_map(|decoder| decoder.decode_mcp_approval(params))
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
    fn parses_mcp_tool_approval_messages() {
        let msg = r#"Allow the cheers-0cc488cced5747c881687c9485b4af3c MCP server to run tool "post_message"?"#;
        let parsed = parse_mcp_approval_message(msg);
        assert_eq!(
            parsed,
            Some((
                "cheers-0cc488cced5747c881687c9485b4af3c".to_string(),
                "post_message".to_string()
            ))
        );

        let msg2 = "Allow the github MCP server to run tool 'create_issue'?";
        let parsed2 = parse_mcp_approval_message(msg2);
        assert_eq!(
            parsed2,
            Some(("github".to_string(), "create_issue".to_string()))
        );

        let msg3 = "Allow local-fs MCP server to run tool read_file";
        let parsed3 = parse_mcp_approval_message(msg3);
        assert_eq!(
            parsed3,
            Some(("local-fs".to_string(), "read_file".to_string()))
        );

        assert_eq!(parse_mcp_approval_message("What is your name?"), None);
    }

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
