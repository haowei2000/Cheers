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
            .lock()
            .await
            .by_acp_session
            .get(&acp_session_id)
            .cloned();
        let Some(run) = run else {
            let _ = respond_to.send(PermissionOutcome::Cancelled);
            return Ok(());
        };
        // Auto-approve locally when configured: the gateway already enforces
        // resource authz (channel membership + role), so the per-tool ACP prompt
        // is redundant. Without this, forward_to_backend waits for a backend
        // approval that never comes and the tool call hangs.
        if self.config.policy.permission.auto_allow {
            if let Some(option_id) = permission_option_id_for_resolution(&params, "allow") {
                self.trace(
                    &run,
                    "permission_auto_allowed",
                    "running",
                    "Auto-allowed ACP tool permission (local policy)",
                    None,
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
            self.trace(
                &run,
                "permission_rejected",
                "cancelled",
                "Local daemon policy does not forward permission requests",
                None,
            )
            .await?;
            let _ = respond_to.send(PermissionOutcome::Cancelled);
            return Ok(());
        }
        let request_id = Uuid::new_v4().to_string();
        let body = permission_body_from_params(&params);
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
        let options = self.adapter.lock().await.permission_options(&params);
        self.shared
            .lock()
            .await
            .pending_permissions
            .insert(request_id.clone(), PendingPermission { params, respond_to });
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
                tool: None,
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
                    .lock()
                    .await
                    .pending_permissions
                    .remove(&request_id);
                if let Some(pending) = pending {
                    let _ = pending.respond_to.send(PermissionOutcome::Cancelled);
                }
                tracing::warn!(
                    account = %self.account_id,
                    request_id = %request_id,
                    "Agent Bridge permission request send_ack failed: {message}"
                );
            }
            Err(err) => {
                let pending = self
                    .shared
                    .lock()
                    .await
                    .pending_permissions
                    .remove(&request_id);
                if let Some(pending) = pending {
                    let _ = pending.respond_to.send(PermissionOutcome::Cancelled);
                }
                tracing::warn!(
                    account = %self.account_id,
                    request_id = %request_id,
                    "Agent Bridge permission request send_ack timeout/error: {err}"
                );
            }
        }
        Ok(())
    }

    async fn handle_permission_timeout(&self, request_id: String) {
        let pending = self
            .shared
            .lock()
            .await
            .pending_permissions
            .remove(&request_id);
        let Some(pending) = pending else {
            return;
        };
        let action = self.config.policy.permission.on_timeout;
        let outcome = match action {
            PermissionTimeoutAction::Cancel | PermissionTimeoutAction::Deny => {
                PermissionOutcome::Cancelled
            }
        };
        let _ = pending.respond_to.send(outcome);
        tracing::warn!(
            account = %self.account_id,
            request_id = %request_id,
            action = ?action,
            "ACP permission request timed out waiting for Backend resolution"
        );
    }

    pub(super) async fn handle_permission_resolution(
        &self,
        resolution: PermissionResolution,
    ) -> anyhow::Result<()> {
        let pending = self
            .shared
            .lock()
            .await
            .pending_permissions
            .remove(&resolution.request_id);
        let Some(pending) = pending else {
            return Ok(());
        };
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
        let _ = pending.respond_to.send(outcome);
        Ok(())
    }
}
