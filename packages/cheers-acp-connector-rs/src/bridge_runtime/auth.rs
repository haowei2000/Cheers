//! ACP agent re-authentication wait for [`RuntimeContext`].
//!
//! When `session/new` / `prompt` fail with an auth-class error, the connector
//! retries `authenticate` once locally, then surfaces an `auth_required` channel
//! card and waits for a human `auth_acknowledged` (retry / cancel) — same wait
//! pattern as permission cards, but the outcome drives ACP authenticate rather
//! than `request_permission`.

use super::*;
use crate::acp_adapter::{looks_like_auth_error, preferred_auth_method, AuthMethodInfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AuthAckAction {
    Retry,
    Cancel,
}

impl RuntimeContext {
    /// After an ACP op fails with an auth-looking error: try `authenticate`
    /// once silently; if that still fails (or the op still fails after), ask
    /// the human via an `auth_required` card, then retry authenticate on ack.
    ///
    /// Returns `Ok(())` when the caller should retry the original op; `Err` when
    /// the human cancelled / timed out / authenticate still fails.
    pub(super) async fn recover_agent_auth(
        &self,
        task: &TaskCommand,
        err: &anyhow::Error,
    ) -> anyhow::Result<()> {
        let message = err.to_string();
        if !looks_like_auth_error(&message) {
            return Err(anyhow!(message));
        }
        tracing::warn!(
            account = %self.account_id,
            "ACP op failed with auth-class error; attempting re-authenticate"
        );
        let silent = {
            let mut adapter = self.adapter.lock().await;
            adapter.authenticate().await
        };
        if silent.is_ok() {
            return Ok(());
        }
        let detail = silent
            .as_ref()
            .err()
            .map(|e| e.to_string())
            .unwrap_or_else(|| message.clone());
        tracing::warn!(
            account = %self.account_id,
            "ACP re-authenticate failed; requesting human auth — {detail}"
        );
        self.request_human_auth(task, &detail).await?;
        let mut adapter = self.adapter.lock().await;
        adapter.authenticate().await?;
        Ok(())
    }

    async fn request_human_auth(&self, task: &TaskCommand, detail: &str) -> anyhow::Result<()> {
        let method = {
            let adapter = self.adapter.lock().await;
            adapter
                .initialize_response()
                .and_then(preferred_auth_method)
                .unwrap_or_else(|| AuthMethodInfo {
                    id: "default".into(),
                    name: Some("Sign in".into()),
                    description: Some(detail.to_string()),
                    link: None,
                    auth_type: None,
                })
        };
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.shared.lock().await.pending_auths.insert(
            request_id.clone(),
            PendingAuth {
                respond_to: tx,
                method_id: method.id.clone(),
            },
        );
        let shared = self.shared.clone();
        let io = self.io.clone();
        let account_id = self.account_id.clone();
        let timeout_request_id = request_id.clone();
        let wait_ms = self.config.policy.permission.wait_timeout_ms.max(60_000);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            let pending = shared
                .lock()
                .await
                .pending_auths
                .remove(&timeout_request_id);
            let Some(pending) = pending else {
                return;
            };
            let _ = pending.respond_to.send(AuthAckAction::Cancel);
            let _ = io
                .send_data(DataOutbound::AuthCancel {
                    v: BRIDGE_PROTOCOL_VERSION,
                    request_id: timeout_request_id.clone(),
                    reason: "timeout".to_string(),
                })
                .await;
            tracing::warn!(
                account = %account_id,
                request_id = %timeout_request_id,
                "ACP auth_required timed out waiting for human acknowledgment"
            );
        });
        let description = method
            .description
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| detail.to_string());
        tracing::info!(
            account = %self.account_id,
            request_id = %request_id,
            method_id = %method.id,
            "forwarding ACP auth_required card to Backend"
        );
        if let Err(err) = self
            .io
            .send_data_expect_send_ack(DataOutbound::AuthRequired {
                v: BRIDGE_PROTOCOL_VERSION,
                client_msg_id: Uuid::new_v4().to_string(),
                channel_id: task.channel_id.clone(),
                request_id: request_id.clone(),
                task_id: Some(task.task_id.clone()),
                msg_id: Some(task.msg_id.clone()),
                method_id: method.id.clone(),
                name: method.name.clone(),
                description: Some(description),
                link: method.link.clone(),
                auth_type: method.auth_type.clone(),
                provider_session_key: Some(task.provider_session_key.clone()),
                provider_session_id: None,
                session_id: task.session_id.clone(),
                acp_capability: None,
            })
            .await
        {
            self.shared.lock().await.pending_auths.remove(&request_id);
            return Err(anyhow!("auth_required send failed: {err}"));
        }
        match rx.await {
            Ok(AuthAckAction::Retry) => Ok(()),
            Ok(AuthAckAction::Cancel) => Err(anyhow!("agent auth cancelled by user")),
            Err(_) => Err(anyhow!("agent auth wait aborted")),
        }
    }

    pub(super) async fn handle_auth_acknowledged(
        &self,
        request_id: String,
        action: String,
    ) -> anyhow::Result<()> {
        let pending = self.shared.lock().await.pending_auths.remove(&request_id);
        let Some(pending) = pending else {
            return Ok(());
        };
        let ack = if action.eq_ignore_ascii_case("retry") {
            AuthAckAction::Retry
        } else {
            AuthAckAction::Cancel
        };
        tracing::info!(
            account = %self.account_id,
            request_id = %request_id,
            action = ?ack,
            method_id = %pending.method_id,
            "Backend acknowledged ACP auth_required"
        );
        let _ = pending.respond_to.send(ack);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::acp_adapter::looks_like_auth_error;

    #[test]
    fn detects_common_auth_error_strings() {
        assert!(looks_like_auth_error("Authentication required"));
        assert!(looks_like_auth_error(
            "ACP authenticate(cursor_login) failed: not logged in"
        ));
        assert!(looks_like_auth_error("Please sign in to continue"));
        assert!(!looks_like_auth_error("tool call timed out"));
        assert!(!looks_like_auth_error("session not found"));
    }
}
