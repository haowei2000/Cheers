//! Session references — the strings a user pastes to attach a session that
//! started in another app (`codex://threads/<uuid>`, `claude --resume <uuid>`,
//! a ChatGPT share link, …).
//!
//! Parsing is pure and host-independent: it only says *which* app and *which*
//! native id. Whether that session exists, and on which host, is the
//! connector's job (resolve), so the gateway, the connector and the CLI can all
//! run this same parser and never disagree about what a string means.

use serde::{Deserialize, Serialize};

/// The app a referenced session belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionSource {
    Codex,
    ClaudeCode,
    #[serde(rename = "chatgpt")]
    ChatGpt,
}

impl SessionSource {
    /// The app whose sessions an ACP Agent can list and load, keyed by the
    /// Agent's `initialize` `agentInfo.name` (e.g. `@agentclientprotocol/codex-acp`).
    /// Only Agents whose session ids ARE the app's ids belong here: codex-acp
    /// lists Codex thread ids, claude-agent-acp lists Claude Code session ids.
    pub fn from_agent_name(name: &str) -> Option<Self> {
        let name = name.rsplit('/').next().unwrap_or(name);
        match name {
            "codex-acp" => Some(Self::Codex),
            "claude-agent-acp" | "claude-code-acp" => Some(Self::ClaudeCode),
            _ => None,
        }
    }
}

/// How a referenced session can be brought into Cheers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachMode {
    /// A local agent session that can be resumed over ACP `session/load`.
    Live,
    /// A cloud conversation with no runtime to resume; only its transcript
    /// can be imported as a file.
    Import,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRef {
    pub source: SessionSource,
    pub mode: AttachMode,
    /// The app's own session id (lowercased when it is a UUID).
    pub native_id: String,
}

impl SessionRef {
    /// Creation time encoded in a UUIDv7 `native_id` (Codex thread ids are
    /// v7), in Unix milliseconds. Lets a resolver go straight to the dated
    /// session folder instead of scanning every session.
    pub fn created_at_ms(&self) -> Option<u64> {
        uuid_v7_timestamp_ms(&self.native_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionRefError {
    Empty,
    /// A bare id with no source hint — it could belong to several apps.
    SourceRequired,
    /// `chatgpt.com/c/<id>` is a private chat; only its owner's data export
    /// or a public share link can be imported.
    PrivateChatGptLink,
    /// The format is known but the id part is malformed.
    InvalidId,
    Unrecognized,
}

impl std::fmt::Display for SessionRefError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Empty => "session reference is empty",
            Self::SourceRequired => "a bare session id needs the app it belongs to",
            Self::PrivateChatGptLink => {
                "private ChatGPT chat links cannot be read; use a share link or a data export"
            }
            Self::InvalidId => "session reference has a malformed id",
            Self::Unrecognized => "not a recognized session reference",
        })
    }
}

impl std::error::Error for SessionRefError {}

/// Parse a pasted session reference. `hint` names the app for a bare UUID
/// (e.g. the bot the user is attaching to); it is ignored when the string
/// itself names the app.
pub fn parse_session_ref(
    input: &str,
    hint: Option<SessionSource>,
) -> Result<SessionRef, SessionRefError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(SessionRefError::Empty);
    }

    if let Some(rest) = input.strip_prefix("codex://threads/") {
        return live(SessionSource::Codex, uuid_segment(rest)?);
    }
    if let Some(r) = parse_https(input) {
        return r;
    }
    if let Some(r) = parse_command(input) {
        return r;
    }
    if is_uuid(input) {
        let source = hint.ok_or(SessionRefError::SourceRequired)?;
        if source == SessionSource::ChatGpt {
            // A bare id cannot tell a share link from a private chat.
            return Err(SessionRefError::SourceRequired);
        }
        return live(source, input);
    }
    Err(SessionRefError::Unrecognized)
}

fn live(source: SessionSource, id: &str) -> Result<SessionRef, SessionRefError> {
    Ok(SessionRef {
        source,
        mode: AttachMode::Live,
        native_id: id.to_ascii_lowercase(),
    })
}

fn parse_https(input: &str) -> Option<Result<SessionRef, SessionRefError>> {
    let rest = input.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.strip_prefix("www.").unwrap_or(host);
    if host != "chatgpt.com" && host != "chat.openai.com" {
        return Some(Err(SessionRefError::Unrecognized));
    }
    // Drop query/fragment; `/g/<gpt>/c/<id>` is a custom-GPT chat, still private.
    let path = path.split(['?', '#']).next().unwrap_or("");
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    Some(match segments.as_slice() {
        ["share", id] => share_id(id).map(|id| SessionRef {
            source: SessionSource::ChatGpt,
            mode: AttachMode::Import,
            native_id: id.to_string(),
        }),
        ["c", _] | ["g", _, "c", _] => Err(SessionRefError::PrivateChatGptLink),
        _ => Err(SessionRefError::Unrecognized),
    })
}

/// `codex resume <uuid>` and `claude --resume|-r <uuid>`, as copied from a
/// terminal or the apps' own "resume" hints.
fn parse_command(input: &str) -> Option<Result<SessionRef, SessionRefError>> {
    let words: Vec<&str> = input.split_whitespace().collect();
    let (source, id) = match words.as_slice() {
        ["codex", "resume", id] => (SessionSource::Codex, *id),
        ["claude", "--resume" | "-r", id] => (SessionSource::ClaudeCode, *id),
        _ => return None,
    };
    Some(if is_uuid(id) {
        live(source, id)
    } else {
        Err(SessionRefError::InvalidId)
    })
}

fn uuid_segment(rest: &str) -> Result<&str, SessionRefError> {
    let id = rest.split(['?', '#']).next().unwrap_or("");
    let id = id.strip_suffix('/').unwrap_or(id);
    if is_uuid(id) {
        Ok(id)
    } else {
        Err(SessionRefError::InvalidId)
    }
}

fn share_id(id: &str) -> Result<&str, SessionRefError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(id)
    } else {
        Err(SessionRefError::InvalidId)
    }
}

/// Canonical 8-4-4-4-12 hex UUID, any case.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn uuid_v7_timestamp_ms(id: &str) -> Option<u64> {
    if !is_uuid(id) || id.as_bytes()[14] != b'7' {
        return None;
    }
    // First 48 bits: chars 0..8 and 9..13.
    let hex = format!("{}{}", &id[0..8], &id[9..13]);
    u64::from_str_radix(&hex, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX_ID: &str = "01a1422e-d5e6-7e10-be3b-040fa49834a4";

    #[test]
    fn codex_thread_link() {
        let r = parse_session_ref(&format!("codex://threads/{CODEX_ID}"), None).unwrap();
        assert_eq!(r.source, SessionSource::Codex);
        assert_eq!(r.mode, AttachMode::Live);
        assert_eq!(r.native_id, CODEX_ID);
        // 2026-10-16T00:48:48.102Z — matches the rollout file's timestamp.
        assert_eq!(r.created_at_ms(), Some(1_792_111_728_102));
    }

    #[test]
    fn codex_link_tolerates_whitespace_case_and_trailing_slash() {
        let input = format!("  codex://threads/{}/\n", CODEX_ID.to_uppercase());
        let r = parse_session_ref(&input, None).unwrap();
        assert_eq!(r.native_id, CODEX_ID);
    }

    #[test]
    fn codex_link_with_bad_id() {
        assert_eq!(
            parse_session_ref("codex://threads/not-a-uuid", None),
            Err(SessionRefError::InvalidId)
        );
    }

    #[test]
    fn resume_commands() {
        let r = parse_session_ref(&format!("codex resume {CODEX_ID}"), None).unwrap();
        assert_eq!(r.source, SessionSource::Codex);
        for flag in ["--resume", "-r"] {
            let r = parse_session_ref(&format!("claude {flag} {CODEX_ID}"), None).unwrap();
            assert_eq!(r.source, SessionSource::ClaudeCode);
            assert_eq!(r.mode, AttachMode::Live);
        }
        assert_eq!(
            parse_session_ref("claude --resume latest", None),
            Err(SessionRefError::InvalidId)
        );
    }

    #[test]
    fn bare_uuid_needs_a_live_source_hint() {
        assert_eq!(
            parse_session_ref(CODEX_ID, None),
            Err(SessionRefError::SourceRequired)
        );
        assert_eq!(
            parse_session_ref(CODEX_ID, Some(SessionSource::ChatGpt)),
            Err(SessionRefError::SourceRequired)
        );
        let r = parse_session_ref(CODEX_ID, Some(SessionSource::ClaudeCode)).unwrap();
        assert_eq!(r.source, SessionSource::ClaudeCode);
    }

    #[test]
    fn chatgpt_share_link_imports() {
        for host in ["chatgpt.com", "www.chatgpt.com", "chat.openai.com"] {
            let r =
                parse_session_ref(&format!("https://{host}/share/{CODEX_ID}?x=1"), None).unwrap();
            assert_eq!(r.source, SessionSource::ChatGpt);
            assert_eq!(r.mode, AttachMode::Import);
            assert_eq!(r.native_id, CODEX_ID);
        }
    }

    #[test]
    fn chatgpt_private_chat_is_rejected() {
        for url in [
            "https://chatgpt.com/c/abc-123",
            "https://chatgpt.com/g/g-xyz/c/abc-123",
        ] {
            assert_eq!(
                parse_session_ref(url, None),
                Err(SessionRefError::PrivateChatGptLink)
            );
        }
    }

    #[test]
    fn unrecognized_inputs() {
        assert_eq!(parse_session_ref("   ", None), Err(SessionRefError::Empty));
        for input in [
            "hello",
            "https://example.com/share/abc",
            "http://chatgpt.com/share/abc",
            "codex resume",
        ] {
            assert_eq!(
                parse_session_ref(input, None),
                Err(SessionRefError::Unrecognized),
                "{input}"
            );
        }
    }

    #[test]
    fn non_v7_uuid_has_no_timestamp() {
        let r = parse_session_ref("codex://threads/550e8400-e29b-41d4-a716-446655440000", None)
            .unwrap();
        assert_eq!(r.created_at_ms(), None);
    }

    #[test]
    fn agent_names_map_to_sources() {
        for (name, want) in [
            ("@agentclientprotocol/codex-acp", Some(SessionSource::Codex)),
            ("codex-acp", Some(SessionSource::Codex)),
            (
                "@agentclientprotocol/claude-agent-acp",
                Some(SessionSource::ClaudeCode),
            ),
            (
                "@zed-industries/claude-code-acp",
                Some(SessionSource::ClaudeCode),
            ),
            ("gemini", None),
            ("acp-agent", None),
        ] {
            assert_eq!(SessionSource::from_agent_name(name), want, "{name}");
        }
    }

    #[test]
    fn serializes_snake_case() {
        let r = parse_session_ref(&format!("codex://threads/{CODEX_ID}"), None).unwrap();
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({ "source": "codex", "mode": "live", "native_id": CODEX_ID })
        );
        let src = serde_json::to_value(SessionSource::ChatGpt).unwrap();
        assert_eq!(src, "chatgpt");
    }
}
