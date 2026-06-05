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
    default_channel_id: Option<String>,
    bot_id: Option<String>,
    /// Optional platform session UUID injected by the connector for correlation.
    /// It is not used for resource authentication or authorization.
    session_id: Option<String>,
    request_timeout_ms: u64,
}

#[derive(Debug, Clone)]
struct AgentNexusClient {
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
    let client = AgentNexusClient {
        http: Client::builder()
            .timeout(Duration::from_millis(config.request_timeout_ms))
            .build()?,
        config,
    };
    eprintln!(
        "[agentnexus-mcp] ready (channel={}, bot={})",
        client
            .config
            .default_channel_id
            .as_deref()
            .unwrap_or("none"),
        client.config.bot_id.as_deref().unwrap_or("?"),
    );
    serve_stdio(client).await
}

fn load_config() -> anyhow::Result<ServerConfig> {
    let resource_url = env::var("AGENTNEXUS_RESOURCE_URL")
        .context("AGENTNEXUS_RESOURCE_URL is required (connector loopback resource endpoint)")?;
    let request_timeout_ms = env::var("AGENTNEXUS_REQUEST_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000);
    Ok(ServerConfig {
        resource_url,
        resource_token: empty_to_none(env::var("AGENTNEXUS_RESOURCE_TOKEN").ok()),
        default_channel_id: empty_to_none(env::var("AGENTNEXUS_CHANNEL_ID").ok()),
        bot_id: empty_to_none(env::var("AGENTNEXUS_BOT_ID").ok()),
        session_id: empty_to_none(env::var("AGENTNEXUS_SESSION_ID").ok()),
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

async fn serve_stdio(client: AgentNexusClient) -> anyhow::Result<()> {
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

async fn handle_request(client: &AgentNexusClient, request: &Value) -> Value {
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
            "name": "agentnexus",
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

async fn handle_tool_call(client: &AgentNexusClient, params: &Value) -> Result<Value, Value> {
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

impl AgentNexusClient {
    async fn call(
        &self,
        resource: &str,
        params: Map<String, Value>,
    ) -> Result<Value, ResourceError> {
        let mut body = json!({ "resource": resource, "params": params });
        if let Some(session_id) = &self.config.session_id {
            body["session_id"] = Value::String(session_id.clone());
        }
        let mut request = self.http.post(&self.config.resource_url).json(&body);
        if let Some(token) = &self.config.resource_token {
            request = request
                .bearer_auth(token)
                .header("X-AgentNexus-Loopback-Token", token);
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
        args.get("channel_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim().to_string())
            .or_else(|| self.config.default_channel_id.clone())
            .ok_or_else(|| ResourceError {
                code: "NO_CHANNEL".to_string(),
                message: "no channel_id provided and this session is not bound to a channel"
                    .to_string(),
            })
    }
}

fn build_resource_call(
    client: &AgentNexusClient,
    tool: &str,
    args: &Map<String, Value>,
) -> Result<ResourceCall, ResourceError> {
    match tool {
        "get_channel_info" => with_channel(client, args, "channel.info"),
        "list_members" => with_channel(client, args, "channel.members"),
        "messages_index" => with_channel(client, args, "channel.messages.index"),
        "get_context" => with_channel(client, args, "channel.context"),
        "list_files" => with_channel(client, args, "channel.files"),
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
        "read_file" => {
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
        "create_file" => {
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
        "fs_ls" => {
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
        "fs_read" => {
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
        "fs_write" => {
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
        "fs_edit" => {
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
        "fs_append" => {
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
        "fs_rm" => {
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
        "fs_mv" => {
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
    client: &AgentNexusClient,
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
        tool("get_channel_info", "Get channel info", "Metadata for a channel: name, type, workspace.", object_schema(vec![channel_id_prop()], vec![]), true, false),
        tool("list_members", "List channel members", "Users and bots that are members of the channel.", object_schema(vec![channel_id_prop()], vec![]), true, false),
        tool("read_messages", "Read recent messages", "Read channel messages by pagination cursor or channel_seq cursor.", object_schema(vec![
            channel_id_prop(),
            number_prop("limit", "Default 50, max 200.", Some(1), Some(200)),
            string_prop("before", "Return messages before this msg_id."),
            string_prop("after", "Return messages after this msg_id."),
            number_prop("since_seq", "Return messages with channel_seq greater than this value.", Some(0), None),
        ], vec![]), true, false),
        tool("messages_index", "Get message sequence index", "Return min_seq, max_seq, and count for finalized channel messages.", object_schema(vec![channel_id_prop()], vec![]), true, false),
        tool("messages_by_seq", "Read messages by channel_seq", "Fetch finalized channel messages in an inclusive channel_seq range.", object_schema(vec![
            channel_id_prop(),
            number_prop("min_seq", "Inclusive lower channel_seq.", Some(1), None),
            number_prop("max_seq", "Inclusive upper channel_seq.", Some(1), None),
            number_prop("limit", "Default 50, max 200.", Some(1), Some(200)),
        ], vec!["min_seq"]), true, false),
        tool("read_activity", "Read channel activity", "Read the unified channel_seq event stream: messages plus channel operations.", object_schema(vec![
            channel_id_prop(),
            number_prop("since_seq", "Return events with channel_seq greater than this value.", Some(0), None),
            number_prop("limit", "Default 50, max 200.", Some(1), Some(200)),
        ], vec![]), true, false),
        tool("get_context", "Get channel context", "Condensed channel context bundle (topic, pinned info, summary).", object_schema(vec![channel_id_prop()], vec![]), true, false),
        tool("list_files", "List channel files", "Files shared in the channel.", object_schema(vec![channel_id_prop()], vec![]), true, false),
        tool("read_file", "Read a channel file", "Fetch a file's content/metadata by id.", object_schema(vec![
            channel_id_prop(),
            string_prop("file_id", "File id from list_files."),
        ], vec!["file_id"]), true, false),
        tool("post_message", "Post a message", "Send a message to a channel. Use this for proactive / cross-channel posts; the reply to the triggering message goes through the normal agent reply flow, not this tool.", object_schema(vec![
            channel_id_prop(),
            string_prop("text", "Message body (markdown)."),
            array_string_prop("mention_names", "Members to @mention by username or display name. Gateway resolves to UUIDs."),
            string_prop("reply_to_msg_id", "msg_id to reply to (threaded reply)."),
        ], vec!["text"]), false, false),
        tool("create_file", "Create a channel file", "Upload a file into the channel (base64-encoded bytes).", object_schema(vec![
            channel_id_prop(),
            string_prop("filename", "File name."),
            string_prop("data_b64", "Base64 of the raw file bytes."),
            string_prop("content_type", "MIME type."),
        ], vec!["filename", "data_b64"]), false, false),
        tool("fs_ls", "List workspace files", "List AgentNexus workspace files under a path prefix.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "Path prefix. Omit or empty string for root."),
        ], vec![]), true, false),
        tool("fs_read", "Read workspace file", "Read a file from the AgentNexus workspace tree.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
        ], vec!["path"]), true, false),
        tool("fs_write", "Write workspace file", "Create or overwrite a workspace file. Use if_version for optimistic locking.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
            string_prop("content", "Full file content."),
            number_prop("if_version", "Expected current version. Use 0 for create-only.", Some(0), None),
        ], vec!["path", "content"]), false, false),
        tool("fs_edit", "Edit workspace file", "Replace exactly one string occurrence in a workspace file.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
            string_prop("old_string", "Existing string to replace. Must match exactly once."),
            string_prop("new_string", "Replacement string."),
            number_prop("if_version", "Expected current version.", Some(1), None),
        ], vec!["path", "old_string", "new_string"]), false, false),
        tool("fs_append", "Append workspace file", "Append content to a workspace file, creating it if missing.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "File path."),
            string_prop("content", "Content to append."),
        ], vec!["path", "content"]), false, false),
        tool("fs_rm", "Remove workspace file", "Remove a workspace file or subtree.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "Path to remove."),
            bool_prop("recursive", "Required when removing a subtree."),
        ], vec!["path"]), false, true),
        tool("fs_mv", "Move workspace file", "Rename or move a workspace file or subtree.", object_schema(vec![
            channel_id_prop(),
            string_prop("from", "Source path."),
            string_prop("to", "Target path."),
        ], vec!["from", "to"]), false, false),
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
        "Target channel id. Omit to use the channel this session is bound to.",
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
