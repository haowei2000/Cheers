//! Stable, UI-facing classification for heterogeneous ACP tool-call payloads.
//!
//! Producers should eventually send `data.presentation` themselves. Until they
//! do, the gateway derives the same additive shape for live frames and durable
//! replay. Explicit structured fields win; conservative regular expressions are
//! only the compatibility fallback.

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

pub const PRESENTATION_SCHEMA_VERSION: u8 = 2;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolFamily {
    File,
    Shell,
    Web,
    Search,
    Git,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRisk {
    Read,
    Write,
    NetworkRead,
    NetworkWrite,
}

/// Server-authoritative event type. Clients switch on this value directly and
/// never combine family, operation, title, or raw command text to choose a UI.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolEventType {
    FileRead,
    FileEdit,
    FileWrite,
    FileDelete,
    FileMove,
    FileAccess,
    ShellCommand,
    WebSearch,
    WebFetch,
    SearchResults,
    GitStatus,
    GitDiff,
    GitShow,
    GitLog,
    GitCommit,
    GitRemote,
    GitCommand,
}

impl ToolEventType {
    fn wire_name(self) -> &'static str {
        match self {
            Self::FileRead => "file_read",
            Self::FileEdit => "file_edit",
            Self::FileWrite => "file_write",
            Self::FileDelete => "file_delete",
            Self::FileMove => "file_move",
            Self::FileAccess => "file_access",
            Self::ShellCommand => "shell_command",
            Self::WebSearch => "web_search",
            Self::WebFetch => "web_fetch",
            Self::SearchResults => "search_results",
            Self::GitStatus => "git_status",
            Self::GitDiff => "git_diff",
            Self::GitShow => "git_show",
            Self::GitLog => "git_log",
            Self::GitCommit => "git_commit",
            Self::GitRemote => "git_remote",
            Self::GitCommand => "git_command",
        }
    }

    fn from_wire_name(value: &str) -> Option<Self> {
        Some(match value {
            "file_read" => Self::FileRead,
            "file_edit" => Self::FileEdit,
            "file_write" => Self::FileWrite,
            "file_delete" => Self::FileDelete,
            "file_move" => Self::FileMove,
            "file_access" => Self::FileAccess,
            "shell_command" => Self::ShellCommand,
            "web_search" => Self::WebSearch,
            "web_fetch" => Self::WebFetch,
            "search_results" => Self::SearchResults,
            "git_status" => Self::GitStatus,
            "git_diff" => Self::GitDiff,
            "git_show" => Self::GitShow,
            "git_log" => Self::GitLog,
            "git_commit" => Self::GitCommit,
            "git_remote" => Self::GitRemote,
            "git_command" => Self::GitCommand,
            _ => return None,
        })
    }
}

/// One versioned, cross-client display contract. The raw ACP payload remains
/// authoritative for execution and authorization; this type is display-only.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ToolPresentation {
    pub v: u8,
    pub event_type: ToolEventType,
    pub family: ToolFamily,
    pub operation: String,
    pub confidence: String,
    pub matched_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<ToolRisk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compound: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

impl ToolPresentation {
    fn new(
        family: ToolFamily,
        operation: impl Into<String>,
        event_type: ToolEventType,
        confidence: &str,
        matched_by: &str,
    ) -> Self {
        Self {
            v: PRESENTATION_SCHEMA_VERSION,
            event_type,
            family,
            operation: operation.into(),
            confidence: confidence.to_string(),
            matched_by: matched_by.to_string(),
            target: None,
            path: None,
            command: None,
            query: None,
            cwd: None,
            args: None,
            risk: None,
            compound: None,
            result: None,
        }
    }
}

fn non_empty_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn input(data: &Value) -> &Value {
    data.get("input")
        .or_else(|| data.get("raw_input"))
        .or_else(|| data.get("rawInput"))
        .or_else(|| data.get("tool").and_then(|tool| tool.get("input")))
        .or_else(|| data.get("tool").and_then(|tool| tool.get("raw_input")))
        .or_else(|| data.get("tool").and_then(|tool| tool.get("rawInput")))
        .unwrap_or(&Value::Null)
}

fn tool_name(data: &Value) -> Option<&str> {
    non_empty_string(data, &["tool_name", "toolName", "name"])
        .or_else(|| {
            data.get("tool")
                .and_then(|tool| non_empty_string(tool, &["name", "tool_name", "toolName", "kind"]))
        })
        .or_else(|| {
            data.pointer("/_meta/claudeCode/toolName")
                .or_else(|| data.pointer("/_meta/codex/toolName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
}

fn alias_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"(?ix)(?:^|[.:/_-])(?P<op>
                read(?:_file)?|read_file|
                edit(?:_file)?|apply_patch|
                write(?:_file)?|create_file|
                delete(?:_file)?|remove_file|
                move(?:_file)?|rename_file|
                bash|shell|terminal|exec(?:ute)?|run_command|
                web_search|websearch|search_web|web_fetch|fetch_url|
                grep|glob|find_files|search
            )$",
        )
        .expect("valid tool alias regex")
    })
}

fn git_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?ix)^\s*
                (?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?
                git
                (?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?
                \s+(?P<verb>
                    cherry-pick|rev-parse|status|diff|show|log|commit|add|restore|
                    checkout|switch|branch|fetch|pull|push|merge|rebase|tag|stash|
                    reset|remote
                )\b(?P<args>.*)$"#,
        )
        .expect("valid git command regex")
    })
}

fn shell_meta_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?:&&|\|\||[;|]|\n)").expect("valid shell meta regex"))
}

fn path_from(data: &Value) -> Option<&str> {
    non_empty_string(input(data), &["path", "filePath", "file_path", "filename"])
        .or_else(|| non_empty_string(data, &["path", "filePath", "file_path", "filename"]))
}

fn command_from(data: &Value) -> Option<&str> {
    non_empty_string(input(data), &["command", "cmd"])
        .or_else(|| non_empty_string(data, &["command", "cmd"]))
        .or_else(|| {
            data.pointer("/_meta/codex/params")
                .and_then(|params| non_empty_string(params, &["command", "cmd"]))
        })
}

fn query_from(data: &Value) -> Option<&str> {
    non_empty_string(input(data), &["query", "q", "search_query"])
        .or_else(|| non_empty_string(data, &["query", "q", "search_query"]))
}

fn cwd_from(data: &Value) -> Option<&str> {
    non_empty_string(input(data), &["cwd", "working_directory", "workdir"])
        .or_else(|| non_empty_string(data, &["cwd", "working_directory", "workdir"]))
        .or_else(|| {
            data.pointer("/_meta/codex/params").and_then(|params| {
                non_empty_string(params, &["cwd", "working_directory", "workdir"])
            })
        })
}

fn output_text(data: &Value) -> Option<&str> {
    let output = data
        .get("output")
        .or_else(|| data.get("raw_output"))
        .or_else(|| data.get("rawOutput"))?;
    output
        .as_str()
        .or_else(|| non_empty_string(output, &["text", "stdout", "output"]))
}

fn git_status_xy_char(ch: char) -> bool {
    // Porcelain short status XY codes (see `git status --short` docs).
    matches!(
        ch,
        ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!' | 'T' | 'X' | 'P'
    )
}

fn git_status_result(data: &Value) -> Option<Value> {
    let output = output_text(data)?;
    let mut files = Vec::new();
    let mut staged = 0_u64;
    let mut unstaged = 0_u64;
    let mut untracked = 0_u64;
    let mut conflicted = 0_u64;
    let mut branch: Option<&str> = None;

    for line in output.lines() {
        if let Some(value) = line.strip_prefix("## ") {
            branch = Some(value.trim());
            continue;
        }
        let bytes = line.as_bytes();
        if bytes.len() < 3 || bytes[2] != b' ' || !bytes[0].is_ascii() || !bytes[1].is_ascii() {
            continue;
        }
        let index = bytes[0] as char;
        let worktree = bytes[1] as char;
        // Reject fetch/log noise like ` * branch … -> FETCH_HEAD`.
        if !git_status_xy_char(index) || !git_status_xy_char(worktree) {
            continue;
        }
        let path = line[3..].trim();
        if path.is_empty() {
            continue;
        }
        let state = if index == '?' && worktree == '?' {
            untracked += 1;
            "untracked"
        } else if matches!(
            (index, worktree),
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')
        ) {
            conflicted += 1;
            "conflicted"
        } else {
            if index != ' ' {
                staged += 1;
            }
            if worktree != ' ' {
                unstaged += 1;
            }
            if index != ' ' && worktree != ' ' {
                "mixed"
            } else if index != ' ' {
                "staged"
            } else {
                "unstaged"
            }
        };
        if files.len() < 200 {
            files.push(json!({
                "path": path,
                "index": index.to_string(),
                "worktree": worktree.to_string(),
                "state": state,
            }));
        }
    }

    let clean_text = output.contains("nothing to commit") || output.contains("working tree clean");
    if files.is_empty() && branch.is_none() && !clean_text && !output.trim().is_empty() {
        return None;
    }
    // `git status -sb` prints only `## branch` when clean. Compound shells often
    // append unrelated stdout after that — ignore the noise for `clean`.
    let clean = files.is_empty() && (clean_text || branch.is_some() || output.trim().is_empty());
    Some(json!({
        "kind": "git_status",
        "branch": branch,
        "clean": clean,
        "counts": {
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked,
            "conflicted": conflicted,
        },
        "files": files,
        "truncated": output.lines().filter(|line| line.as_bytes().get(2) == Some(&b' ')).count() > 200,
    }))
}

fn add_context(mut presentation: ToolPresentation, data: &Value) -> ToolPresentation {
    if let Some(path) = path_from(data) {
        presentation.path = Some(path.to_string());
        presentation.target = Some(path.to_string());
    }
    if let Some(command) = command_from(data) {
        presentation.command = Some(command.to_string());
        presentation
            .target
            .get_or_insert_with(|| command.to_string());
    }
    if let Some(query) = query_from(data) {
        presentation.query = Some(query.to_string());
        presentation.target.get_or_insert_with(|| query.to_string());
    }
    if let Some(cwd) = cwd_from(data) {
        presentation.cwd = Some(cwd.to_string());
    }
    presentation
}

fn git_presentation(
    command: &str,
    captures: &regex::Captures<'_>,
    data: &Value,
) -> ToolPresentation {
    let verb = captures
        .name("verb")
        .map(|value| value.as_str())
        .unwrap_or("command");
    let args = captures
        .name("args")
        .map(|value| value.as_str().trim())
        .unwrap_or("");
    let compound = shell_meta_regex().is_match(command);
    let event_type = if compound {
        ToolEventType::GitCommand
    } else {
        match verb {
            "status" => ToolEventType::GitStatus,
            "diff" => ToolEventType::GitDiff,
            "show" => ToolEventType::GitShow,
            "log" => ToolEventType::GitLog,
            "commit" => ToolEventType::GitCommit,
            "push" | "pull" | "fetch" => ToolEventType::GitRemote,
            _ => ToolEventType::GitCommand,
        }
    };
    let risk = match verb {
        "status" | "diff" | "show" | "log" | "branch" | "rev-parse" | "remote" => ToolRisk::Read,
        "fetch" => ToolRisk::NetworkRead,
        "push" => ToolRisk::NetworkWrite,
        _ => ToolRisk::Write,
    };
    let operation = if compound { "command" } else { verb };
    let mut presentation = ToolPresentation::new(
        ToolFamily::Git,
        operation,
        event_type,
        "pattern",
        "command.git",
    );
    presentation.command = Some(command.to_string());
    presentation.target = Some(if args.is_empty() { verb } else { args }.to_string());
    presentation.risk = Some(risk);
    presentation.compound = Some(compound);
    if !args.is_empty() {
        presentation.args = Some(args.to_string());
    }
    if let Some(cwd) = cwd_from(data) {
        presentation.cwd = Some(cwd.to_string());
    }
    // Pure `git status` always gets a structured result. Compound/`git_command`
    // probes often mix `status -sb` with `ls`/`fetch` — still surface a status
    // summary when porcelain lines are present so clients do not dump raw stdout.
    if event_type == ToolEventType::GitStatus || compound || event_type == ToolEventType::GitCommand
    {
        presentation.result = git_status_result(data);
    }
    presentation
}

/// Derive a presentation descriptor for one canonical trace `data` object.
/// Returns `None` for non-tool payloads. Callers must preserve a producer-owned
/// `data.presentation`; it is more authoritative than gateway inference.
pub fn classify_typed(data: &Value) -> Option<ToolPresentation> {
    let data = Value::Object(data.as_object()?.clone());
    let command = command_from(&data);
    if let Some(command) = command {
        if let Some(captures) = git_regex().captures(command) {
            return Some(git_presentation(command, &captures, &data));
        }
    }

    let explicit = tool_name(&data);
    let alias = explicit.and_then(|name| alias_regex().captures(name));
    let alias_op = alias
        .as_ref()
        .and_then(|captures| captures.name("op"))
        .map(|value| value.as_str().to_ascii_lowercase());

    let (family, operation, event_type, matched_by) = match alias_op.as_deref() {
        Some("read") | Some("read_file") => (
            ToolFamily::File,
            "read",
            ToolEventType::FileRead,
            "tool_name",
        ),
        Some("edit") | Some("edit_file") | Some("apply_patch") => (
            ToolFamily::File,
            "edit",
            ToolEventType::FileEdit,
            "tool_name",
        ),
        Some("write") | Some("write_file") | Some("create_file") => (
            ToolFamily::File,
            "write",
            ToolEventType::FileWrite,
            "tool_name",
        ),
        Some("delete") | Some("delete_file") | Some("remove_file") => (
            ToolFamily::File,
            "delete",
            ToolEventType::FileDelete,
            "tool_name",
        ),
        Some("move") | Some("move_file") | Some("rename_file") => (
            ToolFamily::File,
            "move",
            ToolEventType::FileMove,
            "tool_name",
        ),
        Some("web_search") | Some("websearch") | Some("search_web") => (
            ToolFamily::Web,
            "search",
            ToolEventType::WebSearch,
            "tool_name",
        ),
        Some("web_fetch") | Some("fetch_url") => (
            ToolFamily::Web,
            "fetch",
            ToolEventType::WebFetch,
            "tool_name",
        ),
        Some("grep") | Some("glob") | Some("find_files") | Some("search") => (
            ToolFamily::Search,
            alias_op.as_deref().unwrap_or("search"),
            ToolEventType::SearchResults,
            "tool_name",
        ),
        Some("bash") | Some("shell") | Some("terminal") | Some("exec") | Some("execute")
        | Some("run_command") => (
            ToolFamily::Shell,
            "run",
            ToolEventType::ShellCommand,
            "tool_name",
        ),
        _ if path_from(&data).is_some() => (
            ToolFamily::File,
            "access",
            ToolEventType::FileAccess,
            "input.path",
        ),
        _ if query_from(&data).is_some() => (
            ToolFamily::Web,
            "search",
            ToolEventType::WebSearch,
            "input.query",
        ),
        _ if command.is_some() => (
            ToolFamily::Shell,
            "run",
            ToolEventType::ShellCommand,
            "input.command",
        ),
        _ => return None,
    };
    let confidence = if explicit.is_some() && alias_op.is_some() {
        "explicit"
    } else {
        "pattern"
    };
    Some(add_context(
        ToolPresentation::new(family, operation, event_type, confidence, matched_by),
        &data,
    ))
}

fn legacy_event_type(presentation: &serde_json::Map<String, Value>) -> Option<ToolEventType> {
    let renderer = presentation.get("renderer")?.as_str()?;
    let family = presentation.get("family").and_then(Value::as_str);
    let operation = presentation.get("operation").and_then(Value::as_str);
    ToolEventType::from_wire_name(renderer).or(match (renderer, family, operation) {
        ("diff", Some("file"), _) => Some(ToolEventType::FileEdit),
        ("diff", Some("git"), _) => Some(ToolEventType::GitDiff),
        ("terminal", _, _) => Some(ToolEventType::ShellCommand),
        ("file", _, Some("delete")) => Some(ToolEventType::FileDelete),
        ("file", _, Some("move")) => Some(ToolEventType::FileMove),
        ("file", _, _) => Some(ToolEventType::FileAccess),
        _ => None,
    })
}

fn normalize_existing_presentation(value: &Value) -> Option<Value> {
    let mut presentation = value.as_object()?.clone();
    let version = presentation.get("v").and_then(Value::as_u64);
    let event_type = if version == Some(PRESENTATION_SCHEMA_VERSION.into()) {
        presentation
            .get("event_type")
            .and_then(Value::as_str)
            .and_then(ToolEventType::from_wire_name)?
    } else if version == Some(1) {
        legacy_event_type(&presentation)?
    } else {
        return None;
    };
    presentation.insert("v".to_string(), json!(PRESENTATION_SCHEMA_VERSION));
    presentation.insert("event_type".to_string(), json!(event_type.wire_name()));
    presentation.remove("renderer");
    Some(Value::Object(presentation))
}

/// JSON wrapper used by the trace wire normalizer. Keeping serialization here
/// guarantees every client sees exactly the same versioned shape.
pub fn classify(data: &Value) -> Option<Value> {
    if let Some(existing) = data.get("presentation") {
        // v1 used coarse renderer names such as `terminal`, so it cannot be the
        // authoritative source for the finer v2 event taxonomy. Reclassify the
        // original server payload first; this also repairs durable events that
        // were persisted before v2 existed.
        if existing.get("v").and_then(Value::as_u64) == Some(1) {
            if let Some(presentation) = classify_typed(data) {
                return serde_json::to_value(presentation).ok();
            }
        }
        return normalize_existing_presentation(existing);
    }
    classify_typed(data).and_then(|presentation| serde_json::to_value(presentation).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_file_tool_beats_title_guessing() {
        let result = classify(&json!({
            "tool_name": "Read",
            "input": {"file_path": "/work/Sources/App.swift"}
        }))
        .unwrap();
        assert_eq!(result["family"], "file");
        assert_eq!(result["operation"], "read");
        assert_eq!(result["v"], PRESENTATION_SCHEMA_VERSION);
        assert_eq!(result["event_type"], "file_read");
        assert_eq!(result["target"], "/work/Sources/App.swift");
        assert_eq!(result["confidence"], "explicit");
    }

    #[test]
    fn accepts_claude_camel_case_tool_payloads() {
        let result = classify(&json!({
            "_meta": {"claudeCode": {"toolName": "Write"}},
            "rawInput": {"file_path": "/work/notes.md", "content": "hello"}
        }))
        .unwrap();
        assert_eq!(result["family"], "file");
        assert_eq!(result["operation"], "write");
        assert_eq!(result["path"], "/work/notes.md");
        assert_eq!(result["matched_by"], "tool_name");
    }

    #[test]
    fn reads_codex_command_metadata_before_shell_fallback() {
        let result = classify(&json!({
            "toolName": "Bash",
            "_meta": {"codex": {"params": {
                "command": "git status --short --branch",
                "cwd": "/work/Cheers"
            }}},
            "rawOutput": "## main\n M frontend/src/App.tsx\n"
        }))
        .unwrap();
        assert_eq!(result["family"], "git");
        assert_eq!(result["operation"], "status");
        assert_eq!(result["cwd"], "/work/Cheers");
        assert_eq!(result["result"]["counts"]["unstaged"], 1);
    }

    #[test]
    fn git_commit_is_a_first_class_operation() {
        let result = classify(&json!({
            "tool_name": "Bash",
            "input": {"command": "git commit -m 'render git traces'", "cwd": "/work"}
        }))
        .unwrap();
        assert_eq!(result["family"], "git");
        assert_eq!(result["operation"], "commit");
        assert_eq!(result["event_type"], "git_commit");
        assert_eq!(result["risk"], "write");
        assert_eq!(result["compound"], false);
        assert_eq!(result["cwd"], "/work");
    }

    #[test]
    fn compound_git_command_is_not_hidden() {
        let result = classify(&json!({
            "input": {"command": "git status --short && git diff --stat"}
        }))
        .unwrap();
        assert_eq!(result["family"], "git");
        assert_eq!(result["operation"], "command");
        assert_eq!(result["event_type"], "git_command");
        assert_eq!(result["compound"], true);
        assert_eq!(result["command"], "git status --short && git diff --stat");
    }

    #[test]
    fn compound_status_probe_extracts_clean_summary_from_mixed_stdout() {
        let result = classify(&json!({
            "input": {
                "command": "git fetch origin develop 2>&1 | tail -5; git status -sb; ls /tmp/worktrees 2>/dev/null"
            },
            "output": {
                "exitCode": 0,
                "stderr": "",
                "stdout": "From github.com:haowei2000/Cheers\n * branch              develop    -> FETCH_HEAD\n## fix/website-mcp-companion-download...origin/fix/website-mcp-companion-download\ne2hy\nki7d\nw7u7\nAEditor\nCheers\n"
            }
        }))
        .unwrap();
        assert_eq!(result["event_type"], "git_command");
        assert_eq!(result["compound"], true);
        assert_eq!(
            result["result"]["branch"],
            "fix/website-mcp-companion-download...origin/fix/website-mcp-companion-download"
        );
        assert_eq!(result["result"]["clean"], true);
        assert_eq!(result["result"]["files"], json!([]));
    }

    #[test]
    fn compound_status_probe_keeps_dirty_files_and_ignores_ls_noise() {
        let result = classify(&json!({
            "input": {
                "command": "git status -sb; ls /tmp"
            },
            "output": "## main...origin/main\n M frontend/App.tsx\n?? new.swift\ne2hy\nCheers\n"
        }))
        .unwrap();
        assert_eq!(result["event_type"], "git_command");
        assert_eq!(result["result"]["clean"], false);
        assert_eq!(result["result"]["counts"]["unstaged"], 1);
        assert_eq!(result["result"]["counts"]["untracked"], 1);
        assert_eq!(result["result"]["files"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn reclassifies_legacy_terminal_presentation_with_compound_git_input() {
        let result = classify(&json!({
            "presentation": {
                "v": 1,
                "family": "shell",
                "operation": "run",
                "renderer": "terminal"
            },
            "tool_name": "execute",
            "input": {
                "command": "git status --short --branch && git log -1 --oneline --decorate",
                "cwd": "/Users/haowei/Projects/Cheers"
            },
            "output": {
                "exit_code": 0,
                "formatted_output": "8725b5f (HEAD -> codex/release-desktop-v0-1-7) chore(desktop): release v0.1.7"
            }
        }))
        .unwrap();

        assert_eq!(result["v"], 2);
        assert_eq!(result["family"], "git");
        assert_eq!(result["event_type"], "git_command");
        assert_eq!(result["compound"], true);
        assert_eq!(result["cwd"], "/Users/haowei/Projects/Cheers");
    }

    #[test]
    fn producer_v2_presentation_keeps_additive_fields() {
        let result = classify(&json!({
            "presentation": {
                "v": 2,
                "event_type": "git_status",
                "family": "git",
                "operation": "status",
                "producer_hint": "keep-me"
            },
            "input": {"command": "git diff"}
        }))
        .unwrap();
        assert_eq!(result["event_type"], "git_status");
        assert_eq!(result["producer_hint"], "keep-me");
    }

    #[test]
    fn upgrades_known_v1_renderer_at_the_gateway_boundary() {
        let result = classify(&json!({
            "presentation": {
                "v": 1,
                "family": "file",
                "operation": "edit",
                "renderer": "diff"
            }
        }))
        .unwrap();
        assert_eq!(result["v"], 2);
        assert_eq!(result["event_type"], "file_edit");
        assert!(result.get("renderer").is_none());
    }

    #[test]
    fn rejects_unknown_producer_event_types_instead_of_guessing() {
        assert!(classify(&json!({
            "presentation": {
                "v": 2,
                "event_type": "mystery_tool",
                "family": "git",
                "operation": "status"
            },
            "input": {"command": "git status"}
        }))
        .is_none());
    }

    #[test]
    fn parses_porcelain_git_status_for_all_clients() {
        let result = classify(&json!({
            "input": {"command": "git status --short --branch"},
            "output": "## feature/tool-ui...origin/feature/tool-ui\nM  staged.rs\n M unstaged.ts\n?? new.swift\nUU conflict.md\n"
        }))
        .unwrap();
        assert_eq!(
            result["result"]["branch"],
            "feature/tool-ui...origin/feature/tool-ui"
        );
        assert_eq!(result["result"]["counts"]["staged"], 1);
        assert_eq!(result["result"]["counts"]["unstaged"], 1);
        assert_eq!(result["result"]["counts"]["untracked"], 1);
        assert_eq!(result["result"]["counts"]["conflicted"], 1);
        assert_eq!(result["result"]["files"][3]["state"], "conflicted");
    }
}
