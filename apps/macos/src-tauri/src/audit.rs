//! A4 — read-only "audit timeline": parse a connector instance's stdout log (the
//! tracing output the daemon already writes) into a chronological list of
//! agent-level events. This NEVER touches the control plane — it only reads the
//! log file (path from the instance's daemon.json) and derives a display view.
//! Permission DECISIONS still happen on the gateway; here we only show that one
//! occurred and its recorded outcome.
//!
//! Log grammar (tracing fmt, ANSI on, target off). After ANSI stripping:
//!   "<rfc3339>Z  <LEVEL> <message> key=value key=value"
//! Simple fields are space-delimited `key=value`; `raw=<json>` and `outcome=<dbg>`
//! are the LAST field and run to end-of-line (their values contain spaces).
//!
//! Output shape matches the γ1↔γ2 shared contract — each event exposes
//! `ts` / `kind` / `detail` — with `extra`/`level`/`account` as additive fields
//! a richer consumer can use and a `{ts,kind,detail}` consumer safely ignores.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

/// Cap the tail we parse so a multi-MB rotated log can't stall the UI.
const MAX_READ_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditKind {
    Lifecycle,
    Prompt,
    Command,
    FileWrite,
    ToolCall,
    PermissionRequest,
    PermissionDecision,
    ResourceRequest,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuditEvent {
    pub ts: String,
    /// Serializes to a snake_case string ("lifecycle", "command", …), so a
    /// `kind: string` consumer reads it directly.
    pub kind: AuditKind,
    /// Human-readable description (the shared contract's `detail`).
    pub detail: String,
    /// Expandable payload (command text / file diff / decision outcome), when any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// Strip ANSI SGR escapes (\x1b[ … <letter>) from a line.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for e in chars.by_ref() {
                    if e.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Value of ` key=` up to the next space (simple fields, no spaces).
fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{key}=");
    let mut idx = 0;
    while let Some(pos) = line[idx..].find(&needle) {
        let at = idx + pos;
        if at == 0 || line.as_bytes()[at - 1] == b' ' {
            let start = at + needle.len();
            let val = &line[start..];
            let end = val.find(' ').unwrap_or(val.len());
            return Some(&val[..end]);
        }
        idx = at + needle.len();
    }
    None
}

/// Value of ` key=` to end-of-line (for `raw=`/`outcome=`, which hold spaces).
fn field_rest<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{key}=");
    let mut idx = 0;
    while let Some(pos) = line[idx..].find(&needle) {
        let at = idx + pos;
        if at == 0 || line.as_bytes()[at - 1] == b' ' {
            return Some(&line[at + needle.len()..]);
        }
        idx = at + needle.len();
    }
    None
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(160).collect()
}

/// Legacy `RAW_ACP_SESSION_UPDATE raw={…}` and current debug
/// `ACP session/update` payloads: pull tool name / command / file path / diff.
fn classify_session_update(raw: &str) -> Option<(AuditKind, String, Option<String>)> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let su = v.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
    if su != "tool_call" && su != "tool_call_update" {
        return None;
    }
    let tool = v
        .pointer("/_meta/claudeCode/toolName")
        .and_then(Value::as_str)
        .or_else(|| v.get("title").and_then(Value::as_str))
        .unwrap_or("tool");
    let input = v.get("rawInput");
    if let Some(cmd) = input.and_then(|i| i.get("command")).and_then(Value::as_str) {
        return Some((
            AuditKind::Command,
            format!("$ {}", first_line(cmd)),
            Some(cmd.to_string()),
        ));
    }
    let path = input
        .and_then(|i| i.get("file_path"))
        .and_then(Value::as_str)
        .or_else(|| v.pointer("/locations/0/path").and_then(Value::as_str));
    if let Some(p) = path {
        let diff = v
            .get("content")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find_map(|c| c.get("newText").and_then(Value::as_str)));
        return Some((AuditKind::FileWrite, format!("{tool} {p}"), diff.map(str::to_string)));
    }
    // Bare status delta with no new payload → skip (avoids per-toolCallId dupes).
    if su == "tool_call_update" && v.get("status").is_some() && input.is_none() {
        return None;
    }
    Some((AuditKind::ToolCall, tool.to_string(), None))
}

/// Debug `session/request_permission raw params raw={…}`: the ACP params.
fn classify_permission_params(raw: &str) -> (AuditKind, String, Option<String>) {
    let detail: String = raw.chars().take(600).collect();
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        let title = v
            .pointer("/toolCall/title")
            .and_then(Value::as_str)
            .or_else(|| v.get("title").and_then(Value::as_str));
        if let Some(t) = title {
            return (
                AuditKind::PermissionRequest,
                format!("Permission asked: {t}"),
                Some(detail),
            );
        }
    }
    (
        AuditKind::PermissionRequest,
        "Permission asked (raw params)".into(),
        Some(detail),
    )
}

fn classify(line: &str, msg: &str, level: &str) -> Option<(AuditKind, String, Option<String>)> {
    if msg.starts_with("RAW_ACP_SESSION_UPDATE") {
        return field_rest(line, "raw").and_then(classify_session_update);
    }
    if msg.starts_with("session/request_permission raw params") {
        return field_rest(line, "raw").map(classify_permission_params);
    }
    if msg.starts_with("validated connector config") {
        return Some((
            AuditKind::Lifecycle,
            "Connector config validated".into(),
            field(line, "state_path").map(|s| format!("state: {s}")),
        ));
    }
    if msg.starts_with("initialized ACP agent") {
        let agent = field(line, "agent").unwrap_or("agent");
        return Some((AuditKind::Lifecycle, format!("Initialized ACP agent ({agent})"), None));
    }
    if msg.starts_with("Rust BridgeRuntime started") {
        return Some((AuditKind::Lifecycle, "Bridge runtime started".into(), None));
    }
    if msg.starts_with("ACP client\u{2192}peer request") {
        let method = field(line, "method").unwrap_or("").trim_matches('"');
        if method == "session/prompt" {
            let id = field(line, "id").unwrap_or("?");
            return Some((AuditKind::Prompt, format!("Prompt dispatched (turn #{id})"), None));
        }
        return None;
    }
    if msg.starts_with("ACP session/update") {
        let kind = field(line, "kind").unwrap_or("").trim_matches('"');
        return match kind {
            "tool_call" => Some((
                AuditKind::ToolCall,
                "Tool call (run with RUST_LOG=debug for command/file detail)".into(),
                None,
            )),
            _ => None,
        };
    }
    if msg.starts_with("forwarding session/request_permission") {
        return Some((
            AuditKind::PermissionRequest,
            "Agent requested permission".into(),
            field(line, "session").map(|s| format!("session: {s}")),
        ));
    }
    if msg.starts_with("forwarding ACP permission request to Backend") {
        let opts = field(line, "option_count").unwrap_or("?");
        let has_tool = field(line, "has_tool").unwrap_or("?");
        return Some((
            AuditKind::PermissionRequest,
            "Permission request sent to gateway".into(),
            Some(format!("options: {opts}, has_tool: {has_tool}")),
        ));
    }
    if msg.starts_with("Backend resolved ACP permission request") {
        let outcome = field_rest(line, "outcome").unwrap_or("").trim();
        return Some((
            AuditKind::PermissionDecision,
            "Gateway resolved permission".into(),
            Some(outcome.to_string()),
        ));
    }
    if msg.starts_with("LB resource_req") {
        let res = field(line, "resource").unwrap_or("");
        return Some((AuditKind::ResourceRequest, format!("Resource request: {res}"), None));
    }
    if level == "ERROR" {
        return Some((AuditKind::Error, msg.chars().take(200).collect(), None));
    }
    if msg.starts_with("[acp stderr]") && (level == "WARN" || msg.to_lowercase().contains("error")) {
        return Some((AuditKind::Error, msg.chars().take(200).collect(), None));
    }
    None
}

pub fn parse_audit_log(raw: &str) -> Vec<AuditEvent> {
    let mut events = Vec::new();
    for line in raw.lines() {
        let line = strip_ansi(line);
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let trimmed = line.trim_start();
        let Some((ts, after)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };
        // Header lines only (else it's a continuation/non-tracing line).
        if ts.len() < 20 || !ts.ends_with('Z') || !ts.as_bytes()[0].is_ascii_digit() {
            continue;
        }
        let after = after.trim_start();
        let Some((level, msg)) = after.split_once(char::is_whitespace) else {
            continue;
        };
        let msg = msg.trim_start();
        if let Some((kind, detail, extra)) = classify(line, msg, level) {
            events.push(AuditEvent {
                ts: ts.to_string(),
                level: level.to_string(),
                kind,
                detail,
                extra,
                account: field(line, "account").map(String::from),
            });
        }
    }
    events
}

fn read_tail(path: &PathBuf, max_bytes: u64) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        if let Some(nl) = s.find('\n') {
            s = s[nl + 1..].to_string();
        }
    }
    Ok(s)
}

/// Read-only: parse the instance's stdout tracing log into a chronological
/// timeline. Bounded to the last ~1MB; `lines` keeps the newest N events.
/// The log path comes from the instance's daemon.json (connector-owned, same
/// trust model as `connector_logs`) — never from webview input.
#[tauri::command]
pub fn connector_audit_timeline(name: String, lines: Option<u32>) -> Result<Vec<AuditEvent>, String> {
    let path = crate::connector::stdout_log_path_for(&name)
        .ok_or("no log recorded for this connector (never started?)")?;
    if !path.is_file() {
        return Err("log file not found on disk yet".into());
    }
    let raw = read_tail(&path, MAX_READ_BYTES).map_err(|e| e.to_string())?;
    let mut events = parse_audit_log(&raw);
    if let Some(n) = lines.map(|n| n as usize) {
        if events.len() > n {
            events = events.split_off(events.len() - n);
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real line copied from ~/.cheers/logs/demo.stdout.log (ANSI included).
    const LIFECYCLE: &str = "\u{1b}[2m2026-06-22T02:42:01.113946Z\u{1b}[0m \u{1b}[32m INFO\u{1b}[0m validated connector config \u{1b}[3maccounts\u{1b}[0m\u{1b}[2m=\u{1b}[0m1 \u{1b}[3mstate_path\u{1b}[0m\u{1b}[2m=\u{1b}[0m/Users/haowei/.cheers/demo-state.json";

    #[test]
    fn strips_ansi_and_parses_lifecycle() {
        let ev = parse_audit_log(LIFECYCLE);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].kind, AuditKind::Lifecycle);
        assert_eq!(ev[0].level, "INFO");
        assert!(ev[0].ts.starts_with("2026-06-22T02:42:01"));
    }

    #[test]
    fn parses_bash_command_from_raw_json() {
        let raw = r#"{"_meta":{"claudeCode":{"toolName":"Bash"}},"rawInput":{"command":"ls -la /tmp"},"sessionUpdate":"tool_call_update"}"#;
        let line = format!("2026-06-23T02:17:15.309844Z  WARN RAW_ACP_SESSION_UPDATE raw={raw}");
        let ev = parse_audit_log(&line);
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].kind, AuditKind::Command);
        assert_eq!(ev[0].extra.as_deref(), Some("ls -la /tmp"));
    }

    #[test]
    fn parses_file_write_from_raw_json() {
        let raw = r#"{"_meta":{"claudeCode":{"toolName":"Write"}},"rawInput":{"file_path":"/x/ping.txt","content":"pong"},"sessionUpdate":"tool_call_update"}"#;
        let line = format!("2026-06-23T02:17:10.836143Z  WARN RAW_ACP_SESSION_UPDATE raw={raw}");
        let ev = parse_audit_log(&line);
        assert_eq!(ev[0].kind, AuditKind::FileWrite);
        assert!(ev[0].detail.contains("/x/ping.txt"));
    }

    #[test]
    fn parses_permission_decision_outcome_to_eol() {
        let line = "2026-06-23T02:17:10.000000Z  INFO Backend resolved ACP permission request account=demo request_id=abc outcome=Selected { option_id: \"allow\" }";
        let ev = parse_audit_log(line);
        assert_eq!(ev[0].kind, AuditKind::PermissionDecision);
        assert_eq!(ev[0].extra.as_deref(), Some("Selected { option_id: \"allow\" }"));
        assert_eq!(ev[0].account.as_deref(), Some("demo"));
    }

    #[test]
    fn skips_noise_message_chunks() {
        let line = "2026-06-23T02:17:17.166283Z DEBUG ACP session/update (…) account=demo session=s kind=\"agent_message_chunk\"";
        assert!(parse_audit_log(line).is_empty());
    }
}
