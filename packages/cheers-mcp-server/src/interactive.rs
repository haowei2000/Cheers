//! Shared interactive-resource discovery and validated user-action context.
//! A2UI remains a content format; reads/writes and prompts use existing handlers.
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

pub fn contract() -> Value {
    json!({"version": VERSION, "catalog_id": CATALOG_ID, "guide": GUIDE,
        "catalog": serde_json::from_str::<Value>(CATALOG).expect("embedded catalog"),
        "example": serde_json::from_str::<Value>(EXAMPLE).expect("embedded example"),
        "request_example": request_example("00000000-0000-0000-0000-000000000001")})
}
pub fn contract_for_bot(bot_id: &str) -> Value {
    let mut contract = contract();
    contract["request_example"] = request_example(bot_id);
    contract
}
/// Build the request example from the canonical fixture. The gateway binds its
/// target to the authenticated Bot, so a connected agent need not guess its id.
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
                        if crate::locator::parse(uri).is_none() {
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

/// Persisted, user-authored event. No executable command or trusted instruction.
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
    if event["v"] != 1
        || !matches!(
            crate::locator::parse(event["sourceUri"].as_str().unwrap_or("")),
            Some(crate::locator::Locator::Desk { .. })
        )
    {
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
}
