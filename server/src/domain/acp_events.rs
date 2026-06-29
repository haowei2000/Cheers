//! Canonical ACP event registry — the single source of truth that classifies
//! every ACP event by its **home layer** and, where Cheers governs/observes it,
//! its event-access **class** + **capability**. See docs/arch/ACP_EVENT_TAXONOMY.md.
//!
//! Homes:
//! - `Agent`     — the agent's own mechanic (when it asks); nothing for Cheers to do.
//! - `Connector` — host firewall (`fs/*`, `terminal/*`) or session plumbing
//!                 (`initialize`/`session/new`…); gated host-side, observed by Cheers.
//! - `Cheers`    — governed by the per-user event-access matrix (INITIATE/SEE/RESPOND).
//! - `Observe`   — agent push notifications Cheers records/surfaces (optionally SEE-gated).
//!
//! `name` is the ACP method, or `session/update:<subtype>` for an update notification
//! (opaque strings — the gateway never interprets a mode/kind's meaning).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Home {
    Agent,
    Connector,
    Cheers,
    Observe,
}

impl Home {
    pub fn as_str(self) -> &'static str {
        match self {
            Home::Agent => "agent",
            Home::Connector => "connector",
            Home::Cheers => "cheers",
            Home::Observe => "observe",
        }
    }
}

/// One classified ACP event.
#[derive(Debug, Clone, Copy)]
pub struct AcpEvent {
    /// ACP method or `session/update:<subtype>`.
    pub name: &'static str,
    pub home: Home,
    /// The `bot_event_policy` event-class this maps to (`None` = not matrix-modeled).
    pub event_class: Option<&'static str>,
    /// `initiate` | `see` | `respond` — the capability the class is gated under.
    pub capability: Option<&'static str>,
    /// High-frequency streaming chunk — skip persisting to the event log (the bot's
    /// message already captures the text); still transported.
    pub streaming: bool,
}

const fn ev(
    name: &'static str,
    home: Home,
    event_class: Option<&'static str>,
    capability: Option<&'static str>,
    streaming: bool,
) -> AcpEvent {
    AcpEvent { name, home, event_class, capability, streaming }
}

/// The full ACP surface (agent-client-protocol 1.x), classified.
pub const REGISTRY: &[AcpEvent] = &[
    // ── client→agent: lifecycle / plumbing (Connector-owned) ──────────────────
    ev("initialize", Home::Connector, None, None, false),
    ev("authenticate", Home::Connector, None, None, false),
    ev("logout", Home::Connector, None, None, false),
    ev("session/new", Home::Connector, None, None, false),
    ev("session/load", Home::Connector, None, None, false),
    ev("session/resume", Home::Connector, None, None, false),
    ev("session/list", Home::Connector, None, None, false),
    ev("session/close", Home::Connector, None, None, false),
    ev("session/fork", Home::Connector, None, None, false),
    ev("session/delete", Home::Connector, None, None, false),
    // ── client→agent: per-user actions (Cheers INITIATE) ──────────────────────
    ev("session/prompt", Home::Cheers, Some("prompt"), Some("initiate"), false),
    ev("session/cancel", Home::Cheers, Some("cancel"), Some("initiate"), false),
    ev("session/set_mode", Home::Cheers, Some("set_mode"), Some("initiate"), false),
    ev("session/set_config_option", Home::Cheers, Some("set_config_option"), Some("initiate"), false),
    // ── agent→client requests ────────────────────────────────────────────────
    // permission_request: Cheers SEE (view the card) + RESPOND (answer it).
    ev("session/request_permission", Home::Cheers, Some("permission_request"), Some("respond"), false),
    ev("fs/read_text_file", Home::Connector, None, None, false),
    ev("fs/write_text_file", Home::Connector, None, None, false),
    ev("terminal/create", Home::Connector, None, None, false),
    ev("terminal/output", Home::Connector, None, None, true),
    ev("terminal/wait_for_exit", Home::Connector, None, None, false),
    ev("terminal/kill", Home::Connector, None, None, false),
    ev("terminal/release", Home::Connector, None, None, false),
    // ── agent→client session/update notifications ─────────────────────────────
    ev("session/update:agent_message_chunk", Home::Cheers, Some("output"), Some("see"), true),
    ev("session/update:agent_thought_chunk", Home::Cheers, Some("thought"), Some("see"), true),
    ev("session/update:user_message_chunk", Home::Cheers, Some("output"), Some("see"), true),
    ev("session/update:tool_call", Home::Cheers, Some("tool_call"), Some("see"), false),
    ev("session/update:tool_call_update", Home::Cheers, Some("tool_call"), Some("see"), false),
    ev("session/update:plan", Home::Cheers, Some("plan"), Some("see"), false),
    ev("session/update:available_commands_update", Home::Observe, Some("available_commands"), Some("see"), false),
    ev("session/update:current_mode_update", Home::Observe, Some("current_mode"), Some("see"), false),
    ev("session/update:config_option_update", Home::Observe, Some("config_option"), Some("see"), false),
    ev("session/update:usage_update", Home::Observe, Some("usage"), Some("see"), false),
];

/// Classify an ACP event by name (method or `session/update:<subtype>`).
pub fn classify(name: &str) -> Option<&'static AcpEvent> {
    REGISTRY.iter().find(|e| e.name == name)
}

/// Normalize a raw `session/update` subtype to the registry name.
pub fn session_update_name(subtype: &str) -> String {
    format!("session/update:{subtype}")
}

/// Whether this event should be persisted to the event log (skip streaming chunks
/// and unknown events default to persist=true so nothing is silently lost).
pub fn should_log(name: &str) -> bool {
    match classify(name) {
        Some(e) => !e.streaming,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_events() {
        assert_eq!(classify("session/prompt").unwrap().home, Home::Cheers);
        assert_eq!(classify("session/prompt").unwrap().capability, Some("initiate"));
        assert_eq!(classify("fs/write_text_file").unwrap().home, Home::Connector);
        assert_eq!(
            classify("session/update:available_commands_update").unwrap().home,
            Home::Observe
        );
        assert_eq!(
            classify("session/request_permission").unwrap().event_class,
            Some("permission_request")
        );
    }

    #[test]
    fn streaming_chunks_are_not_logged() {
        assert!(!should_log("session/update:agent_message_chunk"));
        assert!(should_log("session/update:tool_call"));
        // Unknown events default to logged (never silently dropped).
        assert!(should_log("session/update:some_future_event"));
    }

    #[test]
    fn every_registry_name_is_unique() {
        let mut names: Vec<&str> = REGISTRY.iter().map(|e| e.name).collect();
        names.sort_unstable();
        let len = names.len();
        names.dedup();
        assert_eq!(names.len(), len, "duplicate ACP event name in REGISTRY");
    }
}
