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
}
