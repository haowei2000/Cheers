//! Transport-neutral ACP policy and wire-shape helpers.

use std::collections::BTreeMap;

use agent_client_protocol::schema::v1::{
    ClientCapabilities, ElicitationCapabilities, ElicitationFormCapabilities,
    ElicitationUrlCapabilities,
};
use serde_json::Value;

use crate::bridge::{ConfigStatusRejectedField, ConnectorControlSettings, PermissionOption};
use crate::config::StdioAgentConfig;

pub(crate) const ACP_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthMethodInfo {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub link: Option<String>,
    pub auth_type: Option<String>,
}

#[cfg(test)]
impl AuthMethodInfo {
    pub(crate) fn test(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: None,
            description: None,
            link: None,
            auth_type: None,
        }
    }
}

fn auth_method_info(value: &Value) -> Option<AuthMethodInfo> {
    let id = value
        .get("id")
        .or_else(|| value.get("methodId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    Some(AuthMethodInfo {
        id: id.to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        link: value
            .get("link")
            .and_then(Value::as_str)
            .map(str::to_string),
        auth_type: value
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn is_api_key_auth_method(method: &AuthMethodInfo) -> bool {
    let id = method.id.to_ascii_lowercase();
    matches!(
        id.as_str(),
        "api-key" | "api_key" | "apikey" | "env" | "envvar" | "env_var"
    ) || id.contains("api-key")
        || id.contains("api_key")
        || method.auth_type.as_deref().is_some_and(|kind| {
            matches!(
                kind.to_ascii_lowercase().as_str(),
                "env" | "envvar" | "env_var"
            )
        })
}

fn agent_env_has_api_credentials(agent_env: &BTreeMap<String, String>) -> bool {
    [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ]
    .iter()
    .any(|name| {
        agent_env
            .get(*name)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

/// Returns every valid Agent-advertised authentication method in display order.
pub(crate) fn advertised_auth_methods(
    initialize: &Value,
    agent_env: &BTreeMap<String, String>,
) -> Vec<AuthMethodInfo> {
    let methods: Vec<_> = initialize
        .get("authMethods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(auth_method_info)
        .collect();
    crate::extensions::rank_auth_methods(&methods, agent_env)
}

pub(crate) fn looks_like_auth_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("authentication required")
        || lower.contains("authenticate(")
        || lower.contains("not logged in")
        || lower.contains("auth required")
        || lower.contains("please log in")
        || lower.contains("please sign in")
        || lower.contains("not authenticated")
        || lower.contains("missing api key")
        || lower.contains("invalid api key")
        || lower.contains("api key required")
        || (lower.contains("unauthorized") && lower.contains("auth"))
}

pub(crate) fn auth_failure_hint(method: &AuthMethodInfo) -> String {
    let label = method
        .name
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(method.id.as_str());
    method
        .description
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|description| format!("Complete agent auth ({label}): {description}"))
        .unwrap_or_else(|| {
            format!(
                "Complete agent auth ({label}), then restart the connector. EnvVar methods need \
                 the advertised keys in the connector env; Agent methods usually open a \
                 browser/CLI login when authenticate runs."
            )
        })
}

pub(crate) fn no_link_auth_operator_hint(
    method: &AuthMethodInfo,
    agent_env: &BTreeMap<String, String>,
) -> String {
    if agent_env_has_api_credentials(agent_env) {
        return "Credentials are present in the connector→agent env, but auth still failed. Check \
                the key/token is valid, restart the connector if you just rotated it, then tap \
                \"I've signed in\" to retry."
            .into();
    }
    if is_api_key_auth_method(method) {
        return "This auth method has no login URL. On the machine running the connector, put \
                ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN (Claude) or OPENAI_API_KEY / \
                CODEX_API_KEY (Codex) into the connector service environment, restart the \
                connector, then tap \"I've signed in\"."
            .into();
    }
    "This auth method has no login URL. Complete login on the connector host under the same HOME \
     the connector uses, or set the vendor API key in the connector service environment, restart \
     the connector, then tap \"I've signed in\"."
        .into()
}

pub(crate) fn default_client_capabilities() -> Value {
    let elicitation = ElicitationCapabilities::new()
        .form(ElicitationFormCapabilities::new())
        .url(ElicitationUrlCapabilities::new());
    serde_json::to_value(ClientCapabilities::default().elicitation(elicitation))
        .expect("serializing default ACP client capabilities is infallible")
}

pub(crate) fn permission_options_from_params(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let value = item.as_object()?;
                    Some(PermissionOption {
                        option_id: value
                            .get("optionId")
                            .or_else(|| value.get("option_id"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: value
                            .get("kind")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        name: value
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        description: value
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .filter(|option| !option.option_id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) struct SettingsApplication {
    pub applied: Vec<String>,
    pub rejected: Vec<ConfigStatusRejectedField>,
    pub restart_fields: Vec<String>,
}

/// Apply backend settings to the transport-neutral agent configuration. The
/// caller owns restart/rollback because that is a runtime lifecycle operation.
pub(crate) fn apply_settings_to_config(
    config: &mut StdioAgentConfig,
    settings: &ConnectorControlSettings,
) -> SettingsApplication {
    let mut applied = Vec::new();
    let mut rejected = Vec::new();
    let mut restart_fields = Vec::new();
    if settings.permission_mode.is_some() {
        rejected.push(ConfigStatusRejectedField {
            field: "permissionMode".to_string(),
            reason: "channel resource permission is resolved by Backend membership role; ACP permission prompts use permission_resolution".to_string(),
        });
    }
    if let Some(mode) = &settings.agent_native_permission_mode {
        config.agent_native_permission_mode = Some(mode.clone());
        applied.push("agentNativePermissionMode".to_string());
    }
    if let Some(value) = settings.request_timeout_ms {
        config.request_timeout_ms = value;
        applied.push("requestTimeoutMs".to_string());
    }
    if let Some(value) = settings.prompt_timeout_ms {
        config.prompt_timeout_ms = value;
        applied.push("promptTimeoutMs".to_string());
    }
    if let Some(cwd) = &settings.cwd {
        config.cwd = Some(std::path::PathBuf::from(cwd));
        applied.push("cwd".to_string());
        restart_fields.push("cwd".to_string());
    }
    if let Some(model) = &settings.model {
        config.model = Some(model.clone());
        applied.push("model".to_string());
        restart_fields.push("model".to_string());
    }
    if let Some(config_options) = &settings.config_options {
        config.config_options = Some(config_options.clone());
        applied.push("configOptions".to_string());
    }
    SettingsApplication {
        applied,
        rejected,
        restart_fields,
    }
}
