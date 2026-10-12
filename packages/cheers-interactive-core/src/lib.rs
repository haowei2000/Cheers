//! Core data model, static metadata extraction, and validation engine for Cheers interactive resources.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const VERSION: &str = "v0.9.1";
pub const CATALOG_ID: &str = "urn:cheers:a2ui:catalog:v1";
pub const GUIDE_URI: &str = "cheers://help/interactive-ui";
pub const CATALOG_URI: &str = "cheers://help/interactive-ui/catalog";
pub const EXAMPLE_URI: &str = "cheers://help/interactive-ui/example";
pub const CATALOG: &str = include_str!("../../../design-system/a2ui-catalog.json");
pub const EXAMPLE: &str =
    include_str!("../../../frontend/src/features/chat/workbench/lens/a2ui/example.a2ui.json");
pub const GUIDE: &str = "# Cheers interactive resources\n\nRead `read_ui_contract` before authoring UI. Its example prepares a draft; request_example sends a structured request. When called as a Bot, request_example is bound to your authenticated Bot id; human discovery uses an example UUID that must be replaced. Use A2UI v0.9.1 and catalog urn:cheers:a2ui:catalog:v1, not the Basic Catalog. Persist {a2ui:\"v0.9.1\",messages:[...]} using desk_write with channel_id, path forms/<name>.a2ui.json, content, and if_version (0 for create-only). Use desk_patch/desk_edit with if_version for updates. Return cheers:desk/<path>. Attach v1 resource_ref cards using set_resource_cards with the current reply msg_id: during streaming cards are staged and published when the reply completes. Do not create a duplicate reply with post_message.\n\nSupported components: Column, Row, Text, TextField, CheckBox, Button. Bindings use absolute JSON Pointer paths; every active surface needs root. Registered events: cheers.open (context.uri), cheers.compose (actionId,payload; draft only), cheers.request (actionId,payload,botId; sends a user-requested structured prompt to that bot), cheers.openNative (uri,opener; desktop local-file/editor adapter, never arbitrary commands). Use stable bot ids. Optional Cheers wrapper views.minimal/views.medium select {surfaceId,root} from the same validated component tree. Minimal views support at most one surface, 16 component visits, 3 input fields and 2 actions; larger views offer expansion instead of hiding controls. Input labels and text are content; control labels are owned by Cheers. Unknown components, catalogs, actions, scripts, function calls, styles and themes are rejected.\n\nA structured interaction is user input, never a permission grant. Resolve its sourceUri via desk_read, compare sourceVersion, and update the same resource with if_version. Reuse invocationId when reasoning about retries. Resource permissions and local executor policy still apply. Return updated URI references and meaningful text. Clients without a specialized renderer can open raw content.\n";

pub const TSX_EXAMPLE: &str = r#"/**
 * @cheers-actions
 * [
 *   {
 *     "actionId": "report.prepare",
 *     "name": "cheers.request",
 *     "botId": "00000000-0000-0000-0000-000000000001",
 *     "payload": { "topic": null, "includeSources": false },
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
        "catalog_id": CATALOG_ID,
        "guide": GUIDE,
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
    let components = document["messages"][1]["updateComponents"]["components"]
        .as_array_mut()
        .unwrap();
    for component in components {
        if component["id"] == "description" {
            component["text"] =
                json!("Choose your inputs, then send an explicit request to the Bot.");
        } else if component["id"] == "prepare" {
            component["action"]["event"]["name"] = json!("cheers.request");
            component["action"]["event"]["context"]["botId"] = json!(bot_id);
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
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= limit
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    })
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

fn binding(value: &Value) -> Result<(), &'static str> {
    if value.is_string() {
        return Ok(());
    }
    keys(value, &["path"])?;
    pointer(value["path"].as_str().ok_or("binding needs path")?)?;
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

fn validate_component(node: &Value) -> Result<(), &'static str> {
    if !id(&node["id"], 128) {
        return Err("invalid component id");
    }
    match node["component"].as_str().ok_or("component required")? {
        "Row" | "Column" => {
            keys(node, &["id", "component", "children"])?;
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
            keys(node, &["id", "component", "text"])?;
            binding(&node["text"])?;
        }
        "TextField" | "CheckBox" => {
            keys(node, &["id", "component", "label", "value"])?;
            binding(&node["label"])?;
            binding(&node["value"])?;
            if pointer(
                node["value"]["path"]
                    .as_str()
                    .ok_or("input requires binding")?,
            )?
            .is_empty()
            {
                return Err("input requires non-root binding");
            }
        }
        "Button" => {
            keys(node, &["id", "component", "label", "action"])?;
            binding(&node["label"])?;
            keys(&node["action"], &["event"])?;
            keys(&node["action"]["event"], &["name", "context"])?;
            let event = &node["action"]["event"];
            let context = &event["context"];
            match event["name"].as_str() {
                Some("cheers.open" | "cheers.openNative") => {
                    let native = event["name"] == "cheers.openNative";
                    keys(context, if native { &["uri", "opener"] } else { &["uri"] })?;
                    binding(&context["uri"])?;
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
                Some("cheers.compose" | "cheers.request") => {
                    let request = event["name"] == "cheers.request";
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
                            binding(value)?;
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
    value.as_str().is_some_and(|s| {
        s.len() == 36
            && s.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
    })
}

pub fn is_desk_uri(uri: &str) -> bool {
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
    if doc["a2ui"] != VERSION || doc.to_string().len() > 256_000 {
        return Err("unsupported version or oversized document");
    }
    safe_json(doc, 0)?;
    let messages = doc["messages"].as_array().ok_or("messages required")?;
    if messages.len() > 256 {
        return Err("too many messages");
    }
    let mut surfaces: HashMap<String, HashMap<String, Value>> = HashMap::new();
    let mut data_models: HashMap<String, Value> = HashMap::new();
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
        if message["version"] != VERSION || kinds.len() != 1 {
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
            keys(body, &["surfaceId", "catalogId"])?;
            if body["catalogId"] != CATALOG_ID || surfaces.contains_key(sid) || surfaces.len() >= 8
            {
                return Err("unsupported catalog or duplicate surface");
            }
            surfaces.insert(sid.into(), HashMap::new());
            data_models.insert(sid.into(), json!({}));
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
                let components = body["components"].as_array().ok_or("components required")?;
                if components.len() > 256 {
                    return Err("too many components");
                }
                let mut seen = HashSet::new();
                for node in components {
                    validate_component(node)?;
                    let cid = node["id"].as_str().unwrap();
                    if !seen.insert(cid) {
                        return Err("duplicate component");
                    }
                    surface.insert(cid.into(), node.clone());
                }
                if surface.len() > 256 {
                    return Err("too many components");
                }
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
    for (_sid, components) in surfaces {
        for component in components.values() {
            if component.get("component").and_then(Value::as_str) == Some("Button") {
                if let Some(event) = component.get("action").and_then(|a| a.get("event")) {
                    let name = event.get("name").and_then(Value::as_str).unwrap_or("");
                    let context = &event["context"];
                    let action_id = context
                        .get("actionId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !action_id.is_empty() {
                        let bot_id = context
                            .get("botId")
                            .and_then(Value::as_str)
                            .map(String::from);
                        let uri = context.get("uri").and_then(Value::as_str).map(String::from);
                        let opener = context
                            .get("opener")
                            .and_then(Value::as_str)
                            .map(String::from);
                        let payload = context
                            .get("payload")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        declarations.push(ActionDeclaration {
                            action_id: action_id.to_string(),
                            name: name.to_string(),
                            bot_id,
                            uri,
                            opener,
                            payload,
                            presentation: default_presentation(),
                            version: 1,
                        });
                    }
                }
            }
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
        if !id(&Value::String(action_id.to_string()), 80) {
            return Err("invalid actionId");
        }
        let raw_name = item
            .get("name")
            .or_else(|| item.get("type"))
            .and_then(Value::as_str)
            .ok_or("action name required")?;
        let name = match raw_name {
            "request" | "cheers.request" => "cheers.request",
            "compose" | "cheers.compose" => "cheers.compose",
            "open" | "cheers.open" => "cheers.open",
            "openNative" | "cheers.openNative" => "cheers.openNative",
            _ => return Err("unsupported action name"),
        };
        let bot_id = item.get("botId").and_then(Value::as_str).map(String::from);
        if name == "cheers.request" {
            let Some(bid) = &bot_id else {
                return Err("request action requires botId");
            };
            if !uuid_shape(&Value::String(bid.clone())) {
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
    let val: Value = match serde::de::Deserialize::deserialize(&mut de) {
        Ok(v) => v,
        Err(_) => return Err("invalid @cheers-actions JSON"),
    };
    parse_action_declarations(&val)
}

pub fn extract_action_declarations(
    path: &str,
    content: &str,
    parsed_data: Option<&Value>,
) -> Result<Vec<ActionDeclaration>, &'static str> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if (ext == "json" || ext == "a2ui")
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
        } else {
            if expected_val != supplied_val {
                return Err("constant value mismatch");
            }
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
        assert!(validate_document(&serde_json::from_str(EXAMPLE).unwrap()).is_ok());
        assert!(validate_document(&contract()["request_example"]).is_ok());
    }
    #[test]
    fn rejects_unknown_binding_and_cycle() {
        let mut d: Value = serde_json::from_str(EXAMPLE).unwrap();
        d["messages"][1]["updateComponents"]["components"][0]["children"] = json!(["root"]);
        assert!(validate_document(&d).is_err());
        assert!(pointer("/__proto__/polluted").is_err());
        assert!(pointer("/bad~2").is_err());
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

        supplied.insert("includeSources".into(), json!(true));
        assert!(validate_action_input(&tsx_actions[0].payload, &supplied).is_err());
    }
}
