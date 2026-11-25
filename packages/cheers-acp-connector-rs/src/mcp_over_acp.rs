//! `acp` MCP delivery: Cheers MCP served over the ACP connection itself
//! (docs/arch/MCP_AUTH_ISOLATION.md §3.4.1, M6).
//!
//! For an Agent that advertises `agentCapabilities.mcpCapabilities.acp`, each
//! channel's Cheers server is declared as `{"type": "acp", "serverId": …}`
//! instead of an HTTP URL. The Agent then sends every MCP message to the
//! connector as an ACP `mcp/message` request, and the connector forwards it to
//! the Gateway's `/mcp` with that channel's real token. Like `gateway`
//! delivery, no token ever reaches the Agent, so a renewed or task-bound token
//! always applies; unlike it, there is no loopback port to bind or protect.
//!
//! ACP's MCP-over-ACP is still unstable; the wire shapes here follow
//! agent-client-protocol-schema 1.13 (`MessageMcpRequest` /
//! `MessageMcpResponse`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use reqwest::header::{self, HeaderValue};
use reqwest::StatusCode;
use serde_json::{json, Map, Value};
use tokio::sync::RwLock;

use crate::mcp_token::McpTokenProvider;

/// `serverId` prefix; the rest is the channel id.
const SERVER_ID_PREFIX: &str = "cheers:";
/// MCP revision sent before the Agent's `initialize` names one.
const DEFAULT_PROTOCOL_VERSION: &str = "2025-11-25";
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// JSON-RPC "internal error", used for inner MCP errors the connector raises.
const INTERNAL_ERROR: i64 = -32603;

/// An outer ACP error: the `mcp/message` envelope itself was unusable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EnvelopeError {
    pub code: i64,
    pub message: String,
}

impl EnvelopeError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }
}

pub(crate) struct AcpMcpServer {
    upstream: String,
    tokens: Arc<McpTokenProvider>,
    http: reqwest::Client,
    /// The task execution each channel's current turn runs, for task-bound
    /// tokens. One ACP session per channel runs one prompt at a time.
    execution_by_channel: RwLock<HashMap<String, String>>,
    /// The MCP revision each server negotiated in `initialize`.
    protocol_by_server: RwLock<HashMap<String, String>>,
}

/// The `mcpServers` entry for one channel's Cheers server.
pub(crate) fn server_entry(name: &str, channel_id: &str) -> Value {
    json!({
        "type": "acp",
        "name": name,
        "serverId": format!("{SERVER_ID_PREFIX}{channel_id}"),
    })
}

/// Whether the Agent's `initialize` response advertises MCP-over-ACP.
pub(crate) fn agent_supports_acp(initialize: &Value) -> bool {
    initialize
        .pointer("/agentCapabilities/mcpCapabilities/acp")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

impl AcpMcpServer {
    pub(crate) fn new(upstream: String, tokens: Arc<McpTokenProvider>) -> anyhow::Result<Self> {
        // No overall timeout: a tool call may run for as long as it needs.
        let http = reqwest::Client::builder()
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .build()
            .context("failed to build the MCP-over-ACP HTTP client")?;
        Ok(Self {
            upstream,
            tokens,
            http,
            execution_by_channel: RwLock::new(HashMap::new()),
            protocol_by_server: RwLock::new(HashMap::new()),
        })
    }

    /// Binds `channel_id`'s tokens to the task execution its next turn runs,
    /// or unbinds them with `None`.
    pub(crate) async fn bind_execution(&self, channel_id: &str, execution_id: Option<&str>) {
        let mut executions = self.execution_by_channel.write().await;
        match execution_id {
            Some(execution) => {
                executions.insert(channel_id.to_string(), execution.to_string());
            }
            None => {
                executions.remove(channel_id);
            }
        }
    }

    /// Serves one `mcp/message` request: returns its ACP result, which carries
    /// either the inner MCP `result` or the inner MCP `error`.
    pub(crate) async fn handle(&self, params: &Value) -> Result<Value, EnvelopeError> {
        let server_id = params
            .get("serverId")
            .and_then(Value::as_str)
            .ok_or_else(|| EnvelopeError::invalid("mcp/message needs a serverId"))?;
        let channel_id = server_id
            .strip_prefix(SERVER_ID_PREFIX)
            .filter(|channel| !channel.is_empty())
            .ok_or_else(|| EnvelopeError::invalid(format!("unknown MCP server {server_id}")))?;
        let method = params
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| EnvelopeError::invalid("mcp/message needs a method"))?;
        let request_id = params
            .get("requestId")
            .cloned()
            .ok_or_else(|| EnvelopeError::invalid("mcp/message needs a requestId"))?;
        let inner_params = params.get("params").filter(|value| !value.is_null());

        let mut body = json!({"jsonrpc": "2.0", "method": method});
        // An MCP notification carries no id, so the Gateway answers 202.
        if !method.starts_with("notifications/") {
            body["id"] = request_id;
        }
        if let Some(inner) = inner_params {
            body["params"] = inner.clone();
        }
        let protocol = self.protocol_for(server_id, method, inner_params).await;
        let execution = self
            .execution_by_channel
            .read()
            .await
            .get(channel_id)
            .cloned();

        let outcome = match self
            .forward(channel_id, execution.as_deref(), &protocol, &body)
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::warn!(%error, channel_id, method, "MCP-over-ACP could not reach the Gateway");
                inner_error(format!("Cheers MCP is unreachable: {error:#}"))
            }
        };
        if method == "initialize" {
            if let Some(version) = outcome
                .pointer("/result/protocolVersion")
                .and_then(Value::as_str)
            {
                self.protocol_by_server
                    .write()
                    .await
                    .insert(server_id.to_string(), version.to_string());
            }
        }
        Ok(outcome)
    }

    /// The `MCP-Protocol-Version` for a request: the revision `initialize`
    /// offers, then the one it negotiated.
    async fn protocol_for(&self, server_id: &str, method: &str, params: Option<&Value>) -> String {
        if method == "initialize" {
            if let Some(offered) = params
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
            {
                return offered.to_string();
            }
        }
        self.protocol_by_server
            .read()
            .await
            .get(server_id)
            .cloned()
            .unwrap_or_else(|| DEFAULT_PROTOCOL_VERSION.to_string())
    }

    async fn forward(
        &self,
        channel_id: &str,
        execution_id: Option<&str>,
        protocol: &str,
        body: &Value,
    ) -> anyhow::Result<Value> {
        let (mut response, token) = self.send(channel_id, execution_id, protocol, body).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            // A cached token can be refused before its renewal point (credential
            // rotated, token revoked). Re-mint once; a second refusal is real.
            self.tokens
                .invalidate(channel_id, execution_id, &token)
                .await;
            (response, _) = self.send(channel_id, execution_id, protocol, body).await?;
        }
        let status = response.status();
        let event_stream = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        let text = response.text().await.context("reading the Gateway reply")?;
        Ok(outcome_from_reply(status, event_stream, &text))
    }

    async fn send(
        &self,
        channel_id: &str,
        execution_id: Option<&str>,
        protocol: &str,
        body: &Value,
    ) -> anyhow::Result<(reqwest::Response, String)> {
        let token = self
            .tokens
            .bearer(channel_id, execution_id)
            .await
            .context("minting the channel's MCP token")?;
        let response = self
            .http
            .post(&self.upstream)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(
                header::ACCEPT,
                HeaderValue::from_static("application/json, text/event-stream"),
            )
            .header("MCP-Protocol-Version", protocol)
            .body(body.to_string())
            .send()
            .await
            .context("sending to the Gateway")?;
        Ok((response, token))
    }
}

/// Maps the Gateway's HTTP reply to the ACP `mcp/message` result.
fn outcome_from_reply(status: StatusCode, event_stream: bool, text: &str) -> Value {
    // A notification is accepted without a body.
    if text.trim().is_empty() && status.is_success() {
        return json!({"result": null});
    }
    let message = if event_stream {
        // Request-scoped SSE: the final event carries the JSON-RPC response.
        text.lines()
            .rev()
            .filter_map(|line| line.strip_prefix("data:"))
            .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
            .find(|message| message.get("result").is_some() || message.get("error").is_some())
    } else {
        serde_json::from_str::<Value>(text).ok()
    };
    match message {
        Some(message) if message.get("result").is_some() => {
            json!({"result": message["result"].clone()})
        }
        Some(Value::Object(mut message)) if message.get("error").is_some_and(Value::is_object) => {
            json!({"error": message.remove("error").unwrap_or_default()})
        }
        _ => inner_error(format!(
            "Cheers MCP answered HTTP {status} without an MCP reply"
        )),
    }
}

fn inner_error(message: String) -> Value {
    let mut error = Map::new();
    error.insert("code".into(), json!(INTERNAL_ERROR));
    error.insert("message".into(), json!(message));
    json!({"error": error})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_gateway::tests::spawn_gateway;

    fn server_for(base: &str) -> AcpMcpServer {
        let upstream = format!("{base}/mcp");
        let tokens = Arc::new(
            McpTokenProvider::new(upstream.clone(), "host-1".into(), "secret".into()).unwrap(),
        );
        AcpMcpServer::new(upstream, tokens).unwrap()
    }

    fn message(method: &str, params: Value) -> Value {
        json!({"serverId": "cheers:channel-a", "requestId": "r-1", "method": method, "params": params})
    }

    #[test]
    fn entries_name_the_channel_and_capability_is_opt_in() {
        assert_eq!(
            server_entry("cheers-channela", "channel-a"),
            json!({"type": "acp", "name": "cheers-channela", "serverId": "cheers:channel-a"})
        );
        assert!(agent_supports_acp(
            &json!({"agentCapabilities": {"mcpCapabilities": {"acp": true}}})
        ));
        assert!(!agent_supports_acp(
            &json!({"agentCapabilities": {"mcpCapabilities": {"acp": false, "http": true}}})
        ));
        assert!(!agent_supports_acp(&json!({})));
    }

    #[tokio::test]
    async fn forwards_with_the_channel_token_and_negotiated_revision() {
        let fake = spawn_gateway(false).await;
        let server = server_for(&fake.base);

        let init = server
            .handle(&message(
                "initialize",
                json!({"protocolVersion": "2025-06-18"}),
            ))
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        let tools = server
            .handle(&message("tools/list", Value::Null))
            .await
            .unwrap();
        assert_eq!(tools, json!({"result": {"tools": []}}));
        // A notification has no reply body; it still answers.
        let note = server
            .handle(&json!({"serverId": "cheers:channel-a", "requestId": "n-1", "method": "notifications/initialized"}))
            .await
            .unwrap();
        assert_eq!(note, json!({"result": null}));

        let seen = fake.seen.lock().await;
        assert_eq!(seen.len(), 3);
        assert!(seen
            .iter()
            .all(|s| s.authorization.as_deref() == Some("Bearer token-1")));
        assert!(seen
            .iter()
            .all(|s| s.protocol.as_deref() == Some("2025-06-18")));
        let listed: Value = serde_json::from_str(&seen[1].body).unwrap();
        assert_eq!(
            listed,
            json!({"jsonrpc": "2.0", "id": "r-1", "method": "tools/list"})
        );
    }

    #[tokio::test]
    async fn re_mints_once_when_the_gateway_rejects_a_cached_token() {
        let fake = spawn_gateway(true).await;
        let server = server_for(&fake.base);
        let reply = server
            .handle(&message("tools/list", Value::Null))
            .await
            .unwrap();
        assert_eq!(reply, json!({"result": {"tools": []}}));
        let seen = fake.seen.lock().await;
        assert_eq!(seen[0].authorization.as_deref(), Some("Bearer token-1"));
        assert_eq!(seen[1].authorization.as_deref(), Some("Bearer token-2"));
    }

    #[tokio::test]
    async fn malformed_envelopes_are_outer_errors() {
        let server = server_for("http://127.0.0.1:9");
        for params in [
            json!({"requestId": "r", "method": "tools/list"}),
            json!({"serverId": "other:channel-a", "requestId": "r", "method": "tools/list"}),
            json!({"serverId": "cheers:", "requestId": "r", "method": "tools/list"}),
            json!({"serverId": "cheers:channel-a", "method": "tools/list"}),
        ] {
            let error = server.handle(&params).await.unwrap_err();
            assert_eq!(error.code, -32602, "{params}");
        }
    }

    #[tokio::test]
    async fn an_unreachable_gateway_is_an_inner_mcp_error() {
        let server = server_for("http://127.0.0.1:9");
        let reply = server
            .handle(&message("tools/list", Value::Null))
            .await
            .unwrap();
        assert_eq!(reply["error"]["code"], INTERNAL_ERROR);
        assert!(reply["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unreachable"));
    }

    #[test]
    fn replies_map_to_result_or_error() {
        let ok = outcome_from_reply(
            StatusCode::OK,
            false,
            r#"{"jsonrpc":"2.0","id":1,"result":{"content":[]}}"#,
        );
        assert_eq!(ok, json!({"result": {"content": []}}));
        // A refused scope is a JSON-RPC error inside an HTTP 403.
        let refused = outcome_from_reply(
            StatusCode::FORBIDDEN,
            false,
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"Insufficient OAuth scope"}}"#,
        );
        assert_eq!(refused["error"]["code"], -32003);
        let streamed = outcome_from_reply(
            StatusCode::OK,
            true,
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n",
        );
        assert_eq!(streamed, json!({"result": {"ok": true}}));
        let accepted = outcome_from_reply(StatusCode::ACCEPTED, false, "");
        assert_eq!(accepted, json!({"result": null}));
        let garbage = outcome_from_reply(StatusCode::BAD_GATEWAY, false, "<html>");
        assert_eq!(garbage["error"]["code"], INTERNAL_ERROR);
    }
}
