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
fn cancel_response() -> Value {
    json!({"action": "cancel"})
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
                        origin_msg_id: None,
                        session_id: guard.session_id.clone(),
                        initiating_user_id: None,
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
        if params.get("mode").and_then(Value::as_str) == Some("form")
            && params
                .get("requestedSchema")
                .is_some_and(schema_requests_sensitive_data)
        {
            tracing::warn!(account = %self.account_id, "blocked sensitive ACP form elicitation");
            let _ = respond_to.send(cancel_response());
            return Ok(());
        }

        let request_id = Uuid::new_v4().to_string();
        let acp_request_id = params.get("requestId").cloned();
        self.shared.lock().await.pending_elicitations.insert(
            request_id.clone(),
            PendingElicitation {
                params: params.clone(),
                respond_to,
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
            .lock()
            .await
            .pending_elicitations
            .remove(&resolution.request_id);
        let Some(pending) = pending else {
            return Ok(());
        };
        let mode = pending.params.get("mode").and_then(Value::as_str);
        let response = match resolution.action.as_str() {
            "accept" if mode == Some("form") => match resolution.content {
                Some(Value::Object(content)) => json!({"action":"accept", "content":content}),
                _ => cancel_response(),
            },
            "accept" if mode == Some("url") => json!({"action":"accept"}),
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
}
