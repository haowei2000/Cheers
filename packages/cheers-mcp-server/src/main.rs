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
            NEVER fetch the gateway HTTP API yourself. Attachments may carry a download_url / preview_url (e.g. /api/v1/files/.../download) — those are links for the HUMAN web UI only. You have NO gateway HTTP session, so curl/wget/HTTP requests to them return 401. The ONLY way to read an attachment's content is inbox_open (add as_base64:true for binaries like pdf/zip/images, then decode the base64 locally — e.g. write it to a file and unzip). Do not go looking for a gateway URL or token in the environment.\n\
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
        // Channel-scoped read verbs the composer's "Add context" quick-pick offers as
        // references (plan / sessions / cost). The recipient resolves them through
        // these tools; without a mapping the reference is dead (unknown tools reject).
        "read_plan" => with_channel(client, args, "channel.plan.read"),
        "read_sessions" => with_channel(client, args, "channel.sessions.read"),
        "read_cost" => with_channel(client, args, "channel.usage.read"),
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
        "search_messages" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "query", "query")?;
            copy_optional(args, &mut params, "limit", "limit");
            copy_optional(args, &mut params, "before", "before");
            Ok(ResourceCall {
                resource: "channel.messages.search",
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
        "leave_channel" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            Ok(ResourceCall {
                resource: "channel.leave",
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
            copy_optional(args, &mut params, "as_base64", "as_base64");
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
            // Resource-context (docs/design/RESOURCE_CONTEXT.md, "Bot / Manual pick"):
            // wrap the `context` array into a bundle object; the gateway validates
            // (read verbs only), caps, and stamps origin. Only emit when non-empty.
            if let Some(items) = args.get("context").and_then(Value::as_array) {
                if !items.is_empty() {
                    params.insert(
                        "context_bundle".to_string(),
                        json!({ "items": items.clone() }),
                    );
                }
            }
            Ok(ResourceCall {
                resource: "channel.messages.create",
                params,
            })
        }
        // The bot's own card — no channel_id: the write is bot-scoped and the
        // gateway broadcasts the update to every channel the bot is in.
        "set_status" => {
            let mut params = Map::new();
            copy_optional(args, &mut params, "status_text", "status_text");
            copy_optional(args, &mut params, "status_emoji", "status_emoji");
            copy_optional(args, &mut params, "info", "info");
            Ok(ResourceCall {
                resource: "bot.status.write",
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
        "inbox_stage" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "path", "remote_ref")?;
            copy_required(args, &mut params, "filename", "filename")?;
            copy_optional(args, &mut params, "content_type", "content_type");
            Ok(ResourceCall {
                resource: "channel.files.stage",
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
        // Read a file from ANOTHER bot's remote workspace (unified context model, P3).
        // Resolves a `workspace.read` reference handed over as context: `bot_id` names
        // the owner, `path` the file, `channel_id` the shared channel (membership +
        // grant are enforced gateway-side). The gateway brokers the live read under
        // THIS bot's own `workspace_read` permission — no snapshot, current content.
        "read_workspace" => {
            let mut params = Map::new();
            params.insert(
                "channel_id".to_string(),
                Value::String(client.resolve_channel(args)?),
            );
            copy_required(args, &mut params, "bot_id", "bot_id")?;
            copy_required(args, &mut params, "path", "path")?;
            copy_optional(args, &mut params, "session_id", "session_id");
            copy_optional(args, &mut params, "root", "root");
            Ok(ResourceCall {
                resource: "workspace.read",
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
        tool("list_members", "List channel members", "Users and bots that are members of the channel. Each member includes their member_id, display_name, username, info (a short self-description / bio), current status (status_emoji + status_text, with status_updated_at), and is_self (true for YOUR OWN row — use it to recognise yourself and avoid @mentioning yourself). Use this to learn who is in the room, what they do, and what they're currently up to.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
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
        tool("search_messages", "Search channel messages", "Case-insensitive substring search over finalized message content in a channel. Returns the newest matching page (ascending within the page, like read_messages). meta.has_more_before=true means older matches exist — pass before=<oldest matched msg_id from the previous page> to page further back.", object_schema(vec![
            channel_id_prop(),
            string_prop("query", "Text to find. Matched as a literal substring, case-insensitive; %/_ have no special meaning."),
            number_prop("limit", "Default 20, max 200.", Some(1), Some(200)),
            string_prop("before", "Return matches older than this msg_id (use the oldest matched msg_id from the previous page)."),
        ], vec!["channel_id", "query"]), true, false),
        tool("read_activity", "Read channel activity", "Read the unified channel_seq event stream: messages plus channel operations.", object_schema(vec![
            channel_id_prop(),
            number_prop("since_seq", "Return events with channel_seq greater than this value.", Some(0), None),
            number_prop("limit", "Default 50, max 200.", Some(1), Some(200)),
        ], vec!["channel_id"]), true, false),
        tool("get_context", "Get channel context", "Condensed channel context bundle (topic, pinned info, summary).", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("read_plan", "Read the channel plan", "Read the channel's live plan / progress board (the agent's task list and status). Use this to resolve a \"plan\" context reference someone handed you.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("read_sessions", "List channel agent sessions", "List the bot sessions active in this channel (id, bot, mode). Use this to resolve a \"sessions\" context reference.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("read_cost", "Read channel usage / cost", "Read token-usage / cost totals for this channel. Use this to resolve a \"cost\" context reference.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("leave_channel", "Leave a channel", "Remove yourself from a channel you are a member of (like a human member leaving). Not allowed for DMs. You stop receiving that channel's tasks immediately; a human has to re-invite you to get you back, so only leave when you are sure your work there is done.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), false, true),
        tool("inbox_list", "List chat attachments (inbox)", "List files people UPLOADED to this channel's chat (pdf/csv/images/docx). Each has a FILE_ID (uuid); open one with inbox_open. Read-only; these are NOT your workspace files — save your own work with desk_* instead.", object_schema(vec![channel_id_prop()], vec!["channel_id"]), true, false),
        tool("inbox_open", "Open a chat attachment by file_id", "Open a channel attachment by its FILE_ID (from inbox_list). Text files (csv/txt/md/json) return content directly. Binaries (image/pdf/zip/docx) first return kind:\"binary\"; re-open with as_base64:true to get the raw bytes as base64 (<=8MB) through THIS tool, then decode them locally (e.g. write to a file and unzip). Do NOT try to fetch download_url yourself — it is an authenticated human-UI endpoint and you have no gateway session for it (you would just get 401). Attachments are read-only — to edit, copy the content into your workspace with desk_write.", object_schema(vec![
            channel_id_prop(),
            string_prop("file_id", "File id from inbox_list."),
            bool_prop("as_base64", "Return the raw file bytes as base64 instead of decoded text. Required for binaries (pdf/zip/images). Capped at 8MB."),
        ], vec!["channel_id", "file_id"]), true, false),
        tool("post_message", "Post a message", "Send a message to a channel. Use this for proactive / cross-channel posts; the reply to the triggering message goes through the normal agent reply flow, not this tool. To hand work to ANOTHER bot, @mention it: use mention_ids with that bot's member_id from list_members (preferred — exact, no name ambiguity), or mention_names. @mentioning a bot triggers it to act on your message. To hand over working context along with the message (so the recipient reads the same plan / decisions / file instead of guessing), attach `context` — a list of resource references the recipient resolves on demand.", object_schema(vec![
            channel_id_prop(),
            string_prop("text", "Message body (markdown)."),
            array_string_prop("mention_ids", "Members to @mention by member_id (uuid, from list_members). Preferred over mention_names for delegating to a specific bot — exact, no name collisions."),
            array_string_prop("mention_names", "Members to @mention by username or display name. Gateway resolves to UUIDs (ambiguous names may fail); prefer mention_ids when you have the id. Also accepts group tokens: \"all\"/\"everyone\"/\"here\" (whole channel), \"bots\" (all bots), \"humans\"/\"users\" (all people) — each expands to every matching member. Use group tokens sparingly: @-mentioning bots triggers them, and a channel-wide fan-out is rate-limited."),
            string_prop("reply_to_msg_id", "msg_id to reply to (threaded reply)."),
            context_prop(),
        ], vec!["channel_id", "text"]), false, false),
        tool("set_status", "Update your own status card", "Set YOUR OWN status shown on your member card in every channel you're in: a short status_text (≤140 chars — what you're working on / your current state) plus an optional status_emoji, and optionally refresh your info line (the short self-description members see via list_members). Applied immediately and pushed live to viewers. Use this when asked to update your status, or when you start/finish notable work. This tool is the ONLY way to update your card — replying in chat does not change it.", object_schema(vec![
            string_prop("status_text", "Short status line (≤140 chars). Omit to clear the status."),
            string_prop("status_emoji", "Optional emoji shown next to the status."),
            string_prop("info", "Optional replacement for your info/bio line; omit to keep the current one."),
        ], vec![]), false, false),
        tool("inbox_deliver", "Deliver a file to the channel", "Post a NEW file (base64 bytes, <=8MB) into this channel's chat as an attachment people can see and download. For deliverables you hand to people — not your own working notes (use desk_write for those). One-shot, no overwrite; returns the new file_id.", object_schema(vec![
            channel_id_prop(),
            string_prop("filename", "File name."),
            string_prop("data_b64", "Base64 of the raw file bytes."),
            string_prop("content_type", "MIME type."),
        ], vec!["channel_id", "filename", "data_b64"]), false, false),
        tool("inbox_stage", "Stage a local file for lazy delivery", "Register a LOCAL file path as a staged attachment. The file stays on this machine; when a user clicks the attachment in the channel, the gateway fetches and uploads it on demand. Use this instead of inbox_deliver when the file is large or you want to avoid uploading until needed. Returns a file_id.", object_schema(vec![
            channel_id_prop(),
            string_prop("path", "Absolute path to the local file (on this machine)."),
            string_prop("filename", "Display name shown in the channel."),
            string_prop("content_type", "MIME type (optional; auto-detected if omitted)."),
        ], vec!["channel_id", "path", "filename"]), false, false),
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
        tool("read_workspace", "Read another bot's workspace file", "Read a file from ANOTHER bot's remote workspace, given as a `workspace.read` reference in handed-over context (bot_id = the owner, path = the file). The gateway brokers a LIVE read under your own permission and returns the current content — not a stale snapshot. Requires you and the owner to share the channel and the owner to grant you workspace read (else denied). If the owner's connector is offline the read fails; ask the owner directly (post_message) as a fallback. This is for files on another bot's private machine — for your own files use desk_read, for chat uploads use inbox_open.", object_schema(vec![
            channel_id_prop(),
            string_prop("bot_id", "member_id (uuid) of the bot whose workspace file to read — the owner named in the reference."),
            string_prop("path", "File path within that bot's workspace, from the reference."),
            string_prop("session_id", "Optional session id from the reference, scoping which workspace root to read."),
            string_prop("root", "Optional workspace root the path is relative to, from the reference. Pass it through verbatim so you read the exact file the reference points at."),
        ], vec!["channel_id", "bot_id", "path"]), true, false),
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

/// The `context` array on `post_message` — a list of Cheers resource references
/// attached to the message (docs/design/RESOURCE_CONTEXT.md, "Bot / Manual pick").
/// Each item names a READ resource `verb` the recipient can resolve on demand; the
/// gateway drops non-read verbs and caps the count, so the schema stays permissive.
fn context_prop() -> (&'static str, Value) {
    (
        "context",
        json!({
            "type": "array",
            "description": "Optional: Cheers resources to attach as context for the recipient(s) to read on demand — e.g. the plan, recent decisions, a file, or messages. Each item is a resource reference; only read verbs are kept.",
            "items": {
                "type": "object",
                "properties": {
                    "verb": { "type": "string", "description": "Read resource verb, e.g. \"channel.plan.read\", \"channel.activity.read\", \"channel.messages.by-seq\", \"channel.files.read\"." },
                    "params": { "type": "object", "description": "Params the recipient passes when reading (e.g. {\"channel_id\":\"…\"}). channel_id defaults to this channel if omitted." },
                    "label": { "type": "string", "description": "Short human label shown on the context chip." },
                    "kind": { "type": "string", "description": "Optional kind hint: plan|file|message|activity|sessions|cost." }
                },
                "required": ["verb"],
                "additionalProperties": false
            }
        }),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client() -> CheersClient {
        CheersClient {
            http: Client::new(),
            config: ServerConfig {
                resource_url: "http://localhost/resource".to_string(),
                resource_token: None,
                bot_id: None,
                request_timeout_ms: 1000,
            },
        }
    }

    #[test]
    fn post_message_wraps_context_into_bundle() {
        let client = test_client();
        let args: Map<String, Value> = serde_json::from_value(json!({
            "channel_id": "c1",
            "text": "handing this over",
            "context": [
                { "verb": "channel.plan.read", "params": {"channel_id": "c1"}, "label": "Plan", "kind": "plan" }
            ]
        }))
        .unwrap();
        let call = build_resource_call(&client, "post_message", &args).unwrap();
        assert_eq!(call.resource, "channel.messages.create");
        let bundle = call.params.get("context_bundle").expect("bundle present");
        let items = bundle.get("items").and_then(Value::as_array).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["verb"], json!("channel.plan.read"));
    }

    #[test]
    fn post_message_without_context_has_no_bundle() {
        let client = test_client();
        let args: Map<String, Value> =
            serde_json::from_value(json!({ "channel_id": "c1", "text": "hi" })).unwrap();
        let call = build_resource_call(&client, "post_message", &args).unwrap();
        assert!(call.params.get("context_bundle").is_none());
    }

    #[test]
    fn post_message_empty_context_has_no_bundle() {
        let client = test_client();
        let args: Map<String, Value> =
            serde_json::from_value(json!({ "channel_id": "c1", "text": "hi", "context": [] }))
                .unwrap();
        let call = build_resource_call(&client, "post_message", &args).unwrap();
        assert!(call.params.get("context_bundle").is_none());
    }
}
