use super::*;

pub(super) fn bridge_ready_from_initialize(initialize: &Value, policy: &LocalPolicy) -> BridgeReady {
    let runtime_name = initialize
        .get("agentInfo")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("acp-agent");
    let runtime_version = initialize
        .get("agentInfo")
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let mut ready = BridgeReady::acp(runtime_name, runtime_version);
    ready.connector_capabilities = Some(json!({
        "runtime_protocols": ["acp"],
        "runtime_session_control": policy.sessions.create
            || policy.sessions.load
            || policy.sessions.cancel
            || policy.sessions.terminate,
        "streaming": policy.prompt.allow,
        "files": policy.file_upload.allow,
        "send": policy.send.allow,
        "resource_req": true,
        "permission_request": policy.permission.forward_to_backend,
        "config_options": true,
        "trace": policy.trace.allow,
        "session_update": policy.session_update.allow,
    }));
    ready
}

pub(super) fn build_prompt(
    task: &TaskCommand,
    policy: &PromptPolicy,
    channel_name: Option<&str>,
) -> Vec<Value> {
    let mut parts = vec![
        CHEERS_ACP_OUTPUT_CONTRACT.to_string(),
        format!(
            "Cheers channel context: channel_id={}{}",
            task.channel_id,
            channel_name
                .map(|n| format!(", channel_name=\"{n}\""))
                .unwrap_or_default(),
        ),
    ];
    // Pinned convention/prompt blocks — sent every request (the semantic layer).
    for block in &task.pinned {
        if !block.trim().is_empty() {
            parts.push(block.clone());
        }
    }
    if let Some(text) = task
        .trigger_message
        .as_ref()
        .and_then(extract_trigger_text)
        .filter(|value| !value.trim().is_empty())
    {
        parts.push(text);
    }
    if policy.allow_attachments && !task.attachments.is_empty() {
        let mut lines = vec!["Cheers attachments:".to_string()];
        for attachment in &task.attachments {
            lines.push(attachment_summary_line(attachment));
        }
        parts.push(lines.join("\n"));
    }
    vec![json!({
        "type": "text",
        "text": parts.join("\n\n")
    })]
}

pub(super) const CHEERS_ACP_OUTPUT_CONTRACT: &str = "You are replying inside Cheers. Stream useful answer text through the ACP session; generated files should be returned as explicit file/resource updates when the runtime supports them.";

pub(super) fn extract_trigger_text(value: &Value) -> Option<String> {
    value
        .get("text")
        .or_else(|| value.get("content"))
        .or_else(|| value.get("body"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

pub(super) fn attachment_summary_line(attachment: &AttachmentInfo) -> String {
    let name = attachment
        .filename
        .as_deref()
        .or(attachment.file_id.as_deref())
        .unwrap_or("attachment");
    let content_type = attachment.content_type.as_deref().unwrap_or("unknown");
    let size = attachment
        .size_bytes
        .map(|value| format!(" size={value} bytes"))
        .unwrap_or_default();
    let summary = attachment
        .summary
        .as_ref()
        .map(|value| format!(" summary={value}"))
        .unwrap_or_default();
    format!("- {name} ({content_type}{size}){summary}")
}

pub(super) fn limit_text_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut out = String::new();
    for ch in value.chars() {
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

pub(super) fn text_from_content(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(array) = value.as_array() {
        let mut out = String::new();
        for item in array {
            if let Some(text) = text_from_content(item) {
                out.push_str(&text);
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    None
}

/// Structure an ACP `session/update` into a UI-facing `(title, status)` trace,
/// using the update's OWN fields. Returns `None` for non-progress updates
/// (`usage_update`, mode/config) so they are not surfaced as agent activity.
///
/// Grounded in the real ACP schema (verified against claude-agent-acp output):
/// `tool_call` / `tool_call_update` carry `{ title, kind, status, toolCallId,
/// content, rawInput, rawOutput }`. The `title` is the agent's own human label
/// (e.g. the shell command); status-only updates have none, so we skip them and
/// let the titled call/update be the informative trace.
pub(super) fn describe_session_update(kind: &str, update: &Value) -> Option<(String, String)> {
    let status = update
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("running")
        .to_string();
    match kind {
        "tool_call" | "tool_call_update" => update
            .get("title")
            .and_then(Value::as_str)
            .map(|title| (title.to_string(), status)),
        "agent_thought_chunk" => Some(("Thinking…".to_string(), "running".to_string())),
        "plan" => Some(("Planning…".to_string(), "running".to_string())),
        _ => None,
    }
}

pub(super) fn normalize_config_options_report(update: &Value) -> Value {
    json!({
        "source": "acp",
        "updatedAt": Utc::now().to_rfc3339(),
        "sessionUpdate": update.get("sessionUpdate").cloned(),
        "configOptions": update.get("configOptions").cloned(),
        "modes": update.get("modes").cloned(),
        "availableCommands": update.get("availableCommands").cloned(),
        "currentModeId": update.get("currentModeId").cloned(),
    })
}

pub(super) fn permission_body_from_params(params: &Value) -> String {
    params
        .get("message")
        .or_else(|| params.get("description"))
        .or_else(|| params.get("content"))
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("toolCall")
                .and_then(|tool| tool.get("name").or_else(|| tool.get("tool")))
                .and_then(Value::as_str)
        })
        .unwrap_or("ACP agent requested permission to continue.")
        .to_string()
}

pub(super) fn permission_option_id_for_resolution(params: &Value, resolution: &str) -> Option<String> {
    let wanted = match resolution {
        "allow" => "allow",
        "deny" | "reject" => "reject",
        _ => resolution,
    };
    params
        .get("options")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_object)
        .find_map(|option| {
            let kind = option.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind.starts_with(wanted) {
                option
                    .get("optionId")
                    .or_else(|| option.get("option_id"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            } else {
                None
            }
        })
}

/// Best-effort canonicalization for comparing workspace roots: expands a leading
/// `~`, then canonicalizes; falls back to the expanded path if it doesn't exist.
pub(super) fn canonical_path(p: &std::path::Path) -> std::path::PathBuf {
    let expanded = if let Ok(rest) = p.strip_prefix("~") {
        std::env::var_os("HOME")
            .map(|home| std::path::PathBuf::from(home).join(rest))
            .unwrap_or_else(|| p.to_path_buf())
    } else {
        p.to_path_buf()
    };
    std::fs::canonicalize(&expanded).unwrap_or(expanded)
}

pub(super) fn resolve_mcp_server_command() -> String {
    if let Ok(path) = env::var("CHEERS_MCP_SERVER_BIN") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(packages_dir) = manifest_dir.parent() {
        let candidate = packages_dir
            .join("cheers-mcp-server")
            .join("target")
            .join("debug")
            .join(if cfg!(windows) {
                "cheers-mcp-server.exe"
            } else {
                "cheers-mcp-server"
            });
        if candidate.exists() {
            return candidate.display().to_string();
        }
    }
    "cheers-mcp-server".to_string()
}
