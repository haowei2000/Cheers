use std::env;
use std::io::{self, BufRead, Write};
use std::time::Duration;

use anyhow::Context;
use reqwest::Client;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
struct ServerConfig {
    resource_url: String,
    resource_token: Option<String>,
    bot_id: Option<String>,
    request_timeout_ms: u64,
}

#[derive(Debug, Clone)]
struct CheersClient {
    http: Client,
    config: ServerConfig,
}

#[derive(Debug)]
struct ResourceError {
    code: String,
    message: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = load_config()?;
    let client = CheersClient {
        http: Client::builder()
            .timeout(Duration::from_millis(config.request_timeout_ms))
            .build()?,
        config,
    };
    eprintln!(
        "[cheers-mcp] ready (bot={})",
        client.config.bot_id.as_deref().unwrap_or("?"),
    );
    serve_stdio(client).await
}

fn load_config() -> anyhow::Result<ServerConfig> {
    let resource_url = env::var("CHEERS_RESOURCE_URL")
        .context("CHEERS_RESOURCE_URL is required (connector loopback resource endpoint)")?;
    let request_timeout_ms = env::var("CHEERS_REQUEST_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000);
    Ok(ServerConfig {
        resource_url,
        resource_token: empty_to_none(env::var("CHEERS_RESOURCE_TOKEN").ok()),
        bot_id: empty_to_none(env::var("CHEERS_BOT_ID").ok()),
        request_timeout_ms,
    })
}

fn empty_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

async fn serve_stdio(client: CheersClient) -> anyhow::Result<()> {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(err) => {
                write_message(&json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": {"code": -32700, "message": format!("Parse error: {err}")},
                }))?;
                continue;
            }
        };
        if request.get("id").is_none() {
            continue;
        }
        let response = handle_request(&client, &request).await;
        write_message(&response)?;
    }
    Ok(())
}

fn write_message(value: &Value) -> anyhow::Result<()> {
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", serde_json::to_string(value)?)?;
    stdout.flush()?;
    Ok(())
}

async fn handle_request(client: &CheersClient, request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => Ok(initialize_result()),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            handle_tool_call(client, request.get("params").unwrap_or(&Value::Null)).await
        }
        _ => Err(json_rpc_error(
            -32601,
            &format!("method not found: {method}"),
        )),
    };
    match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "cheers",
            "version": env!("CARGO_PKG_VERSION")
        },
        // Mental model handed to the agent so it never confuses the two file areas.
        "instructions": "You have two separate places for files in each channel, and they are DIFFERENT:\n\
            • DESK (desk_* tools) = YOUR private, editable workspace — notes, boards, plans, prompts — addressed by PATH (e.g. \"progress.md\"). You read and write these freely.\n\
            • INBOX (inbox_* tools) = files PEOPLE uploaded in the chat (PDF, CSV, images), addressed by FILE_ID (a uuid). They are READ-ONLY and you can never edit them. To hand a finished file back to people as a new attachment, use inbox_deliver (not desk_write — desk files are your private workspace).\n\
            Rule of thumb: if you're thinking in a PATH it's the desk; if you're holding a FILE_ID it's the inbox. Never desk_write a file_id, and never inbox_open a path. To work on an uploaded file, inbox_open it, then desk_write its content into your workspace."
    })
}

async fn handle_tool_call(client: &CheersClient, params: &Value) -> Result<Value, Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| json_rpc_error(-32602, "tools/call requires params.name"))?;
    let args = params
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let resource_call = build_resource_call(client, name, &args)
        .map_err(|err| tool_error_result(&err.code, &err.message))?;

    match client
        .call(&resource_call.resource, resource_call.params)
        .await
    {
        Ok(data) => Ok(tool_text_result(
            &serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string()),
        )),
        Err(err) => Ok(tool_error_result(&err.code, &err.message)),
    }
}

#[derive(Debug)]
struct ResourceCall {
    resource: &'static str,
    params: Map<String, Value>,
}

impl CheersClient {
    async fn call(
        &self,
        resource: &str,
        params: Map<String, Value>,
    ) -> Result<Value, ResourceError> {
        let body = json!({ "resource": resource, "params": params });
        let mut request = self.http.post(&self.config.resource_url).json(&body);
        if let Some(token) = &self.config.resource_token {
            request = request
                .bearer_auth(token)
                .header("X-Cheers-Loopback-Token", token);
        }
        let response = request.send().await.map_err(|err| ResourceError {
            code: if err.is_timeout() {
                "IPC_TIMEOUT".to_string()
            } else {
                "IPC_UNAVAILABLE".to_string()
            },
            message: if err.is_timeout() {
                "connector IPC timed out".to_string()
            } else {
                err.to_string()
            },
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(ResourceError {
                code: format!("IPC_HTTP_{}", status.as_u16()),
                message: format!("connector IPC returned {}", status.as_u16()),
            });
        }
        let body: Value = response.json().await.map_err(|err| ResourceError {
            code: "IPC_BAD_JSON".to_string(),
            message: err.to_string(),
        })?;
        if body.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            Ok(body.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(ResourceError {
                code: body
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("UNKNOWN")
                    .to_string(),
                message: body
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("resource call failed")
                    .to_string(),
            })
        }
    }

    fn resolve_channel(&self, args: &Map<String, Value>) -> Result<String, ResourceError> {
        // channel_id is always required in tool arguments; there is no
        // default env-based channel. The ACP agent is responsible for
        // passing the correct channel_id from the task context.
        args.get("channel_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_string())
            .ok_or_else(|| ResourceError {
                code: "NO_CHANNEL".to_string(),
                message:
                    "channel_id is required. The ACP agent must pass it from the task context."
                        .to_string(),
            })
    }
}

fn build_resource_call(
    client: &CheersClient,
    tool: &str,
    args: &Map<String, Value>,
) -> Result<ResourceCall, ResourceError> {
    match tool {
        "get_channel_info" => with_channel(client, args, "channel.info"),
        "list_members" => with_channel(client, args, "channel.members"),
        "messages_index" => with_channel(client, args, "channel.messages.index"),
        "get_context" => with_channel(client, args, "channel.context"),
        "inbox_list" => with_channel(client, args, "channel.files"),
        "read_messages" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_optional(args, &mut params, "limit", "limit");
            copy_optional(args, &mut params, "before", "before");
            copy_optional(args, &mut params, "after", "after");
            copy_optional(args, &mut params, "since_seq", "since_seq");
            Ok(ResourceCall {
                resource: "channel.messages",
                params,
            })
        }
        "messages_by_seq" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "min_seq", "min_seq")?;
            copy_optional(args, &mut params, "max_seq", "max_seq");
            copy_optional(args, &mut params, "limit", "limit");
            Ok(ResourceCall {
                resource: "channel.messages.by-seq",
                params,
            })
        }
        "read_activity" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_optional(args, &mut params, "since_seq", "since_seq");
            copy_optional(args, &mut params, "limit", "limit");
            Ok(ResourceCall {
                resource: "channel.activity.read",
                params,
            })
        }
        "inbox_open" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "file_id", "file_id")?;
            Ok(ResourceCall {
                resource: "channel.files.read",
                params,
            })
        }
        "post_message" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "text", "content")?;
            params.insert("msg_type".to_string(), Value::String("text".to_string()));
            copy_optional(args, &mut params, "mention_names", "mention_names");
            copy_optional(args, &mut params, "mention_ids", "mention_ids");
            copy_optional(args, &mut params, "reply_to_msg_id", "reply_to_msg_id");
            Ok(ResourceCall {
                resource: "channel.messages.create",
                params,
            })
        }
        "inbox_deliver" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "filename", "filename")?;
            copy_required(args, &mut params, "data_b64", "data_b64")?;
            copy_optional(args, &mut params, "content_type", "content_type");
            Ok(ResourceCall {
                resource: "channel.files.create",
                params,
            })
        }
        "desk_list" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            params.insert(
                "path".to_string(),
                args.get("path")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
            Ok(ResourceCall {
                resource: "fs.ls",
                params,
            })
        }
        "desk_read" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "path", "path")?;
            Ok(ResourceCall {
                resource: "fs.read",
                params,
            })
        }
        "desk_write" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "path", "path")?;
            copy_required(args, &mut params, "content", "content")?;
            copy_optional(args, &mut params, "if_version", "if_version");
            copy_optional(args, &mut params, "is_dir", "is_dir");
            Ok(ResourceCall {
                resource: "fs.write",
                params,
            })
        }
        "desk_edit" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "path", "path")?;
            copy_required(args, &mut params, "old_string", "old_string")?;
            copy_required(args, &mut params, "new_string", "new_string")?;
            copy_optional(args, &mut params, "if_version", "if_version");
            Ok(ResourceCall {
                resource: "fs.edit",
                params,
            })
        }
        "desk_append" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "path", "path")?;
            copy_required(args, &mut params, "content", "content")?;
            Ok(ResourceCall {
                resource: "fs.append",
                params,
            })
        }
        "desk_rm" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "path", "path")?;
            copy_optional(args, &mut params, "recursive", "recursive");
            Ok(ResourceCall {
                resource: "fs.rm",
                params,
            })
        }
        "desk_mv" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "from", "from")?;
            copy_required(args, &mut params, "to", "to")?;
            Ok(ResourceCall {
                resource: "fs.mv",
                params,
            })
        }
        _ => Err(ResourceError {
            code: "UNKNOWN_TOOL".to_string(),
            message: format!("unknown tool: {tool}"),
        }),
    }
}

fn with_channel(
    client: &CheersClient,
    args: &Map<String, Value>,
    resource: &'static str,
) -> Result<ResourceCall, ResourceError> {
    let mut params = Map::new();
    params.insert(
        "channel_id".to_string(),
        Value::String(client.resolve_channel(args)?),
    );
    Ok(ResourceCall { resource, params })
}

fn copy_optional(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    from: &str,
    to: &str,
) {
    if let Some(value) = source.get(from) {
        target.insert(to.to_string(), value.clone());
    }
}

fn copy_required(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    from: &str,
    to: &str,
) -> Result<(), ResourceError> {
    let value = source.get(from).cloned().ok_or_else(|| ResourceError {
        code: "BAD_ARGS".to_string(),
        message: format!("{from} is required"),
    })?;
    target.insert(to.to_string(), value);
    Ok(())
}

fn tool_text_result(text: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }]
    })
}

fn tool_error_result(code: &str, message: &str) -> Value {
    json!({
        "isError": true,
        "content": [{ "type": "text", "text": format!("[{code}] {message}") }]
    })
}

fn json_rpc_error(code: i64, message: &str) -> Value {
    json!({ "code": code, "message": message })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool("get_channel_info", "Get channel info", "Metadata for a channel: name, type, workspace.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("list_members", "List channel members", "Users and bots that are members of the channel.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("read_messages", "Read recent messages", "Read channel messages by pagination cursor or channel_seq cursor.", object_schema(vec![
            channel_id_prop(),
            number_prop("limit", "Default 50, max 200.", Some(1), Some(200)),
            string_prop("before", "Return messages before this msg_id."),
            string_prop("after", "Return messages after this msg_id."),
            number_prop("since_seq", "Return messages with channel_seq greater than this value.", Some(0), None),
        ], vec!["channel_id"]), true, false),
        tool("messages_index", "Get message sequence index", "Return min_seq, max_seq, and count for finalized channel messages.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("messages_by_seq", "Read messages by channel_seq", "Fetch finalized channel messages in an inclusive channel_seq range.", object_schema(vec![
            channel_id_prop(),
            number_prop("min_seq", "Inclusive lower channel_seq.", Some(1), None),
            number_prop("max_seq", "Inclusive upper channel_seq.", Some(1), None),
            number_prop("limit", "Default 50, max 200.", Some(1), Some(200)),
        ], vec!["channel_id", "min_seq"]), true, false),
        tool("read_activity", "Read channel activity", "Read the unified channel_seq event stream: messages plus channel operations.", object_schema(vec![
            channel_id_prop(),
            number_prop("since_seq", "Return events with channel_seq greater than this value.", Some(0), None),
            number_prop("limit", "Default 50, max 200.", Some(1), Some(200)),
        ], vec!["channel_id"]), true, false),
        tool("get_context", "Get channel context", "Condensed channel context bundle (topic, pinned info, summary).", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("inbox_list", "List chat attachments (inbox)", "List files people UPLOADED to this channel's chat (pdf/csv/images/docx). Each has a FILE_ID (uuid); open one with inbox_open. Read-only; these are NOT your workspace files — save your own work with desk_* instead.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("inbox_open", "Open a chat attachment by file_id", "Open a channel attachment by its FILE_ID (from inbox_list). Text files (csv/txt/md/json) return content; binaries (image/pdf/docx) return kind:\"binary\" + a download_url, never raw bytes. Attachments are read-only — to edit, copy the content into your workspace with desk_write.", object_schema(vec![
            channel_id_prop(),
            string_prop("file_id", "File id from inbox_list."),
        ], vec!["channel_id", "file_id"]), true, false),
        tool("post_message", "Post a message", "Send a message to a channel. Use this for proactive / cross-channel posts; the reply to the triggering message goes through the normal agent reply flow, not this tool.", object_schema(vec![
            channel_id_prop(),
            string_prop("text", "Message body (markdown)."),
            array_string_prop("mention_names", "Members to @mention by username or display name. Gateway resolves to UUIDs."),
            string_prop("reply_to_msg_id", "msg_id to reply to (threaded reply)."),
        ], vec!["channel_id", "text"]), false, false),
        tool("inbox_deliver", "Deliver a file to the channel", "Post a NEW file (base64 bytes, <=8MB) into this channel's chat as an attachment people can see and download. For deliverables you hand to people — not your own working notes (use desk_write for those). One-shot, no overwrite; returns the new file_id.", object_schema(vec![
            channel_id_prop(),
            string_prop("filename", "File name."),
            string_prop("data_b64", "Base64 of the raw file bytes."),
            string_prop("content_type", "MIME type."),
        ], vec!["channel_id", "filename", "data_b64"]), false, false),
        tool("desk_list", "List my workspace (desk) files", "List MY editable workspace files (\"the desk\") under a PATH prefix in this channel — my private working area (notes/boards/plans). NOT chat attachments; for those use inbox_list.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "Path prefix. Omit or empty string for root."),
        ], vec!["channel_id"]), true, false),
        tool("desk_read", "Read a workspace (desk) file", "Read one of MY workspace files by PATH (e.g. \"progress.md\"); returns text + version. For a file someone uploaded in chat, use inbox_open with its file_id instead.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
        ], vec!["channel_id", "path"]), true, false),
        tool("desk_write", "Write a workspace (desk) file", "Create or overwrite one of MY workspace files by PATH (text, <=256KB). if_version for optimistic lock (0 = create-only). Cannot write chat attachments — they are read-only.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
            string_prop("content", "Full file content."),
            number_prop("if_version", "Expected current version. Use 0 for create-only.", Some(0), None),
            bool_prop("is_dir", "Optional: true to mark this path as a directory node instead of a file."),
        ], vec!["channel_id", "path", "content"]), false, false),
        tool("desk_edit", "Edit a workspace (desk) file", "In one of MY workspace files (by PATH), replace exactly one occurrence of old_string with new_string.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
            string_prop("old_string", "Existing string to replace. Must match exactly once."),
            string_prop("new_string", "Replacement string."),
            number_prop("if_version", "Expected current version.", Some(1), None),
        ], vec!["channel_id", "path", "old_string", "new_string"]), false, false),
        tool("desk_append", "Append to a workspace (desk) file", "Append text to one of MY workspace files (by PATH), creating it if missing.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
            string_prop("content", "Content to append."),
        ], vec!["channel_id", "path", "content"]), false, false),
        tool("desk_rm", "Remove a workspace (desk) file", "Remove one of MY workspace files or a subtree (by PATH). recursive for a subtree.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "Path to remove."),
            bool_prop("recursive", "Required when removing a subtree."),
        ], vec!["channel_id", "path"]), false, true),
        tool("desk_mv", "Move a workspace (desk) file", "Rename or move one of MY workspace files or a subtree (by PATH).", object_schema(vec![
            channel_id_prop(),
            string_prop("from", "Source path."),
            string_prop("to", "Target path."),
        ], vec!["channel_id", "from", "to"]), false, false),
    ]
}

fn tool(
    name: &str,
    title: &str,
    description: &str,
    input_schema: Value,
    read_only: bool,
    destructive: bool,
) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
        }
    })
}

fn object_schema(props: Vec<(&'static str, Value)>, required: Vec<&'static str>) -> Value {
    let mut properties = Map::new();
    for (name, schema) in props {
        properties.insert(name.to_string(), schema);
    }
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn channel_id_prop() -> (&'static str, Value) {
    string_prop(
        "channel_id",
        "Target channel id (required; no default binding).",
    )
}

fn string_prop(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({ "type": "string", "description": description }),
    )
}

fn array_string_prop(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({ "type": "array", "items": {"type": "string"}, "description": description }),
    )
}

fn number_prop(
    name: &'static str,
    description: &'static str,
    minimum: Option<i64>,
    maximum: Option<i64>,
) -> (&'static str, Value) {
    let mut schema = Map::new();
    schema.insert("type".to_string(), Value::String("integer".to_string()));
    schema.insert(
        "description".to_string(),
        Value::String(description.to_string()),
    );
    if let Some(value) = minimum {
        schema.insert("minimum".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = maximum {
        schema.insert("maximum".to_string(), Value::Number(value.into()));
    }
    (name, Value::Object(schema))
}

fn bool_prop(name: &'static str, description: &'static str) -> (&'static str, Value) {
    (
        name,
        json!({ "type": "boolean", "description": description }),
    )
}
