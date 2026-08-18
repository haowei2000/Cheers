//! MCP tool catalog and argument mapping, both generated from
//! [`crate::registry`].
//!
//! Nothing here hand-writes a tool name, a schema, or a resource string: the
//! catalog is a projection of the registry into MCP's wire shape, and
//! [`build_resource_call`] is the same projection run backwards. Adding a tool
//! means adding a `ResourceSpec`.

use serde_json::{json, Map, Value};

use crate::registry::{self, Param, ParamKind, Shaping, ToolBinding};
use crate::ResourceCall;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallError {
    pub code: &'static str,
    pub message: String,
}

/// Remote v1 catalog. Terminal-local `inbox_stage` is intentionally absent;
/// live `read_workspace` is routed through the owner Connector by the Gateway.
pub fn definitions() -> Vec<Value> {
    registry::catalog()
        .iter()
        .filter_map(|spec| spec.tool.map(|tool| definition(&tool)))
        .collect()
}

fn definition(tool: &ToolBinding) -> Value {
    let properties: Map<String, Value> = tool
        .params
        .iter()
        .map(|param| (param.tool.to_string(), schema_for(param.kind)))
        .collect();
    let required: Vec<&str> = tool
        .params
        .iter()
        .filter(|param| param.required)
        .map(|param| param.tool)
        .collect();
    json!({
        "name": tool.name,
        "title": tool.title,
        "description": tool.description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        },
        "annotations": {
            "readOnlyHint": tool.read_only,
            "destructiveHint": tool.destructive_hint
        },
        "_meta": {"io.cheers/requiredScopes": [tool.scope]}
    })
}

fn schema_for(kind: ParamKind) -> Value {
    match kind {
        ParamKind::StringArray => json!({"type": "array", "items": {"type": "string"}}),
        other => json!({"type": other.json_type()}),
    }
}

pub fn build_resource_call(
    name: &str,
    args: &Map<String, Value>,
) -> Result<ResourceCall, ToolCallError> {
    let spec = registry::by_tool(name).ok_or_else(|| {
        error(
            "UNKNOWN_TOOL",
            format!("unknown or unavailable remote tool: {name}"),
        )
    })?;
    let tool = spec.tool.ok_or_else(|| {
        error(
            "UNKNOWN_TOOL",
            format!("unknown or unavailable remote tool: {name}"),
        )
    })?;

    let mut params = Map::new();
    for param in tool.params {
        match take(args, param)? {
            Some(value) => {
                params.insert(param.resource.to_string(), value);
            }
            None => continue,
        }
    }
    for (key, value) in tool.constants {
        params.insert((*key).to_string(), Value::String((*value).to_string()));
    }
    apply_shaping(tool.shaping, args, &mut params);

    Ok(ResourceCall {
        resource: spec.resource,
        params,
    })
}

/// Read one argument, enforcing presence and the non-empty rule the previous
/// hand-written mapper applied to `channel_id`.
fn take(args: &Map<String, Value>, param: &Param) -> Result<Option<Value>, ToolCallError> {
    let raw = args.get(param.tool);
    if param.tool == "channel_id" {
        let channel = raw
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error("BAD_ARGS", "channel_id is required"))?;
        return Ok(Some(Value::String(channel.to_string())));
    }
    match raw {
        Some(value) => Ok(Some(value.clone())),
        None if param.required => Err(error("BAD_ARGS", format!("{} is required", param.tool))),
        None => Ok(None),
    }
}

fn apply_shaping(shaping: Shaping, args: &Map<String, Value>, params: &mut Map<String, Value>) {
    match shaping {
        Shaping::None => {}
        Shaping::ContextBundle => {
            // The flat `context` argument is not a resource param; it is only
            // ever the payload of `context_bundle`, and an empty array is
            // dropped rather than sent as an empty bundle.
            params.remove("context");
            if let Some(items) = args
                .get("context")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
            {
                params.insert("context_bundle".into(), json!({ "items": items }));
            }
        }
    }
}

fn error(code: &'static str, message: impl Into<String>) -> ToolCallError {
    ToolCallError {
        code,
        message: message.into(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        required_scope_for_tool, SCOPE_FILES_WRITE, SCOPE_MEMBERSHIP_WRITE, SCOPE_MESSAGES_WRITE,
        SCOPE_PROFILE_WRITE, SCOPE_READ, SCOPE_TASK_CLAIMS_WRITE, SCOPE_WORKSPACE_WRITE,
    };

    #[test]
    fn every_remote_tool_has_exactly_one_frozen_scope() {
        for definition in definitions() {
            let name = definition["name"].as_str().unwrap();
            let scope = required_scope_for_tool(name).unwrap();
            assert_eq!(
                definition["_meta"]["io.cheers/requiredScopes"],
                json!([scope])
            );
        }
    }

    #[test]
    fn maps_message_and_workspace_writes() {
        let message = build_resource_call(
            "post_message",
            &json!({"channel_id":"c", "text":"hi"})
                .as_object()
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(message.resource, "channel.messages.create");
        assert_eq!(message.params["content"], "hi");
        let remove = build_resource_call(
            "desk_rm",
            &json!({"channel_id":"c", "path":"x"})
                .as_object()
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(remove.resource, "fs.rm");
    }

    #[test]
    fn maps_live_workspace_read_for_remote_http() {
        let call = build_resource_call(
            "read_workspace",
            &json!({
                "channel_id": "channel",
                "bot_id": "owner",
                "path": "src/lib.rs",
                "root": "/workspace"
            })
            .as_object()
            .unwrap()
            .clone(),
        )
        .unwrap();
        assert_eq!(call.resource, "workspace.read");
        assert_eq!(call.params["bot_id"], "owner");
        assert_eq!(call.params["path"], "src/lib.rs");
        assert_eq!(call.params["root"], "/workspace");
    }

    #[test]
    fn terminal_local_tools_are_not_exposed() {
        let names = definitions()
            .into_iter()
            .map(|v| v["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert!(!names.contains(&"inbox_stage".to_string()));
        assert!(names.contains(&"read_workspace".to_string()));
        assert!(build_resource_call("inbox_stage", &Map::new()).is_err());
    }

    #[test]
    fn scope_constants_match_catalog_classes() {
        assert_eq!(
            required_scope_for_tool("post_message"),
            Some(SCOPE_MESSAGES_WRITE)
        );
        assert_eq!(
            required_scope_for_tool("inbox_deliver"),
            Some(SCOPE_FILES_WRITE)
        );
        assert_eq!(
            required_scope_for_tool("desk_write"),
            Some(SCOPE_WORKSPACE_WRITE)
        );
        assert_eq!(
            required_scope_for_tool("set_status"),
            Some(SCOPE_PROFILE_WRITE)
        );
        assert_eq!(
            required_scope_for_tool("leave_channel"),
            Some(SCOPE_MEMBERSHIP_WRITE)
        );
        assert_eq!(
            required_scope_for_tool("respond_to_task_claim_evaluation"),
            Some(SCOPE_TASK_CLAIMS_WRITE)
        );
        assert_eq!(required_scope_for_tool("read_messages"), Some(SCOPE_READ));
    }
}
