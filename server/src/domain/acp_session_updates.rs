//! Typed parsing for the three ACP `session/update` notifications that Cheers
//! **promotes** from opaque SEE-telemetry into first-class collaboration artifacts
//! (Phase A of the ACP-collab roadmap): `plan`, `available_commands_update`, and
//! `usage_update`.
//!
//! ## Why this module exists (scoped exception to "stay opaque")
//!
//! The gateway deliberately keeps MOST ACP payloads opaque `Value` — see
//! [`crate::domain::acp_events`]: *"the gateway never interprets a mode/kind's
//! meaning."* That keeps Cheers ACP-generic. This module is the **scoped, explicit
//! exception**: the three updates that become user-facing artifacts (a shared plan
//! board, a cost/budget dashboard, a command palette) need structured shapes to
//! store / aggregate / render. Everything else stays opaque.
//!
//! ## Grounded wire shapes
//!
//! The shapes are grounded in the connector's verbatim passthrough — it builds
//! `DataOutbound::AcpEvent { payload: update }` from the raw ACP `session/update`
//! object (`packages/cheers-acp-connector-rs/src/bridge_runtime/mod.rs`), and its
//! own plan parser (`bridge_runtime/prompt.rs::describe_plan`) confirms `entries`:
//!
//! ```text
//! plan                       -> { entries: [{ content, priority?, status? }] }
//! available_commands_update  -> { availableCommands: [{ name, description?, input? }] }
//! usage_update               -> preview shape (connector does not parse it);
//!                               best-effort numeric extraction, raw kept for fwd-compat
//! ```
//!
//! ## Integration point
//!
//! [`crate::gateway::ws::agent_bridge`]'s `handle_acp_event_frame` already receives
//! `(name, channel_id, session_id, payload)` and logs to `acp_event_log`. Each
//! Phase-A feature calls [`parse`] there and routes the typed result to its own
//! persist/aggregate step — the parse layer is shared, the storage is per-feature.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Registry names (see [`crate::domain::acp_events`]) for the promoted updates.
pub const PLAN: &str = "session/update:plan";
pub const AVAILABLE_COMMANDS: &str = "session/update:available_commands_update";
pub const USAGE: &str = "session/update:usage_update";

/// One item of the agent's live to-do list (ACP plan entry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// The agent's plan: an ordered list of to-do entries.
/// <https://agentclientprotocol.com/protocol/v1/agent-plan>
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Plan {
    #[serde(default)]
    pub entries: Vec<PlanEntry>,
}

impl Plan {
    /// Total number of plan entries.
    pub fn total(&self) -> usize {
        self.entries.len()
    }

    /// Entries whose status is exactly `"completed"` (the ACP terminal status).
    pub fn completed(&self) -> usize {
        self.entries
            .iter()
            .filter(|e| e.status.as_deref() == Some("completed"))
            .count()
    }
}

/// One advertised slash / MCP command (ACP `availableCommands` item).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AvailableCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Opaque input hint/schema as the agent advertised it (kept verbatim).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

/// The set of commands a session currently advertises.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AvailableCommands {
    pub commands: Vec<AvailableCommand>,
}

/// Best-effort usage snapshot. The ACP "Session Usage" surface is in preview, so
/// every field is optional and the raw payload is retained for forward-compat.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
    /// Context window size / used context, if reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    /// Cumulative cost in USD, if the agent reports cost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// A parsed, promoted `session/update`.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedUpdate {
    Plan(Plan),
    AvailableCommands(AvailableCommands),
    Usage(Usage),
}

/// Parse a promoted `session/update` by its registry `name` (e.g.
/// `"session/update:plan"`). Returns `None` for any other event — callers keep
/// treating those opaquely. Parsing is **lenient**: malformed individual entries
/// are skipped rather than discarding the whole update.
pub fn parse(name: &str, payload: &Value) -> Option<ParsedUpdate> {
    match name {
        PLAN => Some(ParsedUpdate::Plan(parse_plan(payload))),
        AVAILABLE_COMMANDS => Some(ParsedUpdate::AvailableCommands(parse_available_commands(
            payload,
        ))),
        USAGE => Some(ParsedUpdate::Usage(parse_usage(payload))),
        _ => None,
    }
}

fn parse_plan(payload: &Value) -> Plan {
    let entries = payload
        .get("entries")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let content = e.get("content").and_then(Value::as_str)?.to_string();
                    Some(PlanEntry {
                        content,
                        priority: e.get("priority").and_then(Value::as_str).map(String::from),
                        status: e.get("status").and_then(Value::as_str).map(String::from),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Plan { entries }
}

fn parse_available_commands(payload: &Value) -> AvailableCommands {
    let commands = payload
        .get("availableCommands")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(Value::as_str)?.to_string();
                    Some(AvailableCommand {
                        name,
                        description: c.get("description").and_then(Value::as_str).map(String::from),
                        input: c.get("input").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    AvailableCommands { commands }
}

fn parse_usage(payload: &Value) -> Usage {
    // Fields may be flat on the update or nested under `usage`.
    let src = payload.get("usage").unwrap_or(payload);
    Usage {
        input_tokens: read_i64(src, &["inputTokens", "input_tokens", "promptTokens"]),
        output_tokens: read_i64(src, &["outputTokens", "output_tokens", "completionTokens"]),
        total_tokens: read_i64(src, &["totalTokens", "total_tokens"]),
        // The ACP "Session Usage" preview reports `used` (tokens currently in the context)
        // + `size` (the window's max). Prefer `used` for the pressure gauge; fall back to
        // the explicit aliases, then the window size.
        context_window: read_i64(
            src,
            &["used", "contextWindow", "context_window", "contextSize", "context_size", "size"],
        ),
        // `cost` may be a flat number OR a nested `{amount, currency}` object (the Claude
        // ACP shape). It is CUMULATIVE, so the read side takes MAX, not SUM.
        cost_usd: read_f64(src, &["costUsd", "cost_usd", "totalCost"]).or_else(|| {
            src.get("cost")
                .and_then(|c| c.as_f64().or_else(|| c.get("amount").and_then(Value::as_f64)))
        }),
    }
}

/// Read the first present integer among `keys` (tolerant of float-encoded ints).
fn read_i64(v: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| {
        v.get(*k)
            .and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
    })
}

/// Read the first present number among `keys` as f64.
fn read_f64(v: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_f64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_plan_with_progress() {
        let payload = json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "Read the code", "priority": "high", "status": "completed" },
                { "content": "Write the fix", "priority": "high", "status": "in_progress" },
                { "content": "Add a test", "status": "pending" }
            ]
        });
        let Some(ParsedUpdate::Plan(plan)) = parse(PLAN, &payload) else {
            panic!("expected a Plan");
        };
        assert_eq!(plan.total(), 3);
        assert_eq!(plan.completed(), 1);
        assert_eq!(plan.entries[2].content, "Add a test");
        assert_eq!(plan.entries[2].priority, None);
        assert_eq!(plan.entries[2].status.as_deref(), Some("pending"));
    }

    #[test]
    fn plan_skips_malformed_entries_but_keeps_the_rest() {
        let payload = json!({
            "entries": [
                { "priority": "high" },                // no `content` → skipped
                { "content": "kept", "status": "pending" }
            ]
        });
        let Some(ParsedUpdate::Plan(plan)) = parse(PLAN, &payload) else {
            panic!("expected a Plan");
        };
        assert_eq!(plan.total(), 1);
        assert_eq!(plan.entries[0].content, "kept");
    }

    #[test]
    fn empty_or_missing_entries_yields_empty_plan() {
        let Some(ParsedUpdate::Plan(plan)) = parse(PLAN, &json!({})) else {
            panic!("expected a Plan");
        };
        assert_eq!(plan.total(), 0);
        assert_eq!(plan.completed(), 0);
    }

    #[test]
    fn parses_available_commands() {
        let payload = json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                { "name": "review", "description": "Review the diff" },
                { "name": "test", "input": { "hint": "path" } },
                { "description": "no name → skipped" }
            ]
        });
        let Some(ParsedUpdate::AvailableCommands(ac)) = parse(AVAILABLE_COMMANDS, &payload) else {
            panic!("expected AvailableCommands");
        };
        assert_eq!(ac.commands.len(), 2);
        assert_eq!(ac.commands[0].name, "review");
        assert_eq!(ac.commands[0].description.as_deref(), Some("Review the diff"));
        assert_eq!(ac.commands[1].name, "test");
        assert!(ac.commands[1].input.is_some());
    }

    #[test]
    fn parses_usage_flat_and_nested() {
        let flat = json!({
            "inputTokens": 1200, "outputTokens": 800, "contextWindow": 200000, "costUsd": 0.42
        });
        let Some(ParsedUpdate::Usage(u)) = parse(USAGE, &flat) else {
            panic!("expected Usage");
        };
        assert_eq!(u.input_tokens, Some(1200));
        assert_eq!(u.output_tokens, Some(800));
        assert_eq!(u.context_window, Some(200_000));
        assert_eq!(u.cost_usd, Some(0.42));

        let nested = json!({ "usage": { "total_tokens": 2000, "cost": 1.5 } });
        let Some(ParsedUpdate::Usage(u)) = parse(USAGE, &nested) else {
            panic!("expected Usage");
        };
        assert_eq!(u.total_tokens, Some(2000));
        assert_eq!(u.cost_usd, Some(1.5));
        assert_eq!(u.input_tokens, None);
    }

    #[test]
    fn parses_claude_usage_shape() {
        // The real Claude ACP usage_update: cumulative `cost` object + context `used`/`size`.
        let payload = json!({
            "cost": { "amount": 0.19418445, "currency": "USD" },
            "size": 200000,
            "used": 30213,
            "sessionUpdate": "usage_update"
        });
        let Some(ParsedUpdate::Usage(u)) = parse(USAGE, &payload) else {
            panic!("expected Usage");
        };
        assert_eq!(u.context_window, Some(30213)); // `used` — the pressure gauge
        assert!((u.cost_usd.unwrap() - 0.194_184_45).abs() < 1e-9); // nested cost.amount
        assert_eq!(u.input_tokens, None); // no per-turn token deltas in this shape
        assert_eq!(u.total_tokens, None);

        // A snapshot without cost still yields context (not all-empty → gets stored).
        let no_cost = json!({ "size": 200000, "used": 29974 });
        let Some(ParsedUpdate::Usage(u2)) = parse(USAGE, &no_cost) else {
            panic!("expected Usage");
        };
        assert_eq!(u2.context_window, Some(29974));
        assert_eq!(u2.cost_usd, None);
    }

    #[test]
    fn unknown_event_is_not_parsed() {
        assert!(parse("session/update:tool_call", &json!({ "title": "ls" })).is_none());
        assert!(parse("session/prompt", &json!({})).is_none());
    }
}
