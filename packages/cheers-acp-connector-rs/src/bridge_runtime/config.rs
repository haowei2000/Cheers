//! One desired-state path for bot defaults and session overrides. Transport
//! adapters perform ACP calls; this module merges, clamps, and reconciles config.

use super::*;

/// Gateway session snapshots survive connector reconnects through task replay.
/// Local copies only order concurrent/queued task and immediate-control delivery.
pub(super) struct DesiredSessionConfigs {
    defaults: SessionConfigOverrides,
    sessions: HashMap<String, SessionConfigOverrides>,
}

impl DesiredSessionConfigs {
    pub(super) fn new(agent: &crate::config::StdioAgentConfig) -> Self {
        Self {
            defaults: SessionConfigOverrides {
                permission_mode: agent
                    .agent_native_permission_mode
                    .as_ref()
                    .filter(|mode| !mode.trim().is_empty())
                    .cloned(),
                config_options: agent
                    .config_options
                    .as_ref()
                    .and_then(Value::as_object)
                    .map(|map| {
                        map.iter()
                            .filter_map(|(key, value)| {
                                value.as_str().map(|value| (key.clone(), value.to_string()))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                ..Default::default()
            },
            sessions: HashMap::new(),
        }
    }

    pub(super) fn remember(&mut self, key: &str, desired: SessionConfigOverrides) {
        if self
            .sessions
            .get(key)
            .is_none_or(|old| desired.revision >= old.revision)
        {
            self.sessions.insert(key.to_string(), desired);
        }
    }

    fn effective(&self, key: &str, policy: &LocalPolicy) -> SessionConfigOverrides {
        let mut effective = self.defaults.clone();
        if let Some(desired) = self.sessions.get(key) {
            if let Some(mode) = desired
                .permission_mode
                .as_ref()
                .filter(|mode| policy.permission.may_set_mode(mode))
            {
                effective.permission_mode = Some(mode.clone());
            }
            effective.config_options.extend(
                desired
                    .config_options
                    .iter()
                    .filter(|(id, _)| policy.config.allowed_config_options.contains(id))
                    .map(|(id, value)| (id.clone(), value.clone())),
            );
        }
        effective
    }
}

enum SessionSetting {
    Mode(String),
    Option { id: String, value: String },
}

impl SessionSetting {
    fn id(&self) -> &str {
        match self {
            Self::Mode(_) => "mode",
            Self::Option { id, .. } => id,
        }
    }
    fn value(&self) -> &str {
        match self {
            Self::Mode(value) | Self::Option { value, .. } => value,
        }
    }
}

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
        let (mut settings, mut rejected) = self.filter_settings_by_policy(settings);
        // Session settings belong to orchestration, not to either ACP transport.
        // Updating bot defaults affects the next reconciliation of every session.
        let mut session_fields = Vec::new();
        {
            let mut configs = self.shared.session_configs.lock().await;
            if let Some(mode) = settings.agent_native_permission_mode.take() {
                configs.defaults.permission_mode = Some(mode);
                session_fields.push("agentNativePermissionMode".to_string());
            }
            if let Some(options) = settings.config_options.take() {
                configs.defaults.config_options =
                    serde_json::from_value(options).context("invalid filtered config options")?;
                session_fields.push("configOptions".to_string());
            }
            if let Some(model) = settings.model.take() {
                configs
                    .defaults
                    .config_options
                    .insert("model".to_string(), model);
                session_fields.push("model".to_string());
            }
        }
        let mut result = self.adapter.lock().await.apply_settings(&settings).await?;
        result.applied.extend(session_fields);
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
                        if self.config_option_allowed(id) && value.is_string() {
                            kept.insert(id.clone(), value.clone());
                        } else {
                            rejected.push(ConfigStatusRejectedField {
                                field: format!("configOptions.{id}"),
                                reason: format!(
                                    "config option {id:?} must be allowed by L0 and have a string value"
                                ),
                            });
                        }
                    }
                    settings.config_options = Some(Value::Object(kept));
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

    /// Merge persisted bot defaults with the latest session override, then apply
    /// through one ACP path after new/load and immediate changes. Callers serialize
    /// this with the session's turn lock so setup cannot overwrite a newer change.
    pub(super) async fn reconcile_session_config(
        &self,
        key: &str,
        acp_session_id: &str,
    ) -> anyhow::Result<()> {
        let desired = self
            .shared
            .session_configs
            .lock()
            .await
            .effective(key, &self.config.policy);
        let mut adapter = self.adapter.lock().await;
        if let Some(mode) = desired.permission_mode {
            adapter
                .set_mode(acp_session_id, &mode)
                .await
                .with_context(|| format!("could not apply desired session mode {mode:?}"))?;
        }
        for (id, value) in desired.config_options {
            if let Some(response) =
                apply_config_option(adapter.as_mut(), acp_session_id, &id, &value).await?
            {
                // ACP returns the complete current catalogue in the response;
                // an additional session/update notification is not required.
                self.report_session_snapshot(&response).await;
            }
        }
        Ok(())
    }

    pub(super) async fn remember_session_config(
        &self,
        key: Option<&str>,
        snapshot: Option<&SessionConfigOverrides>,
    ) {
        if let (Some(key), Some(snapshot)) = (key, snapshot) {
            self.shared
                .session_configs
                .lock()
                .await
                .remember(key, snapshot.clone());
        }
    }

    pub(super) async fn handle_config_option_set(
        &self,
        request_id: String,
        session_id: Option<String>,
        provider_session_key: Option<String>,
        config_id: String,
        value: String,
        session_config: Option<SessionConfigOverrides>,
    ) -> anyhow::Result<()> {
        self.apply_session_change(
            request_id,
            session_id,
            provider_session_key,
            SessionSetting::Option {
                id: config_id,
                value,
            },
            session_config,
        )
        .await
    }

    pub(super) async fn handle_mode_set(
        &self,
        request_id: String,
        session_id: Option<String>,
        provider_session_key: Option<String>,
        mode: String,
        session_config: Option<SessionConfigOverrides>,
    ) -> anyhow::Result<()> {
        self.apply_session_change(
            request_id,
            session_id,
            provider_session_key,
            SessionSetting::Mode(mode),
            session_config,
        )
        .await
    }

    async fn apply_session_change(
        &self,
        request_id: String,
        session_id: Option<String>,
        provider_session_key: Option<String>,
        setting: SessionSetting,
        snapshot: Option<SessionConfigOverrides>,
    ) -> anyhow::Result<()> {
        let config_id = setting.id().to_string();
        let value = setting.value().to_string();
        let allowed = match &setting {
            SessionSetting::Mode(mode) => self.config.policy.permission.may_set_mode(mode),
            SessionSetting::Option { id, .. } => self.config_option_allowed(id),
        };
        let target_key = provider_session_key
            .as_ref()
            .or(session_id.as_ref())
            .cloned();
        let result = if !allowed {
            Err((
                "LOCAL_POLICY_DENIED",
                "local daemon policy does not allow this session setting".to_string(),
            ))
        } else if let Some(key) = target_key {
            {
                let mut configs = self.shared.session_configs.lock().await;
                if let Some(snapshot) = snapshot {
                    configs.remember(&key, snapshot);
                } else {
                    // Old gateways send a delta without a revision. Keep that
                    // compatible input at the boundary; modern peers send snapshots.
                    let desired = configs.sessions.entry(key.clone()).or_default();
                    match &setting {
                        SessionSetting::Mode(mode) => desired.permission_mode = Some(mode.clone()),
                        SessionSetting::Option { id, value } => {
                            desired.config_options.insert(id.clone(), value.clone());
                        }
                    }
                }
            }
            let session_lock = self.session_lock(&key).await;
            let _guard = session_lock.lock().await;
            let acp_id = match &session_id {
                Some(id) => Some(id.clone()),
                None => self.state.lock().await.get(&self.account_id, &key),
            };
            match acp_id {
                Some(acp_id) => self
                    .reconcile_session_config(&key, &acp_id)
                    .await
                    .map_err(|error| ("CONFIG_OPTION_FAILED", error.to_string())),
                // Desired config is valid before the first ACP session exists.
                // The next task replays the persisted gateway snapshot as well.
                None => Ok(()),
            }
        } else {
            Err((
                "SESSION_NOT_FOUND",
                "session target is required".to_string(),
            ))
        };
        let (ok, error, code) = match result {
            Ok(()) => (true, None, None),
            Err((code, error)) => (false, Some(error), Some(code.to_string())),
        };
        self.io
            .send_control(ControlOutbound::ConfigOptionStatus {
                v: BRIDGE_PROTOCOL_VERSION,
                request_id,
                ok,
                session_id,
                provider_session_key,
                config_id: Some(config_id),
                value: Some(value),
                options: None,
                error,
                code,
            })
            .await
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

/// The native model API is a compatibility fallback for older ACP agents. Both
/// setup reconciliation and immediate changes use exactly this implementation.
async fn apply_config_option(
    adapter: &mut dyn RuntimeAdapter,
    session_id: &str,
    id: &str,
    value: &str,
) -> anyhow::Result<Option<Value>> {
    match adapter.set_config_option(session_id, id, value).await {
        Ok(response) => Ok(Some(response)),
        Err(error) if id == "model" => {
            // The legacy native-model method has no configuration catalogue in
            // its response. Do not invent one or erase the last advertisement.
            adapter
                .set_model(session_id, value)
                .await
                .with_context(|| {
                    format!("model rejected by set_config_option ({error}) and set_model")
                })
                .map(|()| None)
        }
        Err(error) => {
            Err(error).with_context(|| format!("could not apply desired session config {id:?}"))
        }
    }
}
