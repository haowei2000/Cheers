//! Normalize ACP permission / tool-request payloads for all clients.
//!
//! Connectors forward heterogeneous agent shapes (Codex `_meta` + `command`,
//! Claude `rawInput.file_path` + `title`, OpenCode `locations`, Cursor variants).
//! Web, iOS, Audit, and push all consume gateway APIs — so the canonical
//! human-readable extraction lives here, at persist/serve time, not in each UI.
//!
//! See GitHub #332.

use serde_json::{json, Map, Value};

const GENERIC_TITLES: &[&str] = &[
    "acp permission request",
    "approval needed",
    "permission request",
    "tool permission",
    "the agent requested approval.",
    "acp agent requested permission to continue.",
];

fn is_generic_title(s: &str) -> bool {
    let t = s.trim().to_ascii_lowercase();
    t.is_empty() || GENERIC_TITLES.contains(&t.as_str())
}

fn trim_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn pick_str(obj: Option<&Value>, keys: &[&str]) -> Option<String> {
    let obj = obj?.as_object()?;
    for k in keys {
        if let Some(s) = trim_str(obj.get(*k)) {
            return Some(s.to_string());
        }
    }
    None
}

fn raw_input_of(tool: &Value) -> Option<&Value> {
    tool.get("raw_input")
        .or_else(|| tool.get("rawInput"))
        .filter(|v| !v.is_null())
}

/// Paths from ACP `locations` (string | {path|uri|file_path}).
pub fn location_paths(locations: Option<&Value>) -> Vec<String> {
    let Some(arr) = locations.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for loc in arr {
        if let Some(s) = trim_str(Some(loc)) {
            if !out.iter().any(|p| p == s) {
                out.push(s.to_string());
            }
            continue;
        }
        if let Some(p) = pick_str(Some(loc), &["path", "uri", "file_path", "filePath"]) {
            if !out.iter().any(|x| x == &p) {
                out.push(p);
            }
        }
    }
    out
}

fn paths_from_raw_input(raw: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(p) = pick_str(
        raw,
        &[
            "file_path",
            "filePath",
            "path",
            "target_file",
            "targetFile",
            "filename",
            "file",
        ],
    ) {
        out.push(p);
    }
    out
}

fn command_from_raw_input(raw: Option<&Value>) -> Option<String> {
    if let Some(cmd) = pick_str(raw, &["command", "cmd", "shell_command", "shellCommand"]) {
        return Some(cmd);
    }
    let argv = raw?.get("argv")?.as_array()?;
    if argv.is_empty() || !argv.iter().all(|v| v.is_string()) {
        return None;
    }
    let joined = argv
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    let t = joined.trim();
    (!t.is_empty()).then(|| t.to_string())
}

fn preview_raw_input(raw: Option<&Value>) -> Option<String> {
    if let Some(s) = trim_str(raw) {
        return Some(s.to_string());
    }
    if let Some(cmd) = command_from_raw_input(raw) {
        return Some(cmd);
    }
    let path = paths_from_raw_input(raw).into_iter().next()?;
    let content_len = pick_str(
        raw,
        &[
            "content",
            "new_string",
            "newString",
            "contents",
            "new_content",
        ],
    )
    .map(|c| c.len());
    Some(match content_len {
        Some(n) => format!("{path}  ({n} chars)"),
        None => path,
    })
}

/// Result of normalizing a permission tool blob (+ optional frame title/body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedToolRequest {
    pub summary: String,
    pub display_title: String,
    pub command: Option<String>,
    pub paths: Vec<String>,
    pub kind: Option<String>,
    pub cwd: Option<String>,
    pub tool_title: Option<String>,
}

/// Normalize `tool` (and optional title/body) into a filled tool object plus
/// display title / body suitable for `content_data` and audit `detail`.
///
/// Always returns a tool `Value` (object). Missing input becomes `{}` with
/// summary falling back to body/title generics only when nothing concrete exists.
pub fn normalize_permission_payload(
    title: Option<&str>,
    body: Option<&str>,
    tool: Option<&Value>,
) -> (String, String, Value) {
    let tool_in = tool.filter(|v| v.is_object());
    let raw = tool_in.and_then(raw_input_of);

    let kind = pick_str(tool_in, &["kind"]);
    let cwd = pick_str(tool_in, &["cwd"])
        .or_else(|| pick_str(raw, &["cwd", "working_directory", "workingDirectory"]));
    let tool_title = pick_str(tool_in, &["title"]);
    let tool_name = pick_str(tool_in, &["name", "toolName", "tool_name"]);
    let diff = pick_str(tool_in, &["diff"]);

    let mut paths = location_paths(tool_in.and_then(|t| t.get("locations")));
    for p in paths_from_raw_input(raw) {
        if !paths.iter().any(|x| x == &p) {
            paths.push(p);
        }
    }

    let command = pick_str(tool_in, &["command"]).or_else(|| command_from_raw_input(raw));
    let raw_preview = preview_raw_input(raw);

    // Prefer shell command, then agent-provided title, then path/raw preview.
    let summary = command
        .clone()
        .or_else(|| tool_title.clone().filter(|t| !is_generic_title(t)))
        .or_else(|| tool_name.clone().filter(|t| !is_generic_title(t)))
        .or_else(|| raw_preview.clone())
        .or_else(|| paths.first().cloned())
        .or_else(|| {
            body.map(str::trim)
                .filter(|s| !s.is_empty() && !is_generic_title(s))
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Approval needed".to_string());

    let display_title = tool_title
        .clone()
        .filter(|t| !is_generic_title(t))
        .or_else(|| tool_name.clone().filter(|t| !is_generic_title(t)))
        .or_else(|| {
            title
                .map(str::trim)
                .filter(|s| !s.is_empty() && !is_generic_title(s))
                .map(str::to_string)
        })
        .or_else(|| {
            if summary.len() <= 80 && !is_generic_title(&summary) {
                Some(summary.clone())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "Approval needed".to_string());

    let display_body = body
        .map(str::trim)
        .filter(|s| !s.is_empty() && !is_generic_title(s))
        .map(str::to_string)
        .unwrap_or_else(|| summary.clone());

    // Rebuild tool object: preserve unknown keys, fill canonical fields.
    let mut out: Map<String, Value> = tool_in
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if let Some(c) = &command {
        out.insert("command".into(), json!(c));
    }
    if let Some(c) = &cwd {
        out.insert("cwd".into(), json!(c));
    }
    if let Some(k) = &kind {
        out.insert("kind".into(), json!(k));
    }
    if let Some(t) = tool_title.or(tool_name) {
        out.entry("title".to_string()).or_insert(json!(t));
    }
    if let Some(d) = diff {
        out.insert("diff".into(), json!(d));
    }
    if !paths.is_empty() && out.get("locations").is_none_or(Value::is_null) {
        out.insert(
            "locations".into(),
            json!(paths
                .iter()
                .map(|p| json!({ "path": p }))
                .collect::<Vec<_>>()),
        );
    }
    // Single line every client can render without re-parsing agent quirks.
    out.insert("summary".into(), json!(summary));

    // Keep raw_input under snake_case for clients that already expect it.
    if let Some(r) = raw {
        if !out.contains_key("raw_input") || out.get("raw_input").is_some_and(Value::is_null) {
            out.insert("raw_input".into(), r.clone());
        }
    }

    (display_title, display_body, Value::Object(out))
}

/// Normalize an audit `detail` object in place (`{ title, tool }` → filled).
pub fn normalize_audit_detail(detail: &mut Value) {
    let Some(obj) = detail.as_object_mut() else {
        return;
    };
    let title = obj.get("title").and_then(Value::as_str).map(str::to_string);
    let body = obj.get("body").and_then(Value::as_str).map(str::to_string);
    let tool = obj.get("tool").cloned();
    let (display_title, _body, tool_out) =
        normalize_permission_payload(title.as_deref(), body.as_deref(), tool.as_ref());
    obj.insert("title".into(), json!(display_title));
    obj.insert("tool".into(), tool_out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_meta_command_wins() {
        let tool = json!({
            "kind": "execute",
            "raw_input": { "command": "echo raw", "cwd": "/work" },
            "command": "/bin/zsh -lc 'echo raw'",
            "cwd": "/work"
        });
        let (title, body, out) =
            normalize_permission_payload(Some("ACP permission request"), None, Some(&tool));
        assert_eq!(out["command"], "/bin/zsh -lc 'echo raw'");
        assert_eq!(out["summary"], "/bin/zsh -lc 'echo raw'");
        assert_eq!(out["cwd"], "/work");
        assert_eq!(body, "/bin/zsh -lc 'echo raw'");
        assert_ne!(title.to_ascii_lowercase(), "acp permission request");
    }

    #[test]
    fn claude_file_path_fills_command_gap_and_locations() {
        let tool = json!({
            "title": "Edit `/work/hello.txt`",
            "raw_input": {
                "file_path": "/work/hello.txt",
                "old_string": "a",
                "new_string": "b"
            }
        });
        let (title, body, out) =
            normalize_permission_payload(Some("ACP permission request"), None, Some(&tool));
        assert_eq!(title, "Edit `/work/hello.txt`");
        assert!(out.get("command").is_none_or(Value::is_null));
        assert_eq!(out["summary"], "Edit `/work/hello.txt`");
        assert_eq!(out["locations"][0]["path"], "/work/hello.txt");
        assert_eq!(body, out["summary"]);
    }

    #[test]
    fn locations_alone_produce_summary() {
        let tool = json!({
            "kind": "read",
            "locations": [{ "path": "/repo/src/main.rs" }]
        });
        let (_, _, out) = normalize_permission_payload(None, None, Some(&tool));
        assert_eq!(out["summary"], "/repo/src/main.rs");
    }

    #[test]
    fn argv_becomes_command() {
        let tool = json!({
            "raw_input": { "argv": ["npm", "test"] }
        });
        let (_, _, out) = normalize_permission_payload(None, None, Some(&tool));
        assert_eq!(out["command"], "npm test");
        assert_eq!(out["summary"], "npm test");
    }

    #[test]
    fn generic_connector_title_is_replaced() {
        let tool = json!({ "title": "Run git status", "command": "git status" });
        let (title, _, _) =
            normalize_permission_payload(Some("ACP permission request"), None, Some(&tool));
        assert_eq!(title, "Run git status");
    }

    #[test]
    fn normalize_audit_detail_rewrites_tool() {
        let mut detail = json!({
            "title": "ACP permission request",
            "tool": { "raw_input": { "file_path": "/a.txt" } }
        });
        normalize_audit_detail(&mut detail);
        assert_eq!(detail["tool"]["locations"][0]["path"], "/a.txt");
        assert_eq!(detail["tool"]["summary"], "/a.txt");
        assert_ne!(
            detail["title"].as_str().unwrap().to_ascii_lowercase(),
            "acp permission request"
        );
    }
}
