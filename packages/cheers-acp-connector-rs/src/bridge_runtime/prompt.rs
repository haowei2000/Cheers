use super::*;

pub(super) fn bridge_ready_from_initialize(
    initialize: &Value,
    policy: &LocalPolicy,
) -> BridgeReady {
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
    // Surface what the agent itself can do, not just local policy. Without this
    // the platform can't tell that, e.g., images will be silently degraded to a
    // text summary because the agent never advertised promptCapabilities.image —
    // so it can warn the user / hide image upload instead of failing quietly.
    let agent_caps = agent_capability_summary(initialize);
    let agent_supports_image = agent_caps["prompt_image"].as_bool().unwrap_or(false);
    let agent_supports_audio = agent_caps["prompt_audio"].as_bool().unwrap_or(false);
    ready.connector_capabilities = Some(json!({
        "runtime_protocols": ["acp"],
        "runtime_session_control": policy.sessions.create
            || policy.sessions.load
            || policy.sessions.cancel
            || policy.sessions.terminate,
        "streaming": policy.prompt.allow,
        // `files` / `images` / `audio` reflect BOTH local policy and what the
        // agent can actually accept — the effective capability the platform
        // should rely on (e.g. to warn a user sending voice to a text-only bot).
        "files": policy.file_upload.allow,
        "images": policy.prompt.allow_images && agent_supports_image,
        "audio": policy.prompt.allow_audio && agent_supports_audio,
        "send": policy.send.allow,
        "resource_req": true,
        "permission_request": policy.permission.forward_to_backend,
        "config_options": true,
        "trace": policy.trace.allow,
        "session_update": policy.session_update.allow,
        "agent_capabilities": agent_caps,
    }));
    ready
}

/// Distil the agent's advertised ACP `agentCapabilities` into the compact,
/// snake_cased summary Cheers forwards to the platform. Every field defaults to
/// `false` when absent so a missing/partial capabilities block is treated as
/// "unsupported", never assumed.
pub(super) fn agent_capability_summary(initialize: &Value) -> Value {
    let caps = initialize.get("agentCapabilities");
    let cap_bool = |path: &[&str]| -> bool {
        let mut cursor = caps;
        for key in path {
            cursor = cursor.and_then(|value| value.get(*key));
        }
        cursor.and_then(Value::as_bool).unwrap_or(false)
    };
    json!({
        "load_session": cap_bool(&["loadSession"]),
        "prompt_image": cap_bool(&["promptCapabilities", "image"]),
        "prompt_audio": cap_bool(&["promptCapabilities", "audio"]),
        "mcp_http": cap_bool(&["mcpCapabilities", "http"]),
        "mcp_sse": cap_bool(&["mcpCapabilities", "sse"]),
    })
}

/// Build the ACP prompt content blocks for a task.
///
/// `send_images` / `send_audio` MUST already fold in both the local policy
/// (`allow_images` / `allow_audio`) and the agent's advertised
/// `promptCapabilities.{image,audio}`; when false, that modality degrades to a
/// text summary line rather than being pushed as blocks the agent never said it
/// could read.
pub(super) fn build_prompt(
    task: &TaskCommand,
    policy: &PromptPolicy,
    channel_name: Option<&str>,
    send_images: bool,
    send_audio: bool,
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
    // Image/audio attachments become real ACP content blocks only when the agent
    // advertised the capability; everything else (and media we can't send) is
    // summarized as text so the agent still knows the file exists. An audio
    // attachment whose transcript already rode in via `summary` never carries
    // `audio_b64` (the platform sends transcript-first), so it naturally falls
    // through to the summary line here.
    let mut media_blocks: Vec<Value> = Vec::new();
    if policy.allow_attachments && !task.attachments.is_empty() {
        let mut lines = vec!["Cheers attachments:".to_string()];
        for attachment in &task.attachments {
            if send_images {
                if let Some(block) = image_content_block(attachment) {
                    media_blocks.push(block);
                    continue;
                }
            }
            if send_audio {
                if let Some(block) = audio_content_block(attachment) {
                    media_blocks.push(block);
                    continue;
                }
            }
            lines.push(attachment_summary_line(attachment));
        }
        // Only emit the attachments text section if any attachment fell through
        // to a summary line (the header alone is noise otherwise).
        if lines.len() > 1 {
            parts.push(lines.join("\n"));
        }
    }
    let mut blocks = vec![json!({
        "type": "text",
        "text": parts.join("\n\n")
    })];
    blocks.append(&mut media_blocks);
    blocks
}

pub(super) const CHEERS_ACP_OUTPUT_CONTRACT: &str = "You are replying inside Cheers. Stream useful answer text through the ACP session; generated files should be returned as explicit file/resource updates when the runtime supports them.";

/// Map an ACP `StopReason` to a bridge trace status so a remote observer can
/// tell a clean finish from a refusal / truncation / turn-cap. ACP defines
/// exactly five reasons; the old code collapsed every non-`cancelled` reason to
/// "completed", hiding refusals and truncations from the channel.
/// <https://agentclientprotocol.com/protocol/v1/prompt-turn>
pub(super) fn stop_reason_to_status(stop_reason: Option<&str>) -> &'static str {
    match stop_reason {
        Some("cancelled") => "cancelled",
        Some("refusal") => "refused",
        Some("max_tokens") => "truncated",
        Some("max_turn_requests") => "max_turn_requests",
        // `end_turn` is the only clean finish; an unknown/absent reason is
        // treated as completion too (forward-compatible default).
        _ => "completed",
    }
}

/// Determine an MCP server entry's transport. ACP stdio servers are
/// command-based and are the baseline transport every agent supports; `http`
/// and `sse` entries carry a `type` discriminator and require the matching
/// `agentCapabilities.mcpCapabilities`.
/// <https://agentclientprotocol.com/protocol/v1/schema>
pub(super) fn mcp_server_transport(server: &Value) -> &'static str {
    match server.get("type").and_then(Value::as_str) {
        Some("http") => "http",
        Some("sse") => "sse",
        _ => "stdio",
    }
}

/// Whether the agent can speak the transport a configured MCP server needs.
/// stdio is the ACP baseline (always supported); `http`/`sse` require the
/// matching `agentCapabilities.mcpCapabilities`. Injecting a server the agent
/// can't reach would make its tools silently unavailable.
pub(super) fn mcp_server_supported(
    server: &Value,
    supports_http: bool,
    supports_sse: bool,
) -> bool {
    match mcp_server_transport(server) {
        "http" => supports_http,
        "sse" => supports_sse,
        _ => true, // stdio baseline
    }
}

/// Build an ACP image content block from an attachment, or `None` when it can't
/// be sent as one. ACP image blocks are `{ type: "image", mimeType, data }` with
/// base64 `data`. <https://agentclientprotocol.com/protocol/v1/schema>
///
/// Two signals must agree: there must be inline base64 `data`, AND the platform
/// must not have explicitly flagged the attachment as a non-image
/// (`is_image == false`). We honour the platform's flag rather than guessing
/// from raw bytes — a PDF, say, carries `is_image: false` and must degrade to a
/// text summary even on the off chance a base64 blob is attached.
pub(super) fn image_content_block(attachment: &AttachmentInfo) -> Option<Value> {
    if attachment.is_image.as_ref().and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let data = attachment.image_b64.as_ref()?;
    if data.trim().is_empty() {
        return None;
    }
    let mime = attachment
        .content_type
        .as_deref()
        .filter(|ct| ct.starts_with("image/"))
        .unwrap_or("image/png");
    Some(json!({
        "type": "image",
        "mimeType": mime,
        "data": data,
    }))
}

/// Build an ACP audio content block from an attachment, or `None` when it can't
/// be sent as one. ACP audio blocks are `{ type: "audio", mimeType, data }` with
/// base64 `data`, gated on `promptCapabilities.audio`.
/// <https://agentclientprotocol.com/protocol/v1/content>
///
/// Mirrors [`image_content_block`]: inline base64 must be present, and the
/// platform must not have flagged the attachment as non-audio. The mimeType is
/// passed through when it is an `audio/*` type (the spec names wav/mp3 as
/// examples but does not restrict the set); otherwise default to `audio/wav`.
pub(super) fn audio_content_block(attachment: &AttachmentInfo) -> Option<Value> {
    if attachment.is_audio.as_ref().and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let data = attachment.audio_b64.as_ref()?;
    if data.trim().is_empty() {
        return None;
    }
    let mime = attachment
        .content_type
        .as_deref()
        .filter(|ct| ct.starts_with("audio/"))
        .unwrap_or("audio/wav");
    Some(json!({
        "type": "audio",
        "mimeType": mime,
        "data": data,
    }))
}

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

/// A UI-facing trace derived from a `session/update`: a human `title`, a
/// machine `status`, and optional structured `data` for richer remote rendering
/// (currently the agent plan's to-do entries).
pub(super) struct SessionUpdateTrace {
    pub title: String,
    pub status: String,
    pub data: Option<Value>,
}

/// Structure an ACP `session/update` into a UI-facing trace, using the update's
/// OWN fields. Returns `None` for non-progress updates (`usage_update`,
/// mode/config) so they are not surfaced as agent activity.
///
/// Grounded in the real ACP schema (verified against claude-agent-acp output):
/// `tool_call` / `tool_call_update` carry `{ title, kind, status, toolCallId,
/// content, rawInput, rawOutput }`. The `title` is the agent's own human label
/// (e.g. the shell command); status-only updates have none, so we skip them and
/// let the titled call/update be the informative trace.
pub(super) fn describe_session_update(kind: &str, update: &Value) -> Option<SessionUpdateTrace> {
    let status = update
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("running")
        .to_string();
    match kind {
        "tool_call" | "tool_call_update" => {
            update
                .get("title")
                .and_then(Value::as_str)
                .map(|title| SessionUpdateTrace {
                    title: title.to_string(),
                    status,
                    data: None,
                })
        }
        "agent_thought_chunk" => Some(SessionUpdateTrace {
            title: "Thinking…".to_string(),
            status: "running".to_string(),
            data: None,
        }),
        "plan" => Some(describe_plan(update)),
        _ => None,
    }
}

/// Build a trace for an ACP `plan` update. The agent's live to-do list
/// (`entries: [{ content, priority, status }]`) is the single most useful thing
/// to surface to a remote channel — it lets the people watching see what the
/// agent intends to do. The old code dropped `entries` entirely and showed only
/// "Planning…"; here we forward the entries verbatim as trace `data`
/// (`kind="plan"`) and summarize progress in the title.
/// <https://agentclientprotocol.com/protocol/v1/agent-plan>
fn describe_plan(update: &Value) -> SessionUpdateTrace {
    let entries = update
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = entries.len();
    let completed = entries
        .iter()
        .filter(|entry| entry.get("status").and_then(Value::as_str) == Some("completed"))
        .count();
    let title = if total == 0 {
        "Planning…".to_string()
    } else {
        format!("Plan · {completed}/{total} done")
    };
    SessionUpdateTrace {
        title,
        status: "running".to_string(),
        data: Some(json!({
            "kind": "plan",
            "entries": entries,
        })),
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

/// Locate codex's `_meta.codex.params` blob, which carries the richest, most
/// human-friendly view of a `session/request_permission` (a natural-language
/// `reason`, the normalized `command`, `cwd`, decisions). Codex-specific and
/// guarded: returns None for agents that don't populate it.
fn codex_request_params(params: &Value) -> Option<&Value> {
    params
        .get("_meta")
        .and_then(|m| m.get("codex"))
        .and_then(|c| c.get("params"))
}

pub(super) fn permission_body_from_params(params: &Value) -> String {
    let codex = codex_request_params(params);
    // Prefer codex's explicit human-readable reason (e.g. "Do you want to allow
    // writing X to /tmp/y?") over the generic fallback — this is the single most
    // useful line for a human approver.
    if let Some(reason) = codex
        .and_then(|p| p.get("reason"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        return reason.to_string();
    }
    // codex without a reason still hands us the normalized command — show that
    // instead of the generic line so the approver sees *something* concrete. The
    // card also renders the command in its own block, so the frontend dedupes
    // when body == tool.command (impact line is hidden).
    if let Some(command) = codex
        .and_then(|p| p.get("command"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        return command.to_string();
    }
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

/// Extract a compact, structured tool descriptor from an ACP
/// `session/request_permission` params object so the channel approval card can
/// show WHAT is being approved (command / path / diff) and a risk badge.
/// Returns None when there is no `toolCall` (e.g. a plain message permission).
pub(super) fn permission_tool_from_params(params: &Value) -> Option<Value> {
    let tool = params.get("toolCall").or_else(|| params.get("tool"))?;
    if !tool.is_object() {
        return None;
    }
    let title = tool
        .get("title")
        .or_else(|| tool.get("name"))
        .and_then(Value::as_str);
    let kind = tool.get("kind").and_then(Value::as_str);
    // rawInput carries the actual command / file path / content the agent wants
    // to run — the single most useful thing for a human approver to see.
    let raw_input = tool.get("rawInput").or_else(|| tool.get("raw_input"));
    let locations = tool.get("locations");
    let status = tool.get("status").and_then(Value::as_str);
    let tool_call_id = tool
        .get("toolCallId")
        .or_else(|| tool.get("tool_call_id"))
        .and_then(Value::as_str);
    // codex's normalized full command (e.g. "/bin/zsh -lc '…'") and cwd live in
    // _meta; fall back to rawInput for the cwd when _meta is absent.
    let codex = codex_request_params(params);
    let command = codex.and_then(|p| p.get("command")).and_then(Value::as_str);
    let cwd = codex
        .and_then(|p| p.get("cwd"))
        .and_then(Value::as_str)
        .or_else(|| raw_input.and_then(|r| r.get("cwd")).and_then(Value::as_str));
    Some(serde_json::json!({
        "title": title,
        "kind": kind,
        "raw_input": raw_input,
        "locations": locations,
        "status": status,
        "tool_call_id": tool_call_id,
        "command": command,
        "cwd": cwd,
    }))
}

pub(super) fn permission_option_id_for_resolution(
    params: &Value,
    resolution: &str,
) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn options() -> Value {
        json!({
            "options": [
                {"optionId": "a1", "kind": "allow_once",    "name": "Allow"},
                {"optionId": "a2", "kind": "allow_always",  "name": "Allow always"},
                {"optionId": "r1", "kind": "reject_once",   "name": "Reject"},
                {"optionId": "r2", "kind": "reject_always", "name": "Reject always"},
            ]
        })
    }

    #[test]
    fn allow_resolves_to_first_allow_kind() {
        // "allow" matches the first option whose kind starts with "allow".
        assert_eq!(
            permission_option_id_for_resolution(&options(), "allow"),
            Some("a1".to_string())
        );
    }

    #[test]
    fn reject_resolves_to_reject_kind_not_cancelled() {
        // Regression: a rejection must map to the reject-kind optionId (ACP
        // `selected`), never silently collapse to `cancelled`.
        assert_eq!(
            permission_option_id_for_resolution(&options(), "reject"),
            Some("r1".to_string())
        );
        // "deny" is accepted as an alias for "reject".
        assert_eq!(
            permission_option_id_for_resolution(&options(), "deny"),
            Some("r1".to_string())
        );
    }

    #[test]
    fn unknown_resolution_yields_none() {
        assert_eq!(
            permission_option_id_for_resolution(&options(), "maybe"),
            None
        );
    }

    #[test]
    fn body_prefers_codex_reason_over_generic_fallback() {
        let params = json!({
            "sessionId": "s1",
            "toolCall": { "kind": "execute" },
            "_meta": { "codex": { "params": {
                "reason": "Do you want to allow writing X to /tmp/y?",
                "command": "/bin/zsh -lc 'echo X > /tmp/y'",
                "cwd": "/work"
            }}}
        });
        assert_eq!(
            permission_body_from_params(&params),
            "Do you want to allow writing X to /tmp/y?"
        );
        // codex with a command but no reason: fall back to the command itself
        // (more concrete than the generic line; deduped against tool.command).
        let no_reason = json!({
            "toolCall": { "kind": "execute" },
            "_meta": { "codex": { "params": {
                "command": "/bin/zsh -lc 'echo X > /tmp/y'",
                "cwd": "/work"
            }}}
        });
        assert_eq!(
            permission_body_from_params(&no_reason),
            "/bin/zsh -lc 'echo X > /tmp/y'"
        );
        // Without _meta the generic fallback still applies.
        assert_eq!(
            permission_body_from_params(&json!({"toolCall": {"kind": "execute"}})),
            "ACP agent requested permission to continue."
        );
    }

    #[test]
    fn tool_carries_codex_command_status_and_cwd() {
        let params = json!({
            "toolCall": {
                "kind": "execute",
                "status": "pending",
                "toolCallId": "call_1",
                "rawInput": { "command": "echo X > /tmp/y", "cwd": "/work" }
            },
            "_meta": { "codex": { "params": {
                "command": "/bin/zsh -lc 'echo X > /tmp/y'",
                "cwd": "/work"
            }}}
        });
        let tool = permission_tool_from_params(&params).expect("tool");
        assert_eq!(tool["status"], "pending");
        assert_eq!(tool["tool_call_id"], "call_1");
        assert_eq!(tool["command"], "/bin/zsh -lc 'echo X > /tmp/y'");
        assert_eq!(tool["cwd"], "/work");
        assert_eq!(tool["kind"], "execute");
    }

    #[test]
    fn stop_reason_splits_all_five_acp_reasons() {
        // Regression: refusal / max_tokens / max_turn_requests must NOT collapse
        // to "completed" — a remote observer has to tell them apart.
        assert_eq!(stop_reason_to_status(Some("end_turn")), "completed");
        assert_eq!(stop_reason_to_status(Some("cancelled")), "cancelled");
        assert_eq!(stop_reason_to_status(Some("refusal")), "refused");
        assert_eq!(stop_reason_to_status(Some("max_tokens")), "truncated");
        assert_eq!(
            stop_reason_to_status(Some("max_turn_requests")),
            "max_turn_requests"
        );
        // Unknown / absent reasons default to a clean completion.
        assert_eq!(stop_reason_to_status(Some("future_reason")), "completed");
        assert_eq!(stop_reason_to_status(None), "completed");
    }

    #[test]
    fn mcp_transport_detects_http_sse_and_defaults_to_stdio() {
        assert_eq!(
            mcp_server_transport(&json!({"name": "x", "command": "y"})),
            "stdio"
        );
        assert_eq!(
            mcp_server_transport(&json!({"type": "http", "name": "x", "url": "u"})),
            "http"
        );
        assert_eq!(
            mcp_server_transport(&json!({"type": "sse", "name": "x", "url": "u"})),
            "sse"
        );
    }

    #[test]
    fn agent_capability_summary_reads_nested_caps_and_defaults_false() {
        let summary = agent_capability_summary(&json!({
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true },
                "mcpCapabilities": { "http": true, "sse": false }
            }
        }));
        assert_eq!(summary["load_session"], true);
        assert_eq!(summary["prompt_image"], true);
        assert_eq!(summary["mcp_http"], true);
        assert_eq!(summary["mcp_sse"], false);

        // Absent agentCapabilities → every field defaults to false (never assumed).
        let empty = agent_capability_summary(&json!({}));
        assert_eq!(empty["load_session"], false);
        assert_eq!(empty["prompt_image"], false);
        assert_eq!(empty["mcp_http"], false);
        assert_eq!(empty["mcp_sse"], false);
    }

    #[test]
    fn mcp_server_supported_gates_http_sse_but_never_stdio() {
        let stdio = json!({"name": "cheers", "command": "bin"});
        let http = json!({"type": "http", "name": "h", "url": "u"});
        let sse = json!({"type": "sse", "name": "s", "url": "u"});
        // stdio (incl. the injected cheers server) is the ACP baseline: always kept.
        assert!(mcp_server_supported(&stdio, false, false));
        // http/sse are kept only when the agent advertised the transport.
        assert!(!mcp_server_supported(&http, false, false));
        assert!(mcp_server_supported(&http, true, false));
        assert!(!mcp_server_supported(&sse, false, false));
        assert!(mcp_server_supported(&sse, false, true));
    }

    #[test]
    fn plan_update_forwards_entries_and_summarizes_progress() {
        let update = json!({
            "sessionUpdate": "plan",
            "entries": [
                {"content": "scope the work", "priority": "high",   "status": "completed"},
                {"content": "write the fix",  "priority": "medium", "status": "in_progress"},
                {"content": "add tests",      "priority": "low",    "status": "pending"},
            ]
        });
        let trace = describe_session_update("plan", &update).expect("plan trace");
        assert_eq!(trace.title, "Plan · 1/3 done");
        assert_eq!(trace.status, "running");
        let data = trace.data.expect("plan data forwarded");
        assert_eq!(data["kind"], "plan");
        assert_eq!(data["entries"].as_array().unwrap().len(), 3);
        // Entries are forwarded verbatim so the remote can render a to-do panel.
        assert_eq!(data["entries"][1]["content"], "write the fix");
        assert_eq!(data["entries"][1]["status"], "in_progress");
    }

    #[test]
    fn empty_plan_falls_back_to_planning_label() {
        let trace = describe_session_update("plan", &json!({"entries": []})).expect("trace");
        assert_eq!(trace.title, "Planning…");
        assert_eq!(
            trace.data.expect("data")["entries"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn image_block_built_only_when_inline_data_present() {
        let with_data = AttachmentInfo {
            file_id: Some("f1".to_string()),
            filename: Some("shot.png".to_string()),
            content_type: Some("image/png".to_string()),
            size_bytes: Some(10),
            summary: None,
            is_image: Some(json!(true)),
            image_b64: Some("aGVsbG8=".to_string()),
            is_audio: None,
            audio_b64: None,
            extra: serde_json::Map::new(),
        };
        let block = image_content_block(&with_data).expect("image block");
        assert_eq!(block["type"], "image");
        assert_eq!(block["mimeType"], "image/png");
        assert_eq!(block["data"], "aGVsbG8=");

        // No inline base64 → cannot send an image block.
        let no_data = AttachmentInfo {
            image_b64: None,
            ..with_data.clone()
        };
        assert!(image_content_block(&no_data).is_none());

        // Platform explicitly flagged it as a non-image → degrade even if a
        // base64 blob is somehow attached (honour the platform's signal).
        let not_image = AttachmentInfo {
            is_image: Some(json!(false)),
            ..with_data.clone()
        };
        assert!(image_content_block(&not_image).is_none());

        // Non-image content type still defaults the mime to image/png when b64
        // is present (the b64 is the authoritative signal it's an image).
        let odd_mime = AttachmentInfo {
            content_type: Some("application/octet-stream".to_string()),
            ..with_data
        };
        assert_eq!(
            image_content_block(&odd_mime).expect("block")["mimeType"],
            "image/png"
        );
    }

    #[test]
    fn audio_block_built_only_when_inline_data_present() {
        let with_data = AttachmentInfo {
            file_id: Some("a1".to_string()),
            filename: Some("note.webm".to_string()),
            content_type: Some("audio/webm".to_string()),
            size_bytes: Some(10),
            summary: None,
            is_image: None,
            image_b64: None,
            is_audio: Some(json!(true)),
            audio_b64: Some("aGVsbG8=".to_string()),
            extra: serde_json::Map::new(),
        };
        let block = audio_content_block(&with_data).expect("audio block");
        assert_eq!(block["type"], "audio");
        assert_eq!(block["mimeType"], "audio/webm");
        assert_eq!(block["data"], "aGVsbG8=");

        // No inline base64 → no audio block (e.g. transcript-first delivery
        // already turned this attachment into a summary line upstream).
        let no_data = AttachmentInfo {
            audio_b64: None,
            ..with_data.clone()
        };
        assert!(audio_content_block(&no_data).is_none());

        // Platform flagged non-audio → degrade even with a stray blob.
        let not_audio = AttachmentInfo {
            is_audio: Some(json!(false)),
            ..with_data.clone()
        };
        assert!(audio_content_block(&not_audio).is_none());

        // Non-audio content type falls back to the audio/wav default.
        let odd_mime = AttachmentInfo {
            content_type: Some("application/octet-stream".to_string()),
            ..with_data
        };
        assert_eq!(
            audio_content_block(&odd_mime).expect("block")["mimeType"],
            "audio/wav"
        );
    }
}
