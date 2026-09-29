//! ACP v1 elicitation orchestration between the runtime and Cheers UI.

use super::*;

const SENSITIVE_TERMS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "private_key",
    "access_token",
    "refresh_token",
    "auth_token",
    "recovery_code",
    "credit_card",
    "card_number",
    "cvv",
];

/// Rejects form schemas that appear to request credentials or payment secrets.
fn schema_requests_sensitive_data(schema: &Value) -> bool {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return false;
    };
    properties.iter().any(|(name, property)| {
        let description = property
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let title = property
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let normalized_name = name.to_ascii_lowercase().replace(['-', ' '], "_");
        let prose = format!("{title} {description}").to_ascii_lowercase();
        SENSITIVE_TERMS
            .iter()
            .any(|term| normalized_name == *term || prose.contains(&term.replace('_', " ")))
    })
}

/// Builds the fail-closed ACP response used for invalid, timed-out, or unroutable requests.
pub(super) fn cancel_response() -> Value {
    json!({"action": "cancel"})
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct McpToolApproval {
    pub server_name: String,
    pub tool_name: String,
}

pub(super) fn parse_mcp_tool_approval_message(message: &str) -> Option<(String, String)> {
    let marker = " MCP server to run tool ";
    if let Some(pos) = message.find(marker) {
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
        if !server.is_empty() && !tool.is_empty() {
            return Some((server.to_string(), tool.to_string()));
        }
    }
    None
}

pub(super) fn detect_mcp_tool_approval(params: &Value) -> Option<McpToolApproval> {
    let is_codex_mcp = params
        .get("_meta")
        .and_then(|m| m.get("codex_approval_kind"))
        .and_then(Value::as_str)
        == Some("mcp_tool_call");

    let has_approval_scope_schema = params
        .get("requestedSchema")
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object)
        .is_some_and(|props| {
            props.contains_key("approval_scope")
                || props
                    .get("persist")
                    .and_then(|p| p.get("title"))
                    .and_then(Value::as_str)
                    == Some("Approval scope")
        });

    let message = params.get("message").and_then(Value::as_str).unwrap_or("");
    let parsed_from_message = parse_mcp_tool_approval_message(message);

    if is_codex_mcp || has_approval_scope_schema || parsed_from_message.is_some() {
        if let Some((server_name, tool_name)) = parsed_from_message {
            return Some(McpToolApproval {
                server_name,
                tool_name,
            });
        }
        let server_name = params
            .get("serverName")
            .or_else(|| params.get("_meta").and_then(|m| m.get("serverName")))
            .and_then(Value::as_str)
            .unwrap_or("mcp")
            .to_string();
        let tool_name = params
            .get("toolName")
            .or_else(|| params.get("_meta").and_then(|m| m.get("toolName")))
            .or_else(|| {
                params
                    .get("toolCall")
                    .and_then(|t| t.get("name").or_else(|| t.get("tool")))
            })
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        return Some(McpToolApproval {
            server_name,
            tool_name,
        });
    }

    None
}

impl RuntimeContext {
    /// Forwards a session- or request-scoped elicitation through its trusted route.
    pub(super) async fn handle_elicitation_request(
        self: Arc<Self>,
        acp_session_id: Option<String>,
        request_route: Option<RequestRoute>,
        params: Value,
        respond_to: oneshot::Sender<Value>,
    ) -> anyhow::Result<()> {
        let route = if let Some(acp_session_id) = acp_session_id.as_deref() {
            let run = self
                .shared
                .runs
                .lock()
                .await
                .by_acp_session
                .get(acp_session_id)
                .cloned();
            match run {
                Some(run) => {
                    let guard = run.lock().await;
                    RequestRoute {
                        channel_id: guard.channel_id.clone(),
                        task_id: guard.task_id.clone(),
                        msg_id: guard.msg_id.clone(),
                        origin_msg_id: guard.origin_msg_id.clone(),
                        session_id: guard.session_id.clone(),
                        initiating_user_id: guard.initiating_user_id.clone(),
                    }
                }
                None => {
                    let _ = respond_to.send(cancel_response());
                    return Ok(());
                }
            }
        } else {
            match request_route.filter(|route| route.initiating_user_id.is_some()) {
                Some(route) => route,
                None => {
                    let _ = respond_to.send(cancel_response());
                    return Ok(());
                }
            }
        };
        let mode = match params.get("mode").and_then(Value::as_str) {
            Some("form") => ElicitationMode::Form,
            Some("url") => ElicitationMode::Url,
            _ => {
                let _ = respond_to.send(cancel_response());
                return Ok(());
            }
        };
        if mode == ElicitationMode::Form
            && params
                .get("requestedSchema")
                .is_some_and(schema_requests_sensitive_data)
        {
            tracing::warn!(account = %self.account_id, "blocked sensitive ACP form elicitation");
            let _ = respond_to.send(cancel_response());
            return Ok(());
        }

        // Check if this elicitation is actually an MCP tool execution approval request.
        if let Some(mcp_approval) = detect_mcp_tool_approval(&params) {
            // Plan 1: Auto-approve Cheers native MCP tools
            if self.config.policy.permission.auto_allow_cheers_mcp
                && is_cheers_mcp_server_name(&mcp_approval.server_name)
            {
                tracing::info!(
                    account = %self.account_id,
                    server = %mcp_approval.server_name,
                    tool = %mcp_approval.tool_name,
                    "auto-allowing Cheers native MCP tool execution"
                );
                if let Some(acp_session_id) = acp_session_id.as_deref() {
                    let run = self
                        .shared
                        .runs
                        .lock()
                        .await
                        .by_acp_session
                        .get(acp_session_id)
                        .cloned();
                    if let Some(run) = run {
                        let _ = self
                            .trace_with_data(
                                &run,
                                "approval",
                                "approved",
                                &format!(
                                    "Auto-allowed Cheers MCP tool '{}'",
                                    mcp_approval.tool_name
                                ),
                                None,
                                Some(json!({
                                    "kind": "approval",
                                    "approval_kind": "auto_allowed",
                                    "tool": mcp_approval.tool_name,
                                    "server": mcp_approval.server_name,
                                })),
                            )
                            .await;
                    }
                }
                let _ = respond_to.send(json!({
                    "action": "accept",
                    "content": {
                        "persist": "session",
                        "approval_scope": "session"
                    }
                }));
                return Ok(());
            }

            // Plan 2: Translate external MCP tool approval elicitation to standard PermissionRequest
            let request_id = Uuid::new_v4().to_string();
            let options = vec![
                PermissionOption {
                    option_id: "allow_session".to_string(),
                    name: Some("Allow for this session".to_string()),
                    kind: Some("allow_always".to_string()),
                    description: Some("Allow without asking again during this session".to_string()),
                },
                PermissionOption {
                    option_id: "allow_once".to_string(),
                    name: Some("Allow once".to_string()),
                    kind: Some("allow_once".to_string()),
                    description: Some("Allow this call only".to_string()),
                },
                PermissionOption {
                    option_id: "decline".to_string(),
                    name: Some("Decline".to_string()),
                    kind: Some("reject_once".to_string()),
                    description: Some("Reject this tool execution".to_string()),
                },
            ];

            let tool_info = json!({
                "name": mcp_approval.tool_name,
                "title": format!("MCP Tool: {}", mcp_approval.tool_name),
                "command": format!("{} -> {}", mcp_approval.server_name, mcp_approval.tool_name),
                "summary": format!("Allow MCP server '{}' to run tool '{}'", mcp_approval.server_name, mcp_approval.tool_name),
                "raw_input": params.get("toolCall").and_then(|t| t.get("rawInput")).cloned(),
            });

            let body = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("MCP tool permission requested")
                .to_string();
            let title = Some(format!("Allow MCP server '{}'?", mcp_approval.server_name));

            self.shared
                .interactions
                .lock()
                .await
                .pending_permissions
                .insert(
                    request_id.clone(),
                    PendingPermission {
                        params: params.clone(),
                        target: PendingPermissionTarget::TranslatedElicitation(respond_to),
                    },
                );

            let timeout_runtime = self.clone();
            let timeout_request_id = request_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(
                    timeout_runtime.config.policy.permission.wait_timeout_ms,
                ))
                .await;
                timeout_runtime
                    .handle_permission_timeout(timeout_request_id)
                    .await;
            });

            tracing::info!(
                account = %self.account_id,
                request_id = %request_id,
                server = %mcp_approval.server_name,
                tool = %mcp_approval.tool_name,
                "translating MCP tool approval elicitation to PermissionRequest"
            );

            let ack = self
                .io
                .send_data_expect_send_ack(DataOutbound::PermissionRequest {
                    v: BRIDGE_PROTOCOL_VERSION,
                    client_msg_id: Uuid::new_v4().to_string(),
                    channel_id: route.channel_id,
                    request_id: request_id.clone(),
                    task_id: Some(route.task_id),
                    msg_id: Some(route.msg_id),
                    acp_session_id: acp_session_id.clone(),
                    provider_session_key: None,
                    provider_session_id: acp_session_id,
                    session_id: route.session_id,
                    title,
                    body,
                    tool: Some(tool_info),
                    options,
                    acp_capability: None,
                })
                .await;

            match ack {
                Ok(DataInbound::SendAck {
                    ok: true,
                    permission_resolution,
                    ..
                }) => {
                    if let Some(value) = permission_resolution {
                        if let Ok(resolution) =
                            serde_json::from_value::<PermissionResolution>(value)
                        {
                            self.handle_permission_resolution(resolution).await?;
                        }
                    }
                }
                Ok(_) | Err(_) => {
                    let pending = self
                        .shared
                        .interactions
                        .lock()
                        .await
                        .pending_permissions
                        .remove(&request_id);
                    if let Some(pending) = pending {
                        if let PendingPermissionTarget::TranslatedElicitation(tx) = pending.target {
                            let _ = tx.send(cancel_response());
                        }
                    }
                    let _ = self
                        .io
                        .send_data(DataOutbound::PermissionCancel {
                            v: BRIDGE_PROTOCOL_VERSION,
                            request_id: request_id.clone(),
                            reason: "bridge_rejected".to_string(),
                        })
                        .await;
                }
            }
            return Ok(());
        }

        let request_id = Uuid::new_v4().to_string();
        let acp_request_id = params.get("requestId").cloned();
        self.shared
            .interactions
            .lock()
            .await
            .pending_elicitations
            .insert(request_id.clone(), PendingElicitation { mode, respond_to });

        let timeout_runtime = self.clone();
        let timeout_request_id = request_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(
                timeout_runtime.config.policy.permission.wait_timeout_ms,
            ))
            .await;
            timeout_runtime
                .handle_elicitation_timeout(timeout_request_id)
                .await;
        });

        let result = self
            .io
            .send_data_expect_send_ack(DataOutbound::ElicitationRequest {
                v: BRIDGE_PROTOCOL_VERSION,
                client_msg_id: Uuid::new_v4().to_string(),
                channel_id: route.channel_id,
                request_id: request_id.clone(),
                task_id: route.task_id,
                msg_id: route.msg_id,
                origin_msg_id: route.origin_msg_id,
                acp_session_id,
                acp_request_id,
                initiating_user_id: route.initiating_user_id,
                session_id: route.session_id,
                params,
                acp_capability: None,
            })
            .await;
        if !matches!(result, Ok(DataInbound::SendAck { ok: true, .. })) {
            self.cancel_elicitation(&request_id, "bridge_rejected")
                .await;
        }
        Ok(())
    }

    /// Cancels a request after the existing interactive-response timeout expires.
    async fn handle_elicitation_timeout(&self, request_id: String) {
        self.cancel_elicitation(&request_id, "timeout").await;
    }

    /// Removes one pending request, responds to ACP, and finalizes its channel card.
    async fn cancel_elicitation(&self, request_id: &str, reason: &str) {
        if let Some(pending) = self
            .shared
            .interactions
            .lock()
            .await
            .pending_elicitations
            .remove(request_id)
        {
            let _ = pending.respond_to.send(cancel_response());
            let _ = self
                .io
                .send_data(DataOutbound::ElicitationCancel {
                    v: BRIDGE_PROTOCOL_VERSION,
                    request_id: request_id.to_string(),
                    reason: reason.to_string(),
                })
                .await;
        }
    }

    /// Resolves a pending request once; duplicate or stale replies are ignored.
    pub(super) async fn handle_elicitation_resolution(
        &self,
        resolution: ElicitationResolution,
    ) -> anyhow::Result<()> {
        let pending = self
            .shared
            .interactions
            .lock()
            .await
            .pending_elicitations
            .remove(&resolution.request_id);
        let Some(pending) = pending else {
            return Ok(());
        };
        let response = match resolution.action.as_str() {
            "accept" if pending.mode == ElicitationMode::Form => match resolution.content {
                Some(Value::Object(content)) => json!({"action":"accept", "content":content}),
                _ => cancel_response(),
            },
            "accept" if pending.mode == ElicitationMode::Url => json!({"action":"accept"}),
            "decline" => json!({"action":"decline"}),
            "cancel" => cancel_response(),
            _ => cancel_response(),
        };
        let _ = pending.respond_to.send(response);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_secret_fields_in_form_schema() {
        assert!(schema_requests_sensitive_data(&json!({
            "properties": {"api_key": {"type":"string"}}
        })));
        assert!(!schema_requests_sensitive_data(&json!({
            "properties": {
                "project_name": {"type":"string"},
                "max_tokens": {"type":"integer", "description":"Token budget"}
            }
        })));
    }

    #[test]
    fn parses_mcp_tool_approval_messages() {
        let msg = r#"Allow the cheers-0cc488cced5747c881687c9485b4af3c MCP server to run tool "post_message"?"#;
        let parsed = parse_mcp_tool_approval_message(msg);
        assert_eq!(
            parsed,
            Some((
                "cheers-0cc488cced5747c881687c9485b4af3c".to_string(),
                "post_message".to_string()
            ))
        );

        let msg2 = "Allow the github MCP server to run tool 'create_issue'?";
        let parsed2 = parse_mcp_tool_approval_message(msg2);
        assert_eq!(
            parsed2,
            Some(("github".to_string(), "create_issue".to_string()))
        );

        let msg3 = "Allow local-fs MCP server to run tool read_file";
        let parsed3 = parse_mcp_tool_approval_message(msg3);
        assert_eq!(
            parsed3,
            Some(("local-fs".to_string(), "read_file".to_string()))
        );

        assert_eq!(parse_mcp_tool_approval_message("What is your name?"), None);
    }

    #[test]
    fn detects_mcp_tool_approval_elicitation() {
        let codex_params = json!({
            "message": r#"Allow the cheers-0cc488cced5747c881687c9485b4af3c MCP server to run tool "post_message"?"#,
            "mode": "form",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "persist": {
                        "type": "string",
                        "title": "Approval scope",
                        "default": "once"
                    }
                },
                "required": ["persist"]
            },
            "_meta": {
                "codex_approval_kind": "mcp_tool_call"
            }
        });
        let detected = detect_mcp_tool_approval(&codex_params);
        assert!(detected.is_some());
        let info = detected.unwrap();
        assert_eq!(info.server_name, "cheers-0cc488cced5747c881687c9485b4af3c");
        assert_eq!(info.tool_name, "post_message");
        assert!(is_cheers_mcp_server_name(&info.server_name));

        let generic_form = json!({
            "message": "Enter your name",
            "mode": "form",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                }
            }
        });
        assert_eq!(detect_mcp_tool_approval(&generic_form), None);
    }
}
