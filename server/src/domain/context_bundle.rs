//! Validation/normalization for a resource-context bundle SUPPLIED BY A BOT
//! (docs/design/RESOURCE_CONTEXT.md — the "Bot / Manual pick" producer).
//!
//! A bot attaches a bundle to a message it posts (via the `post_message` MCP
//! tool → `channel.messages.create`). Unlike the gateway-assembled F2 handoff
//! bundle, this is **untrusted input**, so it is normalized before persistence:
//!
//! - only READ resource verbs are allowed (a bundle is a list of things to
//!   *read*; a write verb has no meaning as context and must never ride along);
//! - the item count is capped;
//! - `origin` is stamped `"bot"`, ignoring anything the client sent — a bot must
//!   not be able to spoof an `"handoff"` / `"human"` provenance.
//!
//! Safety of the *contents* is still enforced at pull time: the consuming bot
//! re-authorizes every ref as itself (`Principal::bot`), so a bundle can only
//! point at things — reading them remains consumer-governed. This module is
//! defense-in-depth against garbage / write-verb abuse / provenance spoofing.

use serde_json::{json, Map, Value};

/// Max items kept from a bot-supplied bundle; extra items are dropped.
const MAX_ITEMS: usize = 16;

/// Resource verbs a context ref may name — the READ side of the resource
/// registry (`server/src/resource/mod.rs`). Write verbs are intentionally
/// excluded: a context bundle is a read list.
const READ_VERBS: &[&str] = &[
    "channel.info",
    "channel.members",
    "channel.context",
    "channel.messages",
    "channel.messages.index",
    "channel.messages.by-seq",
    "channel.messages.search",
    "channel.activity.read",
    "channel.files",
    "channel.files.read",
    "channel.plan.read",
    "channel.usage.read",
    "channel.commands.read",
    "channel.sessions.read",
    "fs.ls",
    "fs.read",
];

fn is_read_verb(verb: &str) -> bool {
    READ_VERBS.contains(&verb)
}

/// Normalize a bot-supplied context bundle. Returns `None` when the input is
/// absent/malformed or nothing survives filtering (caller then stores NULL).
///
/// Accepts either the full bundle object `{ "items": [...] }` or a bare items
/// array — the MCP tool wraps the agent's `context` array as `{items}`, but
/// being lenient here keeps the contract forgiving.
pub fn sanitize_bot_bundle(raw: &Value) -> Option<Value> {
    let items = raw
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| raw.as_array())?;

    let mut out: Vec<Value> = Vec::new();
    for item in items {
        if out.len() >= MAX_ITEMS {
            break;
        }
        let Some(obj) = item.as_object() else { continue };
        let verb = obj.get("verb").and_then(Value::as_str).unwrap_or_default();
        if !is_read_verb(verb) {
            continue;
        }
        // Rebuild each item from known fields only — drops any stray keys and
        // guarantees the shape the renderer/consumer expects.
        let mut clean = Map::new();
        clean.insert("verb".into(), json!(verb));
        if let Some(params) = obj.get("params").filter(|v| v.is_object()) {
            clean.insert("params".into(), params.clone());
        }
        if let Some(label) = obj.get("label").and_then(Value::as_str) {
            clean.insert("label".into(), json!(label));
        }
        if let Some(kind) = obj.get("kind").and_then(Value::as_str) {
            clean.insert("kind".into(), json!(kind));
        }
        out.push(Value::Object(clean));
    }

    if out.is_empty() {
        return None;
    }
    // Stamp provenance ourselves — never trust a client-supplied `origin`.
    Some(json!({ "origin": "bot", "items": out }))
}

/// Max chars kept in a chip `label`, and in an inline `preview.text` snapshot —
/// bound what a client can inflate the message row / task frame with.
const MAX_LABEL_CHARS: usize = 200;
const MAX_PREVIEW_CHARS: usize = 2000;
/// Drop an item whose `params` serialize larger than this (a bundle ref's params
/// are small locators; anything huge is abuse).
const MAX_PARAMS_CHARS: usize = 8000;

/// Verbs a HUMAN may reference: every read verb, plus `workspace.file` — the
/// remote-workspace snapshot locator, which humans legitimately pick (gated by
/// their own `workspace/read`) but bots cannot produce.
fn is_human_verb(verb: &str) -> bool {
    is_read_verb(verb) || verb == "workspace.file"
}

/// Normalize a HUMAN-supplied context bundle (the composer / in-panel pickers).
/// Same spine as [`sanitize_bot_bundle`] — read verbs only, item cap, `origin`
/// stamped `"human"` (never trust the client's `origin`/`from`) — but the human
/// allowlist also admits `workspace.file` and KEEPS the inline `preview` snapshot
/// (truncated). Write verbs are dropped so a bundle can never carry an executable
/// instruction into an agent's prompt. Returns `None` when nothing survives.
///
/// The returned bundle still carries previews; callers split it into a row copy
/// (via [`strip_previews`], persisted + broadcast to members) and a dispatch copy
/// (this value, delivered only to the @mentioned target bot's task frame), and
/// must additionally re-check `workspace/read` for each `workspace.file` item.
pub fn sanitize_human_bundle(raw: &Value) -> Option<Value> {
    let items = raw
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| raw.as_array())?;

    let mut out: Vec<Value> = Vec::new();
    for item in items {
        if out.len() >= MAX_ITEMS {
            break;
        }
        let Some(obj) = item.as_object() else { continue };
        let verb = obj.get("verb").and_then(Value::as_str).unwrap_or_default();
        if !is_human_verb(verb) {
            continue;
        }
        let mut clean = Map::new();
        clean.insert("verb".into(), json!(verb));
        if let Some(params) = obj.get("params").filter(|v| v.is_object()) {
            if params.to_string().len() > MAX_PARAMS_CHARS {
                continue; // oversized params → drop the whole item
            }
            clean.insert("params".into(), params.clone());
        }
        if let Some(label) = obj.get("label").and_then(Value::as_str) {
            let trimmed: String = label.chars().take(MAX_LABEL_CHARS).collect();
            clean.insert("label".into(), json!(trimmed));
        }
        if let Some(kind) = obj.get("kind").and_then(Value::as_str) {
            clean.insert("kind".into(), json!(kind));
        }
        // Keep the inline snapshot (truncated). Object-shaped only; a client can't
        // smuggle a non-{text} preview.
        if let Some(text) = obj
            .get("preview")
            .and_then(|p| p.get("text"))
            .and_then(Value::as_str)
        {
            let snapshot: String = text.chars().take(MAX_PREVIEW_CHARS).collect();
            clean.insert("preview".into(), json!({ "text": snapshot }));
        }
        out.push(Value::Object(clean));
    }

    if out.is_empty() {
        return None;
    }
    Some(json!({ "origin": "human", "items": out }))
}

/// Return a copy of `bundle` with every item's `preview` removed — the
/// member-facing (persisted + broadcast) form. Members never see snapshot content
/// in the UI (chips render label/kind only); the full-preview copy goes solely to
/// the authorized target bot's task frame. `None`/non-bundle input passes through.
pub fn strip_previews(bundle: &Value) -> Value {
    let Some(items) = bundle.get("items").and_then(Value::as_array) else {
        return bundle.clone();
    };
    let stripped: Vec<Value> = items
        .iter()
        .map(|item| {
            let mut obj = item.as_object().cloned().unwrap_or_default();
            obj.remove("preview");
            Value::Object(obj)
        })
        .collect();
    let mut top = bundle.as_object().cloned().unwrap_or_default();
    top.insert("items".into(), Value::Array(stripped));
    Value::Object(top)
}

/// Extract the item list from any bundle shape (bot / human / handoff) for
/// merging. Returns an empty vec when there are none.
pub fn bundle_items(bundle: &Value) -> Vec<Value> {
    bundle
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_read_verbs_and_stamps_origin() {
        let raw = json!({
            "origin": "handoff", // must be ignored / overwritten
            "items": [
                { "verb": "channel.plan.read", "params": {"channel_id": "c"}, "label": "Plan", "kind": "plan" },
                { "verb": "channel.activity.read", "params": {"channel_id": "c"} }
            ]
        });
        let out = sanitize_bot_bundle(&raw).expect("bundle survives");
        assert_eq!(out["origin"], json!("bot"), "origin must be stamped 'bot'");
        assert_eq!(out["items"].as_array().unwrap().len(), 2);
        assert_eq!(out["items"][0]["label"], json!("Plan"));
    }

    #[test]
    fn drops_write_and_unknown_verbs() {
        let raw = json!({ "items": [
            { "verb": "channel.messages.create" },   // write → dropped
            { "verb": "fs.write" },                    // write → dropped
            { "verb": "totally.bogus" },               // unknown → dropped
            { "verb": "fs.read", "params": {"path": "x"} } // read → kept
        ]});
        let out = sanitize_bot_bundle(&raw).expect("one read verb survives");
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["verb"], json!("fs.read"));
    }

    #[test]
    fn caps_item_count() {
        let items: Vec<Value> = (0..40)
            .map(|_| json!({ "verb": "channel.info" }))
            .collect();
        let out = sanitize_bot_bundle(&json!({ "items": items })).unwrap();
        assert_eq!(out["items"].as_array().unwrap().len(), MAX_ITEMS);
    }

    #[test]
    fn empty_or_all_dropped_is_none() {
        assert!(sanitize_bot_bundle(&json!({ "items": [] })).is_none());
        assert!(sanitize_bot_bundle(&json!({ "items": [ {"verb": "fs.write"} ] })).is_none());
        assert!(sanitize_bot_bundle(&json!({ "nope": 1 })).is_none());
    }

    #[test]
    fn accepts_bare_array() {
        let out = sanitize_bot_bundle(&json!([ { "verb": "channel.info" } ])).unwrap();
        assert_eq!(out["items"].as_array().unwrap().len(), 1);
    }

    // ── human bundle ────────────────────────────────────────────────────────

    #[test]
    fn human_stamps_origin_and_rejects_client_provenance() {
        let raw = json!({
            "origin": "handoff", // spoof attempt — must be overwritten
            "from": { "type": "bot", "id": "attacker" },
            "items": [ { "verb": "channel.plan.read", "params": {"channel_id": "c"}, "label": "Plan", "kind": "plan" } ]
        });
        let out = sanitize_human_bundle(&raw).expect("survives");
        assert_eq!(out["origin"], json!("human"), "origin forced to human");
        assert!(out.get("from").is_none(), "client `from` dropped");
    }

    #[test]
    fn human_drops_write_verbs_keeps_workspace_file() {
        let raw = json!({ "items": [
            { "verb": "fs.rm", "params": {"path": "x"} },      // write → dropped
            { "verb": "channel.messages.create" },              // write → dropped
            { "verb": "fs.read", "params": {"path": "y"} },     // read → kept
            { "verb": "workspace.file", "params": {"bot_id": "b", "path": "m.rs"},
              "label": "m.rs", "kind": "file", "preview": { "text": "code" } } // kept w/ preview
        ]});
        let out = sanitize_human_bundle(&raw).expect("survives");
        let verbs: Vec<&str> = out["items"].as_array().unwrap().iter()
            .map(|i| i["verb"].as_str().unwrap()).collect();
        assert_eq!(verbs, vec!["fs.read", "workspace.file"]);
        assert_eq!(out["items"][1]["preview"]["text"], json!("code"));
    }

    #[test]
    fn human_truncates_label_and_preview() {
        let raw = json!({ "items": [
            { "verb": "workspace.file", "params": {"bot_id":"b","path":"p"},
              "label": "L".repeat(500), "preview": { "text": "P".repeat(5000) } }
        ]});
        let out = sanitize_human_bundle(&raw).unwrap();
        assert_eq!(out["items"][0]["label"].as_str().unwrap().chars().count(), MAX_LABEL_CHARS);
        assert_eq!(out["items"][0]["preview"]["text"].as_str().unwrap().chars().count(), MAX_PREVIEW_CHARS);
    }

    #[test]
    fn human_drops_oversized_params_item() {
        let big = "x".repeat(MAX_PARAMS_CHARS + 100);
        let raw = json!({ "items": [ { "verb": "fs.read", "params": {"path": big} } ] });
        assert!(sanitize_human_bundle(&raw).is_none(), "oversized params item dropped");
    }

    #[test]
    fn strip_previews_removes_only_preview() {
        let full = sanitize_human_bundle(&json!({ "items": [
            { "verb": "workspace.file", "params": {"bot_id":"b","path":"p"},
              "label": "p", "kind": "file", "preview": { "text": "secret" } }
        ]})).unwrap();
        assert_eq!(full["items"][0]["preview"]["text"], json!("secret"));
        let row = strip_previews(&full);
        assert!(row["items"][0].get("preview").is_none(), "row copy strips preview");
        assert_eq!(row["items"][0]["label"], json!("p"), "keeps label/locator");
        assert_eq!(row["origin"], json!("human"));
    }
}
