//! Core data model, static metadata extraction, and validation engine for Cheers interactive resources.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
pub mod global_uri;

pub const VERSION_V1: &str = "v0.9.1";
pub const CATALOG_ID_V1: &str = "urn:cheers:a2ui:catalog:v1";
pub const VERSION: &str = "1.0";
pub const CATALOG_ID: &str = "urn:cheers:a2ui:catalog:v2";
pub const GUIDE_URI: &str = "cheers://help/interactive-ui";
pub const CATALOG_URI: &str = "cheers://help/interactive-ui/catalog";
pub const EXAMPLE_URI: &str = "cheers://help/interactive-ui/example";
pub const CATALOG_V1: &str = include_str!("../../../design-system/a2ui-catalog.json");
pub const CATALOG: &str = include_str!("../../../design-system/a2ui-catalog-v2.json");
pub const EXAMPLE: &str =
    include_str!("../../../frontend/src/features/chat/workbench/lens/a2ui/example.a2ui.json");
pub const VIEW_SUFFIXES: &str = include_str!("../../../shared/view-suffixes.json");
pub const GUIDE: &str = "# Cheers interactive resources\n\nRead `read_ui_contract` before authoring UI. Its example prepares a draft; request_example sends a structured request. When called as a Bot, request_example is bound to your authenticated Bot id; human discovery uses an example UUID that must be replaced. Use A2UI 1.0 and catalog urn:cheers:a2ui:catalog:v2, not the Basic Catalog (legacy v0.9.1 / urn:cheers:a2ui:catalog:v1 persisted files remain readable). The file name selects the view; see view_suffixes in this contract. Generic JSON/YAML opens as source. Keep view settings (including kanban columns) in the file; do not write Workbench bindings. Persist {a2ui:\"1.0\",messages:[...]} using artifact_create with channel_id, path forms/<name>.a2ui.json and content. In A2UI 1.0, createSurface may inline components and dataModel in a single message. Use artifact_patch/artifact_update with artifact_id and if_version for updates. Use the returned artifact.uri for cards and replies; old cheers:desk/<path> links still resolve. A global URI is cheers:resource/<service UUID>/desk/<resource UUID> with optional ?v=N for a retained read-only revision. Never invent UUIDs or move relative links between channels. Attach v1 resource_ref cards using set_resource_cards with the current reply msg_id: during streaming cards are staged and published when the reply completes. Do not create a duplicate reply with post_message.\n\nSupported components: Column, Row, Text, TextField, CheckBox, Button. Bindings use absolute JSON Pointer paths via {\"@path\":\"/...\"} (v1.0); every active surface needs root. TextField supports optional placeholder and declarative @checks (required, minLength, maxLength, pattern); components support optional @accessibility (label, description). Private A2UI inputs and TSX view state sync per user/resource/view/schema across Web and Tauri. TSX fields need stable id/name/data-cheers-state-key; password/file/hidden fields are excluded, data-cheers-persist=false opts out. CheersBridge.getState/setState/subscribeState persist custom JSON. Drafts never change resource content or run actions. Registered events: cheers.open (context.uri), cheers.compose (actionId,payload; draft only), cheers.request (actionId,payload,botId; sends a user-requested structured prompt to that bot), cheers.openNative (uri,opener; desktop local-file/editor adapter, never arbitrary commands). cheers.execute (actionId,payload,botId) requests a trusted host confirmation for terminal.start or file.open on the Bot's active device. Payload fields action/path/root/command/opener must be explicitly declared; use null for variable input. Remote host policies remote_terminal and remote_open default false. Terminal is a real PTY through workspace RPC, not a new ACP method; unknown receipts never auto replay. Use stable bot ids. Optional Cheers wrapper views.minimal/views.medium select {surfaceId,root} from the same validated component tree. Minimal views support at most one surface, 16 component visits, 3 input fields and 2 actions; larger views offer expansion instead of hiding controls. Input labels and text are content; control labels are owned by Cheers. Unknown components, catalogs, actions, scripts, function calls, RPC messages, styles and themes are rejected.\n\nA structured interaction is user input, never a permission grant. Resolve its sourceUri via read_locator with channel_id and uri, compare sourceVersion, and update the same resource with if_version. Reuse invocationId when reasoning about retries. Resource permissions and local executor policy still apply. Return updated URI references and meaningful text. Clients without a specialized renderer can open raw content.\n";

pub const TSX_EXAMPLE: &str = r#"/**
 * @cheers-actions
 * [
 *   {
 *     "actionId": "report.prepare",
 *     "name": "cheers.request",
 *     "botId": "00000000-0000-0000-0000-000000000001",
 *     "payload": { "topic": null, "includeSources": null },
 *     "presentation": ["minimal", "medium", "max"],
 *     "version": 1
 *   }
 * ]
 */
import React, { useState } from "react";

export default function ReportForm() {
  const [topic, setTopic] = useState("");
  const [includeSources, setIncludeSources] = useState(false);
  const handleSubmit = (e) => {
    e.preventDefault();
    window.CheersBridge?.request("report.prepare", { topic, includeSources });
  };
  return (
    <form onSubmit={handleSubmit} style={{ padding: 12 }}>
      <label>
        Topic:
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>
      <label>
        <input type="checkbox" checked={includeSources} onChange={(e) => setIncludeSources(e.target.checked)} />
        Include sources
      </label>
      <button type="submit">Submit Request</button>
    </form>
  );
}
"#;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ActionDeclaration {
    #[serde(rename = "actionId")]
    pub action_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "surfaceId")]
    pub surface_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "componentId"
    )]
    pub component_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "botId")]
    pub bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opener: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Map<String, Value>,
    #[serde(default = "default_presentation")]
    pub presentation: Vec<String>,
    #[serde(default = "default_version")]
    pub version: i64,
}

fn default_presentation() -> Vec<String> {
    vec!["minimal".into(), "medium".into(), "max".into()]
}

fn default_version() -> i64 {
    1
}

pub fn contract() -> Value {
    json!({
        "version": VERSION,
        "supported_versions": [VERSION, VERSION_V1],
        "catalog_id": CATALOG_ID,
        "guide": GUIDE,
        "view_suffixes": serde_json::from_str::<Value>(VIEW_SUFFIXES).expect("embedded view suffixes"),
        "renderers": ["a2ui", "tsx", "html"],
        "catalog": serde_json::from_str::<Value>(CATALOG).expect("embedded catalog"),
        "example": serde_json::from_str::<Value>(EXAMPLE).expect("embedded example"),
        "request_example": request_example("00000000-0000-0000-0000-000000000001"),
        "tsx_example": tsx_request_example("00000000-0000-0000-0000-000000000001"),
    })
}

pub fn contract_for_bot(bot_id: &str) -> Value {
    let mut contract = contract();
    contract["request_example"] = request_example(bot_id);
    contract["tsx_example"] = json!(tsx_request_example(bot_id));
    contract
}

pub fn tsx_request_example(bot_id: &str) -> String {
    TSX_EXAMPLE.replace("00000000-0000-0000-0000-000000000001", bot_id)
}

pub fn request_example(bot_id: &str) -> Value {
    let mut document: Value = serde_json::from_str(EXAMPLE).expect("embedded example");
    if let Some(messages) = document["messages"].as_array_mut() {
        for message in messages {
            let key = if message.get("createSurface").is_some() {
                "createSurface"
            } else {
                "updateComponents"
            };
            let components = message
                .get_mut(key)
                .and_then(|section| section.get_mut("components"))
                .and_then(Value::as_array_mut);
            if let Some(components) = components {
                for component in components {
                    if component["id"] == "description" {
                        component["text"] =
                            json!("Choose your inputs, then send an explicit request to the Bot.");
                    } else if component["id"] == "prepare" {
                        component["action"]["event"]["name"] = json!("cheers.request");
                        component["action"]["event"]["context"]["botId"] = json!(bot_id);
                    }
                }
            }
        }
    }
    document
}

pub fn resource_content(uri: &str) -> Option<Value> {
    let (mime, text) = match uri {
        GUIDE_URI => ("text/markdown", GUIDE),
        CATALOG_URI => ("application/json", CATALOG),
        EXAMPLE_URI => ("application/json", EXAMPLE),
        _ => return None,
    };
    Some(json!({"uri":uri,"mimeType":mime,"text":text}))
}

fn id(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|s| valid_id(s, limit))
}

fn valid_id(s: &str, limit: usize) -> bool {
    !s.is_empty()
        && s.len() <= limit
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}

fn keys(value: &Value, allowed: &[&str]) -> Result<(), &'static str> {
    let obj = value.as_object().ok_or("expected an object")?;
    if obj.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("unsupported property");
    }
    Ok(())
}

pub fn pointer(path: &str) -> Result<Vec<String>, &'static str> {
    if path == "/" || path.is_empty() {
        return Ok(vec![]);
    }
    if !path.starts_with('/') || path.len() > 1024 {
        return Err("invalid data path");
    }
    let mut parts = Vec::new();
    for raw in path[1..].split('/') {
        let mut chars = raw.chars();
        while let Some(c) = chars.next() {
            if c == '~' && !matches!(chars.next(), Some('0' | '1')) {
                return Err("invalid pointer escape");
            }
        }
        let part = raw.replace("~1", "/").replace("~0", "~");
        if ["__proto__", "prototype", "constructor"].contains(&part.as_str()) {
            return Err("unsafe data path");
        }
        parts.push(part);
    }
    if parts.len() > 32 {
        return Err("data path too deep");
    }
    Ok(parts)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProtoVersion {
    V0_9_1,
    V1_0,
}

impl ProtoVersion {
    fn from_value(value: &Value) -> Result<Self, &'static str> {
        match value.as_str() {
            Some(VERSION_V1) => Ok(Self::V0_9_1),
            Some(VERSION) => Ok(Self::V1_0),
            _ => Err("unsupported version"),
        }
    }

    fn version_str(self) -> &'static str {
        match self {
            Self::V0_9_1 => VERSION_V1,
            Self::V1_0 => VERSION,
        }
    }

    fn catalog_id(self) -> &'static str {
        match self {
            Self::V0_9_1 => CATALOG_ID_V1,
            Self::V1_0 => CATALOG_ID,
        }
    }

    fn binding_key(self) -> &'static str {
        match self {
            Self::V0_9_1 => "path",
            Self::V1_0 => "@path",
        }
    }
}

fn binding(value: &Value, proto: ProtoVersion) -> Result<(), &'static str> {
    if value.is_string() {
        return Ok(());
    }
    let key = proto.binding_key();
    keys(value, &[key])?;
    pointer(value[key].as_str().ok_or("binding needs path")?)?;
    Ok(())
}

fn validate_accessibility(value: &Value, proto: ProtoVersion) -> Result<(), &'static str> {
    keys(value, &["label", "description"])?;
    if let Some(label) = value.get("label") {
        binding(label, proto)?;
    }
    if let Some(desc) = value.get("description") {
        binding(desc, proto)?;
    }
    Ok(())
}

fn parse_quantifier(bytes: &[u8], start: usize) -> Option<(usize, bool)> {
    let ch = *bytes.get(start)?;
    if ch == b'?' || ch == b'*' || ch == b'+' {
        return Some((start + 1, ch == b'*' || ch == b'+'));
    }
    if ch == b'{' {
        let end = bytes[start + 1..].iter().position(|&b| b == b'}')? + start + 1;
        let body = std::str::from_utf8(&bytes[start + 1..end]).ok()?;
        let (min_s, max_opt) = match body.split_once(',') {
            Some((a, b)) => (a, Some(b)),
            None => (body, None),
        };
        if min_s.is_empty() || !min_s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let min: u32 = min_s.parse().ok()?;
        if min > 256 {
            return None;
        }
        let repeating = match max_opt {
            None => min > 1,
            Some("") => true,
            Some(max_s) => {
                if !max_s.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let max: u32 = max_s.parse().ok()?;
                if max > 256 || max < min {
                    return None;
                }
                max > 1
            }
        };
        return Some((end + 1, repeating));
    }
    None
}

fn is_safe_check_pattern(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut stack: Vec<(bool, bool)> = vec![(false, false)];
    let mut in_class = false;
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i];
        if ch == b'\\' {
            let Some(&next) = bytes.get(i + 1) else {
                return false;
            };
            if next.is_ascii_digit() && next != b'0' || next == b'k' {
                return false;
            }
            i += 2;
            if let Some((next_i, _)) = parse_quantifier(bytes, i) {
                stack.last_mut().unwrap().0 = true;
                i = next_i;
                if parse_quantifier(bytes, i).is_some() {
                    return false;
                }
            }
            continue;
        }
        if in_class {
            if ch == b']' {
                in_class = false;
                i += 1;
                if let Some((next_i, _)) = parse_quantifier(bytes, i) {
                    stack.last_mut().unwrap().0 = true;
                    i = next_i;
                    if parse_quantifier(bytes, i).is_some() {
                        return false;
                    }
                }
            } else {
                i += 1;
            }
            continue;
        }
        if ch == b'[' {
            in_class = true;
            i += 1;
            continue;
        }
        if ch == b'(' {
            if bytes.get(i + 1) == Some(&b'?')
                && matches!(bytes.get(i + 2), Some(b'=' | b'!' | b'<'))
            {
                return false;
            }
            stack.push((false, false));
            i += 1;
            continue;
        }
        if ch == b')' {
            if stack.len() <= 1 {
                return false;
            }
            let (has_q, has_alt) = stack.pop().unwrap();
            i += 1;
            if let Some((next_i, repeating)) = parse_quantifier(bytes, i) {
                if repeating && (has_q || has_alt) {
                    return false;
                }
                stack.last_mut().unwrap().0 = true;
                i = next_i;
                if parse_quantifier(bytes, i).is_some() {
                    return false;
                }
            } else if has_q {
                stack.last_mut().unwrap().0 = true;
            }
            continue;
        }
        if ch == b'|' {
            stack.last_mut().unwrap().1 = true;
            i += 1;
            continue;
        }
        i += 1;
        if let Some((next_i, _)) = parse_quantifier(bytes, i) {
            stack.last_mut().unwrap().0 = true;
            i = next_i;
            if parse_quantifier(bytes, i).is_some() {
                return false;
            }
        }
    }
    !in_class && stack.len() == 1
}

fn validate_checks(value: &Value) -> Result<(), &'static str> {
    let items = value.as_array().ok_or("checks must be an array")?;
    if items.len() > 8 {
        return Err("too many checks");
    }
    for item in items {
        let rule = item
            .get("rule")
            .and_then(Value::as_str)
            .ok_or("check rule required")?;
        if let Some(msg) = item.get("message") {
            let s = msg.as_str().ok_or("check message must be string")?;
            if s.len() > 256 {
                return Err("check message too long");
            }
        }
        match rule {
            "required" => keys(item, &["rule", "message"])?,
            "minLength" | "maxLength" => {
                keys(item, &["rule", "value", "message"])?;
                let bound = item["value"].as_u64().ok_or("invalid check length bound")?;
                let min = if rule == "minLength" { 0 } else { 1 };
                if bound < min || bound > 4096 {
                    return Err("invalid check length bound");
                }
            }
            "pattern" => {
                keys(item, &["rule", "value", "message"])?;
                let pat = item["value"].as_str().ok_or("invalid check pattern")?;
                if pat.is_empty() || pat.len() > 256 || !is_safe_check_pattern(pat) {
                    return Err("invalid check pattern");
                }
            }
            _ => return Err("unsupported check rule"),
        }
    }
    Ok(())
}

fn safe_json(value: &Value, depth: usize) -> Result<(), &'static str> {
    if depth > 32 {
        return Err("data too deep");
    }
    match value {
        Value::Object(obj) => {
            if obj.len() > 1024 {
                return Err("object too large");
            }
            for (key, item) in obj {
                if ["__proto__", "prototype", "constructor"].contains(&key.as_str()) {
                    return Err("unsafe data key");
                }
                safe_json(item, depth + 1)?;
            }
        }
        Value::Array(items) => {
            if items.len() > 1024 {
                return Err("array too large");
            }
            for item in items {
                safe_json(item, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_component(node: &Value, proto: ProtoVersion) -> Result<(), &'static str> {
    if !id(&node["id"], 128) {
        return Err("invalid component id");
    }
    let v2 = proto == ProtoVersion::V1_0;
    if v2 {
        if let Some(a11y) = node.get("@accessibility") {
            validate_accessibility(a11y, proto)?;
        }
    }
    match node["component"].as_str().ok_or("component required")? {
        "Row" | "Column" => {
            keys(
                node,
                if v2 {
                    &["id", "component", "children", "@accessibility"]
                } else {
                    &["id", "component", "children"]
                },
            )?;
            let children = node["children"].as_array().ok_or("children required")?;
            let mut seen = HashSet::new();
            if children.len() > 256
                || children
                    .iter()
                    .any(|c| !id(c, 128) || !seen.insert(c.to_string()))
            {
                return Err("invalid children");
            }
        }
        "Text" => {
            keys(
                node,
                if v2 {
                    &["id", "component", "text", "@accessibility"]
                } else {
                    &["id", "component", "text"]
                },
            )?;
            binding(&node["text"], proto)?;
        }
        "TextField" | "CheckBox" => {
            let is_text_field = node["component"] == "TextField";
            keys(
                node,
                if v2 && is_text_field {
                    &[
                        "id",
                        "component",
                        "label",
                        "value",
                        "placeholder",
                        "@checks",
                        "@accessibility",
                    ]
                } else if v2 {
                    &["id", "component", "label", "value", "@accessibility"]
                } else {
                    &["id", "component", "label", "value"]
                },
            )?;
            binding(&node["label"], proto)?;
            binding(&node["value"], proto)?;
            let key = proto.binding_key();
            if pointer(
                node["value"][key]
                    .as_str()
                    .ok_or("input requires binding")?,
            )?
            .is_empty()
            {
                return Err("input requires non-root binding");
            }
            if v2 && is_text_field {
                if let Some(placeholder) = node.get("placeholder") {
                    binding(placeholder, proto)?;
                }
                if let Some(checks) = node.get("@checks") {
                    validate_checks(checks)?;
                }
            }
        }
        "Button" => {
            keys(
                node,
                if v2 {
                    &["id", "component", "label", "action", "@accessibility"]
                } else {
                    &["id", "component", "label", "action"]
                },
            )?;
            binding(&node["label"], proto)?;
            keys(&node["action"], &["event"])?;
            keys(&node["action"]["event"], &["name", "context"])?;
            let event = &node["action"]["event"];
            let context = &event["context"];
            match event["name"].as_str() {
                Some("cheers.open" | "cheers.openNative") => {
                    let native = event["name"] == "cheers.openNative";
                    keys(context, if native { &["uri", "opener"] } else { &["uri"] })?;
                    binding(&context["uri"], proto)?;
                    if let Some(uri) = context["uri"].as_str() {
                        if !uri.starts_with("cheers:") {
                            return Err("invalid locator");
                        }
                    }
                    if native
                        && !matches!(
                            context["opener"].as_str(),
                            Some("finder" | "vscode" | "zed")
                        )
                    {
                        return Err("unsupported opener");
                    }
                }
                Some("cheers.compose" | "cheers.request" | "cheers.execute") => {
                    let request = matches!(
                        event["name"].as_str(),
                        Some("cheers.request" | "cheers.execute")
                    );
                    keys(
                        context,
                        if request {
                            &["actionId", "payload", "botId"]
                        } else {
                            &["actionId", "payload"]
                        },
                    )?;
                    if !id(&context["actionId"], 80) {
                        return Err("invalid action id");
                    }
                    if request && !uuid_shape(&context["botId"]) {
                        return Err("request needs stable bot id");
                    }
                    let payload = context["payload"]
                        .as_object()
                        .ok_or("payload must be object")?;
                    for value in payload.values() {
                        if value.is_object() {
                            binding(value, proto)?;
                        } else if value.is_array() {
                            return Err("invalid payload value");
                        }
                    }
                }
                _ => return Err("unsupported action"),
            }
        }
        _ => return Err("unsupported component"),
    }
    Ok(())
}

fn uuid_shape(value: &Value) -> bool {
    value.as_str().is_some_and(global_uri::uuid)
}

pub fn is_desk_uri(uri: &str) -> bool {
    if let Some(global) = global_uri::parse(uri) {
        return global.kind == "desk";
    }
    if let Some(path) = uri.strip_prefix("cheers:desk/") {
        !path.is_empty() && path.len() <= 2048 && !path.contains("..") && !path.starts_with('/')
    } else {
        false
    }
}

pub fn validate_document(
    doc: &Value,
) -> Result<HashMap<String, HashMap<String, Value>>, &'static str> {
    keys(doc, &["a2ui", "messages", "views"])?;
    let proto = ProtoVersion::from_value(&doc["a2ui"])?;
    if doc.to_string().len() > 256_000 {
        return Err("unsupported version or oversized document");
    }
    safe_json(doc, 0)?;
    let messages = doc["messages"].as_array().ok_or("messages required")?;
    if messages.len() > 256 {
        return Err("too many messages");
    }
    let mut surfaces: HashMap<String, HashMap<String, Value>> = HashMap::new();
    let mut data_models: HashMap<String, Value> = HashMap::new();
    let apply_components = |surface: &mut HashMap<String, Value>,
                            components_val: &Value|
     -> Result<(), &'static str> {
        let components = components_val.as_array().ok_or("components required")?;
        if components.len() > 256 {
            return Err("too many components");
        }
        let mut seen = HashSet::new();
        for node in components {
            validate_component(node, proto)?;
            let cid = node["id"].as_str().unwrap();
            if !seen.insert(cid) {
                return Err("duplicate component");
            }
            surface.insert(cid.into(), node.clone());
        }
        if surface.len() > 256 {
            return Err("too many components");
        }
        Ok(())
    };
    for message in messages {
        let kinds: Vec<_> = [
            "createSurface",
            "updateComponents",
            "updateDataModel",
            "deleteSurface",
        ]
        .into_iter()
        .filter(|key| message.get(key).is_some())
        .collect();
        if message["version"] != proto.version_str() || kinds.len() != 1 {
            return Err("invalid message envelope");
        }
        let kind = kinds[0];
        keys(message, &["version", kind])?;
        let body = &message[kind];
        if !id(&body["surfaceId"], 128) {
            return Err("invalid surface id");
        }
        let sid = body["surfaceId"].as_str().unwrap();
        if kind == "createSurface" {
            keys(
                body,
                if proto == ProtoVersion::V1_0 {
                    &["surfaceId", "catalogId", "components", "dataModel"]
                } else {
                    &["surfaceId", "catalogId"]
                },
            )?;
            if body["catalogId"] != proto.catalog_id()
                || surfaces.contains_key(sid)
                || surfaces.len() >= 8
            {
                return Err("unsupported catalog or duplicate surface");
            }
            let mut surface = HashMap::new();
            let mut data = json!({});
            if proto == ProtoVersion::V1_0 {
                if let Some(dm) = body.get("dataModel") {
                    patch_data(&mut data, &[], Some(dm))?;
                }
                if let Some(components) = body.get("components") {
                    apply_components(&mut surface, components)?;
                }
            }
            surfaces.insert(sid.into(), surface);
            data_models.insert(sid.into(), data);
            continue;
        }
        let surface = surfaces.get_mut(sid).ok_or("surface not created")?;
        match kind {
            "deleteSurface" => {
                keys(body, &["surfaceId"])?;
                surfaces.remove(sid);
                data_models.remove(sid);
            }
            "updateDataModel" => {
                keys(body, &["surfaceId", "path", "value"])?;
                let path = body
                    .get("path")
                    .map(|v| v.as_str().ok_or("invalid path"))
                    .transpose()?
                    .unwrap_or("/");
                patch_data(
                    data_models.get_mut(sid).unwrap(),
                    &pointer(path)?,
                    body.get("value"),
                )?;
            }
            _ => {
                keys(body, &["surfaceId", "components"])?;
                apply_components(surface, &body["components"])?;
            }
        }
    }
    fn walk(
        id: &str,
        nodes: &HashMap<String, Value>,
        ancestors: &mut HashSet<String>,
        visits: &mut usize,
    ) -> Result<(), &'static str> {
        *visits += 1;
        if *visits > 1024 || ancestors.len() >= 32 || !ancestors.insert(id.into()) {
            return Err("cyclic or oversized graph");
        }
        let node = nodes.get(id).ok_or("missing child")?;
        if let Some(children) = node["children"].as_array() {
            for child in children {
                walk(child.as_str().unwrap(), nodes, ancestors, visits)?;
            }
        }
        ancestors.remove(id);
        Ok(())
    }
    for nodes in surfaces.values() {
        if !nodes.contains_key("root") {
            return Err("root required");
        }
        let mut visits = 0;
        for id in nodes.keys() {
            walk(id, nodes, &mut HashSet::new(), &mut visits)?;
        }
    }
    if let Some(views) = doc.get("views") {
        keys(views, &["minimal", "medium"])?;
        for view in views.as_object().unwrap().values() {
            keys(view, &["surfaceId", "root"])?;
            let sid = view["surfaceId"].as_str().ok_or("view surface required")?;
            let root = view["root"].as_str().ok_or("view root required")?;
            if !surfaces
                .get(sid)
                .is_some_and(|nodes| nodes.contains_key(root))
            {
                return Err("view references missing component");
            }
        }
    }
    Ok(surfaces)
}

fn patch_data(
    current: &mut Value,
    parts: &[String],
    value: Option<&Value>,
) -> Result<(), &'static str> {
    if parts.is_empty() {
        let value = value
            .filter(|v| v.is_object())
            .ok_or("root data must be object")?;
        *current = value.clone();
        return Ok(());
    }
    let key = &parts[0];
    if let Some(array) = current.as_array_mut() {
        let index: usize = key.parse().map_err(|_| "invalid array index")?;
        if index >= array.len() || index.to_string() != *key {
            return Err("invalid array index");
        }
        if parts.len() == 1 {
            if let Some(value) = value {
                array[index] = value.clone();
            } else {
                array.remove(index);
            }
            return Ok(());
        }
        return patch_data(&mut array[index], &parts[1..], value);
    }
    let object = current
        .as_object_mut()
        .ok_or("data path crosses a scalar")?;
    if parts.len() == 1 {
        if let Some(value) = value {
            object.insert(key.clone(), value.clone());
        } else {
            object.remove(key);
        }
        return Ok(());
    }
    patch_data(
        object.entry(key.clone()).or_insert_with(|| json!({})),
        &parts[1..],
        value,
    )
}

pub fn validate_interaction(event: &Value) -> Result<(), &'static str> {
    keys(
        event,
        &[
            "v",
            "sourceUri",
            "sourceVersion",
            "surfaceId",
            "componentId",
            "actionId",
            "botId",
            "invocationId",
            "input",
        ],
    )?;
    if event["v"] != 1 || !is_desk_uri(event["sourceUri"].as_str().unwrap_or("")) {
        return Err("interaction needs Desk source URI");
    }
    if !event["sourceVersion"].as_i64().is_some_and(|v| v > 0)
        || !id(&event["surfaceId"], 128)
        || !id(&event["componentId"], 128)
        || !id(&event["actionId"], 80)
        || !uuid_shape(&event["botId"])
        || !uuid_shape(&event["invocationId"])
        || !event["input"].is_object()
        || event["input"].to_string().len() > 20_000
    {
        return Err("invalid interaction context");
    }
    safe_json(&event["input"], 0)
}

pub fn extract_a2ui_actions(doc: &Value) -> Result<Vec<ActionDeclaration>, &'static str> {
    let surfaces = validate_document(doc)?;
    let mut declarations = Vec::new();
    for (sid, components) in surfaces {
        for component in components.values() {
            if component.get("component").and_then(Value::as_str) != Some("Button") {
                continue;
            }
            let Some(event) = component.get("action").and_then(|a| a.get("event")) else {
                continue;
            };
            let name = event.get("name").and_then(Value::as_str).unwrap_or("");
            let context = &event["context"];
            let action_id = context
                .get("actionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if action_id.is_empty() {
                continue;
            }
            let text = |key: &str| context.get(key).and_then(Value::as_str).map(String::from);
            let payload = context
                .get("payload")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            declarations.push(ActionDeclaration {
                surface_id: Some(sid.clone()),
                component_id: component["id"].as_str().map(String::from),
                action_id: action_id.to_string(),
                name: name.to_string(),
                bot_id: text("botId"),
                uri: text("uri"),
                opener: text("opener"),
                payload,
                presentation: default_presentation(),
                version: 1,
            });
        }
    }
    Ok(declarations)
}

fn parse_action_declarations(val: &Value) -> Result<Vec<ActionDeclaration>, &'static str> {
    let items = match val {
        Value::Array(arr) => arr.as_slice(),
        Value::Object(obj) => {
            if let Some(Value::Array(arr)) = obj.get("actions") {
                arr.as_slice()
            } else {
                std::slice::from_ref(val)
            }
        }
        _ => return Err("@cheers-actions must be an array or object"),
    };
    let mut declarations = Vec::new();
    for item in items {
        let action_id = item
            .get("actionId")
            .and_then(Value::as_str)
            .ok_or("actionId required")?;
        if !valid_id(action_id, 80) {
            return Err("invalid actionId");
        }
        let raw_name = item
            .get("name")
            .or_else(|| item.get("type"))
            .and_then(Value::as_str)
            .ok_or("action name required")?;
        let name = match raw_name {
            "request" | "cheers.request" => "cheers.request",
            "execute" | "cheers.execute" => "cheers.execute",
            "compose" | "cheers.compose" => "cheers.compose",
            "open" | "cheers.open" => "cheers.open",
            "openNative" | "cheers.openNative" => "cheers.openNative",
            _ => return Err("unsupported action name"),
        };
        let bot_id = item.get("botId").and_then(Value::as_str).map(String::from);
        if matches!(name, "cheers.request" | "cheers.execute") {
            let Some(bid) = &bot_id else {
                return Err("request action requires botId");
            };
            if !global_uri::uuid(bid) {
                return Err("invalid botId UUID");
            }
        }
        let uri = item.get("uri").and_then(Value::as_str).map(String::from);
        let opener = item.get("opener").and_then(Value::as_str).map(String::from);
        let payload = match item.get("payload") {
            Some(Value::Object(obj)) => {
                safe_json(&Value::Object(obj.clone()), 0)?;
                obj.clone()
            }
            Some(_) => return Err("payload must be an object"),
            None => serde_json::Map::new(),
        };
        let presentation = match item.get("presentation") {
            Some(Value::Array(arr)) => {
                let mut pres = Vec::new();
                for p in arr {
                    let s = p.as_str().ok_or("presentation values must be strings")?;
                    if !["minimal", "medium", "max"].contains(&s) {
                        return Err("unsupported presentation level");
                    }
                    pres.push(s.to_string());
                }
                pres
            }
            Some(_) => return Err("presentation must be an array"),
            None => default_presentation(),
        };
        let version = item.get("version").and_then(Value::as_i64).unwrap_or(1);
        if version < 1 {
            return Err("invalid version");
        }
        declarations.push(ActionDeclaration {
            surface_id: Some("root".into()),
            component_id: Some(action_id.to_string()),
            action_id: action_id.to_string(),
            name: name.to_string(),
            bot_id,
            uri,
            opener,
            payload,
            presentation,
            version,
        });
    }
    Ok(declarations)
}

pub fn extract_tsx_actions(content: &str) -> Result<Vec<ActionDeclaration>, &'static str> {
    let Some(idx) = content.find("@cheers-actions") else {
        return Ok(Vec::new());
    };
    let rest = &content[idx + "@cheers-actions".len()..];
    let block = if let Some(end_idx) = rest.find("*/") {
        &rest[..end_idx]
    } else {
        rest
    };
    let mut cleaned = String::with_capacity(block.len());
    for line in block.lines() {
        let trimmed = line.trim();
        let stripped = if let Some(after_star) = trimmed.strip_prefix('*') {
            after_star.trim_start()
        } else {
            trimmed
        };
        cleaned.push_str(stripped);
        cleaned.push('\n');
    }
    let Some(start) = cleaned.find(|c| c == '[' || c == '{') else {
        return Err("missing JSON after @cheers-actions");
    };
    let json_str = &cleaned[start..];
    let mut de = serde_json::Deserializer::from_str(json_str);
    let val: Value =
        serde::de::Deserialize::deserialize(&mut de).map_err(|_| "invalid @cheers-actions JSON")?;
    parse_action_declarations(&val)
}

pub fn extract_action_declarations(
    path: &str,
    content: &str,
    parsed_data: Option<&Value>,
) -> Result<Vec<ActionDeclaration>, &'static str> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if matches!(ext.as_str(), "json" | "a2ui" | "yaml" | "yml")
        && (content.contains("\"a2ui\"") || parsed_data.is_some_and(|d| d.get("a2ui").is_some()))
    {
        if let Some(doc) = parsed_data {
            return extract_a2ui_actions(doc);
        }
        if let Ok(doc) = serde_json::from_str::<Value>(content) {
            return extract_a2ui_actions(&doc);
        }
    }
    extract_tsx_actions(content)
}

pub fn validate_action_input(
    expected_payload: &serde_json::Map<String, Value>,
    supplied_input: &serde_json::Map<String, Value>,
) -> Result<(), &'static str> {
    if expected_payload.len() != supplied_input.len() {
        return Err("interaction inputs field count mismatch");
    }
    for (key, expected_val) in expected_payload {
        let Some(supplied_val) = supplied_input.get(key) else {
            return Err("missing expected input field");
        };
        if expected_val.is_object() || expected_val.is_null() {
            if supplied_val.is_object() || supplied_val.is_array() {
                return Err("nested object/array input rejected");
            }
        } else if expected_val != supplied_val {
            return Err("constant value mismatch");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_contract_matches() {
        let c: Value = serde_json::from_str(CATALOG).unwrap();
        assert_eq!(c["catalogId"], CATALOG_ID);
        let c1: Value = serde_json::from_str(CATALOG_V1).unwrap();
        assert_eq!(c1["catalogId"], CATALOG_ID_V1);
        assert!(validate_document(&serde_json::from_str(EXAMPLE).unwrap()).is_ok());
        assert!(validate_document(&contract()["request_example"]).is_ok());
    }
    #[test]
    fn rejects_unknown_binding_and_cycle() {
        let mut d: Value = serde_json::from_str(EXAMPLE).unwrap();
        d["messages"][0]["createSurface"]["components"][0]["children"] = json!(["root"]);
        assert!(validate_document(&d).is_err());
        assert!(pointer("/__proto__/polluted").is_err());
        assert!(pointer("/bad~2").is_err());

        // Reject legacy path inside v1.0 document
        let mut mixed: Value = serde_json::from_str(EXAMPLE).unwrap();
        mixed["messages"][0]["createSurface"]["components"][3]["value"] =
            json!({"path": "/report/topic"});
        assert!(validate_document(&mixed).is_err());

        // Reject unsupported @checks rule and unsafe ReDoS pattern
        let mut bad_check: Value = serde_json::from_str(EXAMPLE).unwrap();
        bad_check["messages"][0]["createSurface"]["components"][3]["@checks"] =
            json!([{"rule": "eval"}]);
        assert!(validate_document(&bad_check).is_err());

        bad_check["messages"][0]["createSurface"]["components"][3]["@checks"] =
            json!([{"rule": "pattern", "value": "^(a+)+$"}]);
        assert!(validate_document(&bad_check).is_err());
    }
    #[test]
    fn supports_legacy_v0_9_1_documents() {
        let legacy = json!({
            "a2ui": "v0.9.1",
            "messages": [
                {
                    "version": "v0.9.1",
                    "createSurface": {
                        "surfaceId": "report",
                        "catalogId": "urn:cheers:a2ui:catalog:v1"
                    }
                },
                {
                    "version": "v0.9.1",
                    "updateComponents": {
                        "surfaceId": "report",
                        "components": [
                            { "id": "root", "component": "Column", "children": ["topic", "prepare"] },
                            { "id": "topic", "component": "TextField", "label": "Topic", "value": { "path": "/topic" } },
                            {
                                "id": "prepare",
                                "component": "Button",
                                "label": "Send",
                                "action": {
                                    "event": {
                                        "name": "cheers.compose",
                                        "context": {
                                            "actionId": "report.prepare",
                                            "payload": { "topic": { "path": "/topic" } }
                                        }
                                    }
                                }
                            }
                        ]
                    }
                }
            ]
        });
        assert!(validate_document(&legacy).is_ok());
        assert_eq!(extract_a2ui_actions(&legacy).unwrap().len(), 1);
    }
    #[test]
    fn presentation_views_reference_only_validated_active_components() {
        let mut doc: Value = serde_json::from_str(EXAMPLE).unwrap();
        assert!(validate_document(&doc).is_ok());
        doc["views"]["minimal"]["root"] = json!("missing");
        assert!(validate_document(&doc).is_err());
        doc["views"] = json!({"minimal":{"surfaceId":"absent","root":"root"}});
        assert!(validate_document(&doc).is_err());
        doc["views"] = json!({"custom":{"surfaceId":"report","root":"root"}});
        assert!(validate_document(&doc).is_err());
    }
    #[test]
    fn extracts_a2ui_and_tsx_actions() {
        let a2ui_doc = contract()["request_example"].clone();
        let a2ui_actions = extract_a2ui_actions(&a2ui_doc).unwrap();
        assert_eq!(a2ui_actions.len(), 1);
        assert_eq!(a2ui_actions[0].action_id, "report.prepare");
        assert_eq!(a2ui_actions[0].name, "cheers.request");
        assert_eq!(
            a2ui_actions[0].bot_id,
            Some("00000000-0000-0000-0000-000000000001".into())
        );

        let tsx_source = tsx_request_example("11111111-2222-3333-4444-555555555555");
        let tsx_actions = extract_tsx_actions(&tsx_source).unwrap();
        assert_eq!(tsx_actions.len(), 1);
        assert_eq!(tsx_actions[0].action_id, "report.prepare");
        assert_eq!(
            tsx_actions[0].bot_id,
            Some("11111111-2222-3333-4444-555555555555".into())
        );

        let mut supplied = serde_json::Map::new();
        supplied.insert("topic".into(), json!("My Topic"));
        supplied.insert("includeSources".into(), json!(false));
        assert!(validate_action_input(&tsx_actions[0].payload, &supplied).is_ok());
        assert!(validate_action_input(&a2ui_actions[0].payload, &supplied).is_ok());

        supplied.insert("includeSources".into(), json!(true));
        assert!(validate_action_input(&tsx_actions[0].payload, &supplied).is_ok());
        supplied.insert("includeSources".into(), json!({"nested":true}));
        assert!(validate_action_input(&tsx_actions[0].payload, &supplied).is_err());
    }
    #[test]
    fn yaml_actions_use_the_parsed_document() {
        let doc = contract()["request_example"].clone();
        let expected = extract_a2ui_actions(&doc).unwrap();
        for path in ["forms/report.a2ui.yaml", "forms/report.a2ui.yml"] {
            let actual = extract_action_declarations(path, "a2ui: \"1.0\"", Some(&doc)).unwrap();
            assert_eq!(actual, expected);
            assert_eq!(actual[0].surface_id.as_deref(), Some("report"));
            assert_eq!(actual[0].component_id.as_deref(), Some("prepare"));
        }
    }
    #[test]
    fn repeated_a2ui_action_ids_retain_their_component_and_surface() {
        let mut doc = contract()["request_example"].clone();
        let mut other = doc["messages"][0]["createSurface"]["components"][6].clone();
        other["id"] = json!("prepare-other");
        other["action"]["event"]["context"]["payload"]["includeSources"] = json!(true);
        doc["messages"][0]["createSurface"]["components"]
            .as_array_mut()
            .unwrap()
            .push(other);
        let actions = extract_a2ui_actions(&doc).unwrap();
        let original = actions
            .iter()
            .find(|a| a.component_id.as_deref() == Some("prepare"))
            .unwrap();
        let other = actions
            .iter()
            .find(|a| a.component_id.as_deref() == Some("prepare-other"))
            .unwrap();
        assert_eq!(original.action_id, other.action_id);
        assert_eq!(original.surface_id, other.surface_id);
        assert_ne!(original.payload, other.payload);
    }
}
