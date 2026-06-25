//! Config-update / config-option handling for [`RuntimeContext`].
//!
//! Split out of `mod.rs` as a second `impl RuntimeContext` block (pure
//! structural refactor — a child module can access the parent type's private
//! fields). No behavior change.

use super::*;

impl RuntimeContext {
    pub(super) async fn handle_config_update(
        &self,
        revision: Option<Value>,
        settings: Option<ConnectorControlSettings>,
    ) -> anyhow::Result<()> {
        let Some(settings) = settings else {
            self.io
                .send_control(ControlOutbound::ConfigStatus {
                    v: BRIDGE_PROTOCOL_VERSION,
                    revision,
                    ok: true,
                    applied: Vec::new(),
                    rejected: Vec::new(),
                })
                .await?;
            return Ok(());
        };
        let (settings, mut rejected) = self.filter_settings_by_policy(settings);
        let result = self.adapter.lock().await.apply_settings(&settings).await?;
        rejected.extend(result.rejected);
        self.io
            .send_control(ControlOutbound::ConfigStatus {
                v: BRIDGE_PROTOCOL_VERSION,
                revision,
                ok: rejected.is_empty(),
                applied: result.applied,
                rejected,
            })
            .await
    }

    fn filter_settings_by_policy(
        &self,
        mut settings: ConnectorControlSettings,
    ) -> (ConnectorControlSettings, Vec<ConfigStatusRejectedField>) {
        let mut rejected = Vec::new();
        if settings.permission_mode.take().is_some() {
            rejected.push(ConfigStatusRejectedField {
                field: "permissionMode".to_string(),
                reason: "channel resource permission is resolved by Backend membership role; ACP permission prompts use permission_resolution".to_string(),
            });
        }
        if let Some(cwd) = settings.cwd.take() {
            match self.validate_backend_cwd(&cwd) {
                Ok(path) => settings.cwd = Some(path.display().to_string()),
                Err(reason) => rejected.push(ConfigStatusRejectedField {
                    field: "cwd".to_string(),
                    reason,
                }),
            }
        }
        if settings.model.is_some() && !self.config.policy.config.backend_may_set_model {
            settings.model = None;
            rejected.push(ConfigStatusRejectedField {
                field: "model".to_string(),
                reason: "local daemon policy does not allow Backend to set model".to_string(),
            });
        }
        if settings.agent_native_permission_mode.is_some()
            && !self.config.policy.config.backend_may_set_native_options
        {
            settings.agent_native_permission_mode = None;
            rejected.push(ConfigStatusRejectedField {
                field: "agentNativePermissionMode".to_string(),
                reason: "local daemon policy does not allow Backend to set native options"
                    .to_string(),
            });
        }
        (settings, rejected)
    }

    fn validate_backend_cwd(&self, cwd: &str) -> Result<PathBuf, String> {
        if !self.config.policy.workspace.backend_may_set_cwd {
            return Err("local daemon policy does not allow Backend to set cwd".to_string());
        }
        let path = PathBuf::from(cwd);
        if !path.is_absolute() {
            return Err("cwd must be an absolute path".to_string());
        }
        let canonical = path
            .canonicalize()
            .map_err(|err| format!("cwd cannot be canonicalized: {err}"))?;
        if self.config.policy.workspace.allowed_roots.is_empty()
            || !self
                .config
                .policy
                .workspace
                .allowed_roots
                .iter()
                .any(|root| canonical.starts_with(root))
        {
            return Err("cwd is outside local allowed workspace roots".to_string());
        }
        Ok(canonical)
    }

    pub(super) async fn handle_config_option_set(
        &self,
        request_id: String,
        session_id: Option<String>,
        provider_session_key: Option<String>,
        config_id: String,
        value: String,
    ) -> anyhow::Result<()> {
        if !self.config_option_allowed(&config_id) {
            self.io
                .send_control(ControlOutbound::ConfigOptionStatus {
                    v: BRIDGE_PROTOCOL_VERSION,
                    request_id,
                    ok: false,
                    session_id,
                    provider_session_key,
                    config_id: Some(config_id),
                    value: Some(value),
                    options: None,
                    error: Some(
                        "local daemon policy does not allow this ACP config option".to_string(),
                    ),
                    code: Some("LOCAL_POLICY_DENIED".to_string()),
                })
                .await?;
            return Ok(());
        }
        let acp_session_id = match (&session_id, &provider_session_key) {
            (Some(id), _) => Some(id.clone()),
            (_, Some(key)) => self.state.lock().await.get(&self.account_id, key),
            _ => None,
        };
        let Some(acp_session_id) = acp_session_id else {
            self.io
                .send_control(ControlOutbound::ConfigOptionStatus {
                    v: BRIDGE_PROTOCOL_VERSION,
                    request_id,
                    ok: false,
                    session_id,
                    provider_session_key,
                    config_id: Some(config_id),
                    value: Some(value),
                    options: None,
                    error: Some("runtime session is not active".to_string()),
                    code: Some("SESSION_NOT_FOUND".to_string()),
                })
                .await?;
            return Ok(());
        };
        let result = self
            .adapter
            .lock()
            .await
            .set_config_option(&acp_session_id, &config_id, &value)
            .await;
        match result {
            Ok(options) => {
                self.io
                    .send_control(ControlOutbound::ConfigOptionStatus {
                        v: BRIDGE_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        session_id,
                        provider_session_key,
                        config_id: Some(config_id),
                        value: Some(value),
                        options: Some(options),
                        error: None,
                        code: None,
                    })
                    .await
            }
            Err(err) => {
                self.io
                    .send_control(ControlOutbound::ConfigOptionStatus {
                        v: BRIDGE_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        session_id,
                        provider_session_key,
                        config_id: Some(config_id),
                        value: Some(value),
                        options: None,
                        error: Some(err.to_string()),
                        code: Some("CONFIG_OPTION_FAILED".to_string()),
                    })
                    .await
            }
        }
    }

    fn config_option_allowed(&self, config_id: &str) -> bool {
        self.config
            .policy
            .config
            .allowed_config_options
            .iter()
            .any(|item| item == config_id)
    }
}
