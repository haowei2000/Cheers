//! ACP permission-request handling for [`RuntimeContext`].
//!
//! Split out of `mod.rs` as a second `impl RuntimeContext` block (pure
//! structural refactor — a child module can access the parent type's private
//! fields). No behavior change.

use super::*;

impl RuntimeContext {
    pub(super) async fn handle_permission_request(
        self: Arc<Self>,
        acp_session_id: String,
        params: Value,
        respond_to: oneshot::Sender<PermissionOutcome>,
    ) -> anyhow::Result<()> {
        let run = self
            .shared
            .runs
            .lock()
            .await
            .by_acp_session
            .get(&acp_session_id)
            .cloned();
        let Some(run) = run else {
            let _ = respond_to.send(PermissionOutcome::Cancelled);
            return Ok(());
        };
        // Proactive evaluation is a classification turn, never an execution
        // turn. Reject native agent tool requests even when the operator's
        // ordinary-task policy is auto_allow.
        if run.lock().await.evaluation_id.is_some() {
            let _ = respond_to.send(PermissionOutcome::Cancelled);
            return Ok(());
        }
        // ACP hands us a ToolCallUpdate (a DELTA) here, so codex's edit approvals
        // arrive as a bare `{ toolCallId, kind: "edit", status }` — the title and
        // the diff were sent earlier, in the `session/update` that opened the same
        // tool call. Fold that snapshot back in before building the card, or the
        // approver is asked to allow a write without being shown the file.
        let params = match permission_tool_call_id(&params) {
            Some(tool_call_id) => {
                let snapshot = run.lock().await.tool_call_snapshot(tool_call_id).cloned();
                match snapshot {
                    Some(snapshot) => merge_tool_call_snapshot(&params, &snapshot),
                    None => params,
                }
            }
            None => params,
        };
        // Scheme 1: Auto-approve Cheers native MCP tools locally when configured
        if self.config.policy.permission.auto_allow_cheers_mcp && is_cheers_mcp_permission(&params)
        {
            if let Some(option_id) = permission_option_id_for_resolution(&params, "allow") {
                self.trace_with_data(
                    &run,
                    "approval",
                    "approved",
                    "Auto-allowed Cheers native MCP tool permission (cheers policy)",
                    None,
                    Some(
                        serde_json::json!({ "kind": "approval", "approval_kind": "auto_allowed" }),
                    ),
                )
                .await?;
                let _ = respond_to.send(PermissionOutcome::Selected { option_id });
                return Ok(());
            }
        }
        // Auto-approve locally when configured: the gateway already enforces
        // resource authz (channel membership + role), so the per-tool ACP prompt
        // is redundant. Without this, forward_to_backend waits for a backend
        // approval that never comes and the tool call hangs.
        if self.config.policy.permission.auto_allow {
            if let Some(option_id) = permission_option_id_for_resolution(&params, "allow") {
                // phase="approval" so the gateway persists this as a durable
                // kind='approval' trace row (this path returns early and never
                // sends a PermissionRequest frame, so it is otherwise invisible
                // to the gateway). See docs/arch/TRACE_PERSISTENCE.md.
                self.trace_with_data(
                    &run,
                    "approval",
                    "approved",
                    "Auto-allowed ACP tool permission (local policy)",
                    None,
                    Some(
                        serde_json::json!({ "kind": "approval", "approval_kind": "auto_allowed" }),
                    ),
                )
                .await?;
                let _ = respond_to.send(PermissionOutcome::Selected { option_id });
                return Ok(());
            }
            tracing::warn!(
                account = %self.account_id,
                "permission.auto_allow set but no 'allow' option in params; falling back to forward"
            );
        }
        if !self.config.policy.permission.forward_to_backend {
            self.trace_with_data(
                &run,
                "approval",
                "cancelled",
                "Local daemon policy does not forward permission requests",
                None,
                Some(serde_json::json!({ "kind": "approval", "approval_kind": "rejected" })),
            )
            .await?;
            let _ = respond_to.send(PermissionOutcome::Cancelled);
            return Ok(());
        }
        let request_id = Uuid::new_v4().to_string();
        let body = permission_body_from_params(&params);
        // Extract the structured tool detail BEFORE `params` is moved into
        // pending_permissions, so the channel card can show what's being approved.
        let tool = permission_tool_from_params(&params);
        let (channel_id, task_id, msg_id, provider_session_key, session_id) = {
            let guard = run.lock().await;
            (
                guard.channel_id.clone(),
                guard.task_id.clone(),
                guard.msg_id.clone(),
                guard.provider_session_key.clone(),
                guard.session_id.clone(),
            )
        };
        // Build options via the free function — do NOT `self.adapter.lock()` here:
        // `prompt()` holds the adapter Mutex for the whole turn and is blocked
        // waiting for the very permission answer this handler produces, so locking
        // the adapter would deadlock the turn until timeout.
        let options = crate::acp_semantics::permission_options_from_params(&params);
        self.shared
            .interactions
            .lock()
            .await
            .pending_permissions
            .insert(
                request_id.clone(),
                PendingPermission {
                    params,
                    target: PendingPermissionTarget::Native(respond_to),
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
            has_tool = tool.is_some(),
            option_count = options.len(),
            "forwarding ACP permission request to Backend as approval card"
        );
        let ack = self
            .io
            .send_data_expect_send_ack(DataOutbound::PermissionRequest {
                v: BRIDGE_PROTOCOL_VERSION,
                client_msg_id: Uuid::new_v4().to_string(),
                channel_id,
                request_id: request_id.clone(),
                task_id: Some(task_id),
                msg_id: Some(msg_id),
                acp_session_id: Some(acp_session_id.clone()),
                provider_session_key: Some(provider_session_key),
                provider_session_id: Some(acp_session_id),
                session_id,
                title: Some("ACP permission request".to_string()),
                body,
                tool,
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
                    if let Ok(resolution) = serde_json::from_value::<PermissionResolution>(value) {
                        self.handle_permission_resolution(resolution).await?;
                    }
                }
            }
            Ok(frame) => {
                let message = send_ack_error(&frame).unwrap_or_else(|| {
                    "permission request was rejected by Agent Bridge".to_string()
                });
                let pending = self
                    .shared
                    .interactions
                    .lock()
                    .await
                    .pending_permissions
                    .remove(&request_id);
                if let Some(pending) = pending {
                    match pending.target {
                        PendingPermissionTarget::Native(tx) => {
                            let _ = tx.send(PermissionOutcome::Cancelled);
                        }
                        PendingPermissionTarget::TranslatedElicitation(tx) => {
                            let _ = tx.send(elicitation::cancel_response());
                        }
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
                tracing::warn!(
                    account = %self.account_id,
                    request_id = %request_id,
                    "Agent Bridge permission request send_ack failed: {message}"
                );
            }
            Err(err) => {
                let pending = self
                    .shared
                    .interactions
                    .lock()
                    .await
                    .pending_permissions
                    .remove(&request_id);
                if let Some(pending) = pending {
                    match pending.target {
                        PendingPermissionTarget::Native(tx) => {
                            let _ = tx.send(PermissionOutcome::Cancelled);
                        }
                        PendingPermissionTarget::TranslatedElicitation(tx) => {
                            let _ = tx.send(elicitation::cancel_response());
                        }
                    }
                }
                let _ = self
                    .io
                    .send_data(DataOutbound::PermissionCancel {
                        v: BRIDGE_PROTOCOL_VERSION,
                        request_id: request_id.clone(),
                        reason: "bridge_ack_failed".to_string(),
                    })
                    .await;
                tracing::warn!(
                    account = %self.account_id,
                    request_id = %request_id,
                    "Agent Bridge permission request send_ack timeout/error: {err}"
                );
            }
        }
        Ok(())
    }

    pub(super) async fn handle_permission_timeout(&self, request_id: String) {
        let pending = self
            .shared
            .interactions
            .lock()
            .await
            .pending_permissions
            .remove(&request_id);
        let Some(pending) = pending else {
            return;
        };
        match pending.target {
            PendingPermissionTarget::Native(tx) => {
                let action = self.config.policy.permission.on_timeout;
                let outcome = match action {
                    PermissionTimeoutAction::Cancel | PermissionTimeoutAction::Deny => {
                        PermissionOutcome::Cancelled
                    }
                };
                let _ = tx.send(outcome);
            }
            PendingPermissionTarget::TranslatedElicitation(tx) => {
                let _ = tx.send(elicitation::cancel_response());
            }
        }
        // Tell the gateway to finalize the (still-pending) channel card so it
        // doesn't hang forever. Best-effort: the ACP turn is already answered.
        let _ = self
            .io
            .send_data(DataOutbound::PermissionCancel {
                v: BRIDGE_PROTOCOL_VERSION,
                request_id: request_id.clone(),
                reason: "timeout".to_string(),
            })
            .await;
        tracing::warn!(
            account = %self.account_id,
            request_id = %request_id,
            "ACP permission request timed out waiting for Backend resolution"
        );
    }

    pub(super) async fn handle_permission_resolution(
        &self,
        resolution: PermissionResolution,
    ) -> anyhow::Result<()> {
        let pending = self
            .shared
            .interactions
            .lock()
            .await
            .pending_permissions
            .remove(&resolution.request_id);
        let Some(pending) = pending else {
            return Ok(());
        };
        match pending.target {
            PendingPermissionTarget::Native(tx) => {
                // ACP has no distinct "deny" outcome: a rejection is `selected` with a
                // reject-kind optionId. `cancelled` means the whole turn was aborted —
                // NOT "the user said no". So honor an explicit option_id for BOTH allow
                // and reject; only fall back to Cancelled when no option can be resolved
                // (e.g. a bare "cancel" with nothing selected).
                let outcome = resolution
                    .option_id
                    .clone()
                    .or_else(|| {
                        permission_option_id_for_resolution(&pending.params, &resolution.resolution)
                    })
                    .map(|option_id| PermissionOutcome::Selected { option_id })
                    .unwrap_or(PermissionOutcome::Cancelled);
                tracing::info!(
                    account = %self.account_id,
                    request_id = %resolution.request_id,
                    outcome = ?outcome,
                    "Backend resolved ACP permission request"
                );
                let _ = tx.send(outcome);
            }
            PendingPermissionTarget::TranslatedElicitation(tx) => {
                let opt = resolution
                    .option_id
                    .as_deref()
                    .unwrap_or(resolution.resolution.as_str());
                let response = match opt {
                    "allow_session" => json!({
                        "action": "accept",
                        "content": { "persist": "session", "approval_scope": "session" }
                    }),
                    "allow_always" => json!({
                        "action": "accept",
                        "content": { "persist": "always", "approval_scope": "always" }
                    }),
                    "allow_once" => json!({
                        "action": "accept",
                        "content": { "persist": "once", "approval_scope": "once" }
                    }),
                    "decline" | "reject" => json!({
                        "action": "decline",
                        "content": null
                    }),
                    other if other.starts_with("allow") => json!({
                        "action": "accept",
                        "content": { "persist": "session", "approval_scope": "session" }
                    }),
                    _ => elicitation::cancel_response(),
                };
                tracing::info!(
                    account = %self.account_id,
                    request_id = %resolution.request_id,
                    chosen_option = %opt,
                    "Backend resolved translated MCP elicitation permission"
                );
                let _ = tx.send(response);
            }
        }
        Ok(())
    }
}

pub(super) fn is_cheers_mcp_permission(params: &Value) -> bool {
    let msg = params.get("message").and_then(Value::as_str).unwrap_or("");
    if let Some((server, _)) = elicitation::parse_mcp_tool_approval_message(msg) {
        if is_cheers_mcp_server_name(&server) {
            return true;
        }
    }
    if let Some(tool) = params.get("tool").or_else(|| params.get("toolCall")) {
        if let Some(server) = tool
            .get("server_name")
            .or_else(|| tool.get("serverName"))
            .and_then(Value::as_str)
        {
            if is_cheers_mcp_server_name(server) {
                return true;
            }
        }
        if let Some(name) = tool
            .get("name")
            .or_else(|| tool.get("tool"))
            .and_then(Value::as_str)
        {
            if is_cheers_mcp_server_name(name) {
                return true;
            }
        }
        if let Some(cmd) = tool.get("command").and_then(Value::as_str) {
            if is_cheers_mcp_server_name(cmd) || cmd.starts_with("cheers") {
                return true;
            }
        }
    }
    false
}
