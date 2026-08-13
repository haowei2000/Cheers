use serde_json::{json, Map, Value};

use crate::{required_scope_for_tool, ResourceCall};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallError {
    pub code: &'static str,
    pub message: String,
}

/// Remote v1 catalog. Terminal-local `inbox_stage` and live `read_workspace`
/// are intentionally withheld until installation routing is available.
pub fn definitions() -> Vec<Value> {
    vec![
        channel_read(
            "get_channel_info",
            "Get channel info",
            "Metadata for a channel.",
        ),
        channel_read(
            "list_members",
            "List channel members",
            "Users and Agents in a channel.",
        ),
        tool(
            "read_messages",
            "Read recent messages",
            "Read channel messages by cursor.",
            props(&[
                ("channel_id", "string"),
                ("limit", "integer"),
                ("before", "string"),
                ("after", "string"),
                ("since_seq", "integer"),
            ]),
            &["channel_id"],
            true,
            false,
        ),
        channel_read(
            "messages_index",
            "Get message sequence index",
            "Get channel message sequence bounds.",
        ),
        tool(
            "messages_by_seq",
            "Read messages by channel sequence",
            "Read messages in a channel sequence range.",
            props(&[
                ("channel_id", "string"),
                ("min_seq", "integer"),
                ("max_seq", "integer"),
                ("limit", "integer"),
            ]),
            &["channel_id", "min_seq"],
            true,
            false,
        ),
        tool(
            "search_messages",
            "Search channel messages",
            "Search finalized message content.",
            props(&[
                ("channel_id", "string"),
                ("query", "string"),
                ("limit", "integer"),
                ("before", "string"),
            ]),
            &["channel_id", "query"],
            true,
            false,
        ),
        tool(
            "read_activity",
            "Read channel activity",
            "Read the ordered channel activity stream.",
            props(&[
                ("channel_id", "string"),
                ("since_seq", "integer"),
                ("limit", "integer"),
            ]),
            &["channel_id"],
            true,
            false,
        ),
        channel_read(
            "get_context",
            "Get channel context",
            "Read the condensed channel context.",
        ),
        channel_read(
            "read_plan",
            "Read channel plan",
            "Read the live channel plan.",
        ),
        channel_read(
            "read_sessions",
            "List channel Agent sessions",
            "Read Agent sessions in a channel.",
        ),
        channel_read(
            "read_cost",
            "Read channel usage",
            "Read token usage and cost totals.",
        ),
        tool(
            "leave_channel",
            "Leave a channel",
            "Remove this Bot from a non-DM channel.",
            channel_props(),
            &["channel_id"],
            false,
            true,
        ),
        tool(
            "open_direct_message",
            "Open a direct message",
            "Open an eligible one-to-one DM.",
            props(&[("target_user_id", "string")]),
            &["target_user_id"],
            false,
            false,
        ),
        channel_read(
            "inbox_list",
            "List channel attachments",
            "List files uploaded to channel chat.",
        ),
        tool(
            "inbox_open",
            "Open a channel attachment",
            "Read one channel attachment.",
            props(&[
                ("channel_id", "string"),
                ("file_id", "string"),
                ("as_base64", "boolean"),
            ]),
            &["channel_id", "file_id"],
            true,
            false,
        ),
        tool(
            "post_message",
            "Post a message",
            "Send or reply to a channel message.",
            props(&[
                ("channel_id", "string"),
                ("text", "string"),
                ("mention_ids", "array"),
                ("mention_names", "array"),
                ("reply_to_msg_id", "string"),
                ("context", "array"),
            ]),
            &["channel_id", "text"],
            false,
            false,
        ),
        tool(
            "set_status",
            "Update Bot status",
            "Update this Bot's own status/profile card.",
            props(&[
                ("status_text", "string"),
                ("status_emoji", "string"),
                ("info", "string"),
            ]),
            &[],
            false,
            false,
        ),
        tool(
            "inbox_deliver",
            "Deliver a channel attachment",
            "Upload a base64-encoded attachment.",
            props(&[
                ("channel_id", "string"),
                ("filename", "string"),
                ("data_b64", "string"),
                ("content_type", "string"),
            ]),
            &["channel_id", "filename", "data_b64"],
            false,
            false,
        ),
        tool(
            "desk_list",
            "List Desk files",
            "List Cheers Desk files under a path.",
            props(&[("channel_id", "string"), ("path", "string")]),
            &["channel_id"],
            true,
            false,
        ),
        tool(
            "desk_read",
            "Read a Desk file",
            "Read a Cheers Desk file.",
            props(&[("channel_id", "string"), ("path", "string")]),
            &["channel_id", "path"],
            true,
            false,
        ),
        tool(
            "desk_write",
            "Write a Desk file",
            "Create or overwrite a Cheers Desk file.",
            props(&[
                ("channel_id", "string"),
                ("path", "string"),
                ("content", "string"),
                ("if_version", "integer"),
                ("is_dir", "boolean"),
            ]),
            &["channel_id", "path", "content"],
            false,
            false,
        ),
        tool(
            "desk_edit",
            "Edit a Desk file",
            "Replace one exact string in a Desk file.",
            props(&[
                ("channel_id", "string"),
                ("path", "string"),
                ("old_string", "string"),
                ("new_string", "string"),
                ("if_version", "integer"),
            ]),
            &["channel_id", "path", "old_string", "new_string"],
            false,
            false,
        ),
        tool(
            "desk_append",
            "Append to a Desk file",
            "Append text to a Desk file.",
            props(&[
                ("channel_id", "string"),
                ("path", "string"),
                ("content", "string"),
            ]),
            &["channel_id", "path", "content"],
            false,
            false,
        ),
        tool(
            "desk_rm",
            "Remove a Desk path",
            "Remove a Desk file or subtree.",
            props(&[
                ("channel_id", "string"),
                ("path", "string"),
                ("recursive", "boolean"),
            ]),
            &["channel_id", "path"],
            false,
            true,
        ),
        tool(
            "desk_mv",
            "Move a Desk path",
            "Move or rename a Desk file or subtree.",
            props(&[
                ("channel_id", "string"),
                ("from", "string"),
                ("to", "string"),
            ]),
            &["channel_id", "from", "to"],
            false,
            false,
        ),
        tool(
            "respond_to_task_claim_evaluation",
            "Respond to a task evaluation",
            "Record this Bot's assigned task-claim decision.",
            props(&[
                ("channel_id", "string"),
                ("evaluation_id", "string"),
                ("decision", "string"),
                ("confidence", "number"),
            ]),
            &["channel_id", "evaluation_id", "decision"],
            false,
            false,
        ),
        tool(
            "list_task_claims",
            "List task claims",
            "List proactive task claims in a channel.",
            props(&[
                ("channel_id", "string"),
                ("status", "string"),
                ("limit", "integer"),
            ]),
            &["channel_id"],
            true,
            false,
        ),
    ]
}

pub fn build_resource_call(
    name: &str,
    args: &Map<String, Value>,
) -> Result<ResourceCall, ToolCallError> {
    let simple_channel = match name {
        "get_channel_info" => Some("channel.info"),
        "list_members" => Some("channel.members"),
        "messages_index" => Some("channel.messages.index"),
        "get_context" => Some("channel.context"),
        "read_plan" => Some("channel.plan.read"),
        "read_sessions" => Some("channel.sessions.read"),
        "read_cost" => Some("channel.usage.read"),
        "inbox_list" => Some("channel.files"),
        "leave_channel" => Some("channel.leave"),
        "desk_list" => Some("fs.ls"),
        _ => None,
    };
    if let Some(resource) = simple_channel {
        let mut params = Map::new();
        params.insert("channel_id".into(), Value::String(channel(args)?));
        if name == "desk_list" {
            optional(args, &mut params, "path", "path");
        }
        return Ok(ResourceCall { resource, params });
    }

    let mut params = Map::new();
    let resource = match name {
        "read_messages" => {
            add_channel(args, &mut params)?;
            optionals(
                args,
                &mut params,
                &["limit", "before", "after", "since_seq"],
            );
            "channel.messages"
        }
        "messages_by_seq" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "min_seq", "min_seq")?;
            optionals(args, &mut params, &["max_seq", "limit"]);
            "channel.messages.by-seq"
        }
        "search_messages" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "query", "query")?;
            optionals(args, &mut params, &["limit", "before"]);
            "channel.messages.search"
        }
        "read_activity" => {
            add_channel(args, &mut params)?;
            optionals(args, &mut params, &["since_seq", "limit"]);
            "channel.activity.read"
        }
        "open_direct_message" => {
            required(args, &mut params, "target_user_id", "target_user_id")?;
            "dm.open"
        }
        "inbox_open" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "file_id", "file_id")?;
            optional(args, &mut params, "as_base64", "as_base64");
            "channel.files.read"
        }
        "post_message" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "text", "content")?;
            params.insert("msg_type".into(), Value::String("text".into()));
            optionals(
                args,
                &mut params,
                &["mention_ids", "mention_names", "reply_to_msg_id"],
            );
            if let Some(items) = args
                .get("context")
                .and_then(Value::as_array)
                .filter(|v| !v.is_empty())
            {
                params.insert("context_bundle".into(), json!({"items": items}));
            }
            "channel.messages.create"
        }
        "set_status" => {
            optionals(args, &mut params, &["status_text", "status_emoji", "info"]);
            "bot.status.write"
        }
        "inbox_deliver" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "filename", "filename")?;
            required(args, &mut params, "data_b64", "data_b64")?;
            optional(args, &mut params, "content_type", "content_type");
            "channel.files.create"
        }
        "desk_read" => desk_path(args, &mut params, "fs.read")?,
        "desk_write" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "path", "path")?;
            required(args, &mut params, "content", "content")?;
            optionals(args, &mut params, &["if_version", "is_dir"]);
            "fs.write"
        }
        "desk_edit" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "path", "path")?;
            required(args, &mut params, "old_string", "old_string")?;
            required(args, &mut params, "new_string", "new_string")?;
            optional(args, &mut params, "if_version", "if_version");
            "fs.edit"
        }
        "desk_append" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "path", "path")?;
            required(args, &mut params, "content", "content")?;
            "fs.append"
        }
        "desk_rm" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "path", "path")?;
            optional(args, &mut params, "recursive", "recursive");
            "fs.rm"
        }
        "desk_mv" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "from", "from")?;
            required(args, &mut params, "to", "to")?;
            "fs.mv"
        }
        "respond_to_task_claim_evaluation" => {
            add_channel(args, &mut params)?;
            required(args, &mut params, "evaluation_id", "evaluation_id")?;
            required(args, &mut params, "decision", "decision")?;
            optional(args, &mut params, "confidence", "confidence");
            "channel.task_claims.evaluate"
        }
        "list_task_claims" => {
            add_channel(args, &mut params)?;
            optionals(args, &mut params, &["status", "limit"]);
            "channel.task_claims.list"
        }
        _ => {
            return Err(error(
                "UNKNOWN_TOOL",
                format!("unknown or unavailable remote tool: {name}"),
            ))
        }
    };
    Ok(ResourceCall { resource, params })
}

fn channel_read(name: &str, title: &str, description: &str) -> Value {
    tool(
        name,
        title,
        description,
        channel_props(),
        &["channel_id"],
        true,
        false,
    )
}

fn tool(
    name: &str,
    title: &str,
    description: &str,
    properties: Map<String, Value>,
    required: &[&str],
    read_only: bool,
    destructive: bool,
) -> Value {
    let scope = required_scope_for_tool(name).expect("remote tool must have a frozen scope");
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": false},
        "annotations": {"readOnlyHint": read_only, "destructiveHint": destructive},
        "_meta": {"io.cheers/requiredScopes": [scope]}
    })
}

fn channel_props() -> Map<String, Value> {
    props(&[("channel_id", "string")])
}

fn props(items: &[(&str, &str)]) -> Map<String, Value> {
    items
        .iter()
        .map(|(name, kind)| {
            let schema = if *kind == "array" {
                json!({"type": "array", "items": {"type": "string"}})
            } else {
                json!({"type": kind})
            };
            ((*name).to_string(), schema)
        })
        .collect()
}

fn channel(args: &Map<String, Value>) -> Result<String, ToolCallError> {
    args.get("channel_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| error("BAD_ARGS", "channel_id is required"))
}

fn add_channel(
    args: &Map<String, Value>,
    params: &mut Map<String, Value>,
) -> Result<(), ToolCallError> {
    params.insert("channel_id".into(), Value::String(channel(args)?));
    Ok(())
}

fn desk_path(
    args: &Map<String, Value>,
    params: &mut Map<String, Value>,
    resource: &'static str,
) -> Result<&'static str, ToolCallError> {
    add_channel(args, params)?;
    required(args, params, "path", "path")?;
    Ok(resource)
}

fn required(
    args: &Map<String, Value>,
    params: &mut Map<String, Value>,
    from: &str,
    to: &str,
) -> Result<(), ToolCallError> {
    let value = args
        .get(from)
        .cloned()
        .ok_or_else(|| error("BAD_ARGS", format!("{from} is required")))?;
    params.insert(to.to_string(), value);
    Ok(())
}

fn optional(args: &Map<String, Value>, params: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = args.get(from) {
        params.insert(to.to_string(), value.clone());
    }
}

fn optionals(args: &Map<String, Value>, params: &mut Map<String, Value>, names: &[&str]) {
    for name in names {
        optional(args, params, name, name);
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
        SCOPE_FILES_WRITE, SCOPE_MEMBERSHIP_WRITE, SCOPE_MESSAGES_WRITE, SCOPE_PROFILE_WRITE,
        SCOPE_READ, SCOPE_TASK_CLAIMS_WRITE, SCOPE_WORKSPACE_WRITE,
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
    fn terminal_local_tools_are_not_exposed() {
        let names = definitions()
            .into_iter()
            .map(|v| v["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert!(!names.contains(&"inbox_stage".to_string()));
        assert!(!names.contains(&"read_workspace".to_string()));
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
