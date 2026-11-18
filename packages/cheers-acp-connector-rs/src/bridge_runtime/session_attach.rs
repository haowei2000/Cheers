//! Attaching a session that started outside Cheers (a Codex thread, a Claude
//! Code session) to a Cheers session.
//!
//! Resolve finds the referenced id in the Agent's own ACP `session/list`;
//! attach binds it to a `provider_session_key` and `session/load`s it. Unlike a
//! normal resume, attach never falls back to `session/new`: a silently fresh
//! context would look like the user's conversation but not contain it.

use super::*;
use cheers_bridge_protocol::session_ref::{AttachMode, SessionRef, SessionSource};

/// Upper bound on `session/list` pages walked per resolve. codex-acp pages ~25
/// sessions, so this covers ~1250 recent sessions without an unbounded scan.
const MAX_SESSION_LIST_PAGES: usize = 50;

/// The app whose sessions this Agent can attach, or `None` when the Agent,
/// its capabilities or local policy rule attaching out. The one gate shared by
/// the `ready` advertisement, resolve, and attach.
pub(super) fn session_attach_source(
    initialize: &Value,
    policy: &LocalPolicy,
) -> Option<SessionSource> {
    let caps = AgentCapabilities::from_initialize(Some(initialize));
    if !(caps.load_session && caps.list_sessions && policy.sessions.load) {
        return None;
    }
    initialize
        .get("agentInfo")
        .and_then(|info| info.get("name"))
        .and_then(Value::as_str)
        .and_then(SessionSource::from_agent_name)
}

/// The synthetic task a `runtime_session_control` create/resume/attach runs
/// session setup with — it has no message, only the session's identity.
pub(super) fn session_control_task(
    request_id: &str,
    session: &RuntimeSessionControlSession,
) -> TaskCommand {
    TaskCommand {
        task_id: session
            .task_scope_id
            .clone()
            .unwrap_or_else(|| request_id.to_string()),
        execution: None,
        channel_id: session.primary_scope_id.clone().unwrap_or_default(),
        msg_id: session.id.clone(),
        provider_session_key: session.provider_session_key.clone(),
        session_id: Some(session.id.clone()),
        trigger: None,
        trigger_message: None,
        attachments: Vec::new(),
        pinned: Vec::new(),
        cwd: session.cwd.clone(),
        additional_dirs: session.additional_dirs.clone(),
        context_bundle: None,
        session_config: session.session_config.clone(),
    }
}

impl RuntimeContext {
    async fn attach_source(&self) -> Option<SessionSource> {
        let initialize = self.adapter.lock().await.initialize_response()?;
        session_attach_source(&initialize, &self.config.policy)
    }

    /// `workspace_req` op `session_resolve`: find `reference` in this Agent's
    /// `session/list`. Read-only — reports metadata, never transcript content.
    pub(super) async fn resolve_session(
        &self,
        reference: &SessionRef,
    ) -> Result<Value, (String, String)> {
        let fail = |code: &str, message: String| Err((code.to_string(), message));
        if reference.mode != AttachMode::Live {
            return fail(
                "E_UNSUPPORTED",
                "only live session references resolve on a connector".into(),
            );
        }
        match self.attach_source().await {
            Some(source) if source == reference.source => {}
            Some(_) => {
                return fail(
                    "E_SOURCE_MISMATCH",
                    "this agent cannot load sessions from that app".into(),
                )
            }
            None => {
                return fail(
                    "E_UNSUPPORTED",
                    "this agent or local policy does not allow attaching sessions".into(),
                )
            }
        }

        let mut cursor: Option<String> = None;
        let mut found = None;
        for _ in 0..MAX_SESSION_LIST_PAGES {
            // Lock per page so a long walk never stalls other sessions' turns.
            let page = self
                .adapter
                .lock()
                .await
                .list_sessions(cursor.as_deref())
                .await
                .map_err(|error| ("E_AGENT".to_string(), error.to_string()))?;
            found = page.sessions.into_iter().find(|info| {
                info.get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.eq_ignore_ascii_case(&reference.native_id))
            });
            if found.is_some() {
                break;
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        let Some(info) = found else {
            return fail(
                "E_NOT_FOUND",
                "the agent on this host has no such session".into(),
            );
        };

        let cwd = info.get("cwd").and_then(Value::as_str).unwrap_or_default();
        // Attach loads the session in its own cwd, so it must pass the same
        // gate as any Backend-chosen cwd. Report rather than fail: the UI
        // explains which root the host owner would have to allow.
        let cwd_error = self.validate_backend_cwd(cwd).err();
        Ok(json!({
            "session_id": info.get("sessionId").cloned().unwrap_or(Value::Null),
            "cwd": cwd,
            "additional_directories": info
                .get("additionalDirectories")
                .cloned()
                .unwrap_or_else(|| json!([])),
            "title": info.get("title").cloned().unwrap_or(Value::Null),
            "updated_at": info.get("updatedAt").cloned().unwrap_or(Value::Null),
            "cwd_allowed": cwd_error.is_none(),
            "cwd_error": cwd_error,
        }))
    }

    /// `runtime_session_control` action `attach`: bind the Agent's existing
    /// session `provider_session_id` to `provider_session_key` and load it.
    pub(super) async fn attach_session(
        &self,
        request_id: &str,
        session: &RuntimeSessionControlSession,
    ) -> anyhow::Result<String> {
        let native_id = session
            .provider_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("attach requires provider_session_id"))?;
        if self.attach_source().await.is_none() {
            return Err(anyhow!(
                "this agent or local policy does not allow attaching sessions"
            ));
        }
        // session_start_options would fall back to default_cwd on a rejected
        // cwd; loading someone's session in a different directory is wrong, so
        // reject up front instead.
        let cwd = session
            .cwd
            .as_deref()
            .ok_or_else(|| anyhow!("attach requires the session's cwd"))?;
        self.validate_backend_cwd(cwd)
            .map_err(|reason| anyhow!("session cwd rejected by local policy: {reason}"))?;
        let key = &session.provider_session_key;
        if let Some(bound) = self.state.lock().await.get(&self.account_id, key) {
            if bound != native_id {
                return Err(anyhow!("{key} is already bound to another agent session"));
            }
        }

        let task = session_control_task(request_id, session);
        if let Some(desired) = &task.session_config {
            self.shared
                .session_configs
                .lock()
                .await
                .remember(key, desired.clone());
        }
        let options = self.session_start_options(&task).await?;
        let loaded = {
            let mut adapter = self.adapter.lock().await;
            adapter.load_session(native_id, options).await?
        };
        // Bind only after a successful load, so a failed attach leaves no
        // pointer for the next turn to resume.
        self.report_session_snapshot(&loaded.metadata).await;
        self.state
            .lock()
            .await
            .set(&self.account_id, key, native_id)
            .await?;
        self.reconcile_session_config(key, native_id).await?;
        self.report_provider_session(key, native_id).await?;
        Ok(native_id.to_string())
    }
}
