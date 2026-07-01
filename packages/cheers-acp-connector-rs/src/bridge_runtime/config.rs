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
        // Posture mode (ACP session/set_mode modeId). Defense-in-depth L0: the
        // backend may set it only if BOTH the native-options gate is open AND the
        // mode passes the set-mode envelope (allowed_modes). Either gate closed →
        // reject. The envelope is a pure string match — the connector never
        // interprets a mode's meaning (ACP-generic; see BOT_CONFIG_GOVERNANCE.md).
        if let Some(mode) = settings.agent_native_permission_mode.clone() {
            let native_ok = self.config.policy.config.backend_may_set_native_options;
            let envelope_ok = self.config.policy.permission.may_set_mode(&mode);
            if !native_ok || !envelope_ok {
                settings.agent_native_permission_mode = None;
                let reason = if !native_ok {
                    "local daemon policy does not allow Backend to set native options".to_string()
                } else {
                    format!("mode {mode:?} is not in the L0 allowed_modes envelope")
                };
                rejected.push(ConfigStatusRejectedField {
                    field: "agentNativePermissionMode".to_string(),
                    reason,
                });
            }
        }
        // Backend-desired ACP config options ({configId: value}). L0 clamp: keep
        // only ids in the allowed_config_options envelope (pure string match — the
        // connector never interprets a config option's meaning; ACP-generic).
        if let Some(config_options) = settings.config_options.take() {
            match config_options.as_object() {
                Some(map) => {
                    let mut kept = serde_json::Map::new();
                    for (id, value) in map {
                        if self.config_option_allowed(id) {
                            kept.insert(id.clone(), value.clone());
                        } else {
                            rejected.push(ConfigStatusRejectedField {
                                field: format!("configOptions.{id}"),
                                reason: format!(
                                    "config option {id:?} is not in the L0 allowed_config_options envelope"
                                ),
                            });
                        }
                    }
                    if !kept.is_empty() {
                        settings.config_options = Some(Value::Object(kept));
                    }
                }
                None => rejected.push(ConfigStatusRejectedField {
                    field: "configOptions".to_string(),
                    reason: "configOptions must be a {configId: value} object".to_string(),
                }),
            }
        }
        (settings, rejected)
    }

    pub(super) fn validate_backend_cwd(&self, cwd: &str) -> Result<PathBuf, String> {
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

    pub(super) async fn handle_mode_set(
        &self,
        request_id: String,
        session_id: Option<String>,
        provider_session_key: Option<String>,
        mode: String,
    ) -> anyhow::Result<()> {
        // L0 value-clamp: unlike config_option_set (which checks only the config
        // id), mode is validated against the allowed_modes envelope — so a
        // delegated mode change can never select a value outside the host's L0.
        if !self.config.policy.permission.may_set_mode(&mode) {
            self.io
                .send_control(ControlOutbound::ConfigOptionStatus {
                    v: BRIDGE_PROTOCOL_VERSION,
                    request_id,
                    ok: false,
                    session_id,
                    provider_session_key,
                    config_id: Some("mode".to_string()),
                    value: Some(mode),
                    options: None,
                    error: Some("mode is not in the L0 allowed_modes envelope".to_string()),
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
                    config_id: Some("mode".to_string()),
                    value: Some(mode),
                    options: None,
                    error: Some("runtime session is not active".to_string()),
                    code: Some("SESSION_NOT_FOUND".to_string()),
                })
                .await?;
            return Ok(());
        };
        let result = self.adapter.lock().await.set_mode(&acp_session_id, &mode).await;
        match result {
            Ok(()) => {
                self.io
                    .send_control(ControlOutbound::ConfigOptionStatus {
                        v: BRIDGE_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        session_id,
                        provider_session_key,
                        config_id: Some("mode".to_string()),
                        value: Some(mode),
                        options: None,
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
                        config_id: Some("mode".to_string()),
                        value: Some(mode),
                        options: None,
                        error: Some(err.to_string()),
                        code: Some("MODE_SET_FAILED".to_string()),
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
