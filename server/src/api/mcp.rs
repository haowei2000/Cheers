use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{errors::AppError, api::middleware::Claims};

#[derive(Deserialize)]
pub struct McpInput {
    pub config: Option<Value>,
    pub content: Option<String>,
    pub raw: Option<String>,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: Option<Value>,
}

fn parse_input(body: McpInput) -> Result<Value, AppError> {
    if let Some(config) = body.config {
        return Ok(config);
    }
    if let Some(content) = body.content.or(body.raw) {
        return serde_json::from_str(&content).map_err(|e| AppError::BadRequest(format!("invalid JSON: {e}")));
    }
    if let Some(servers) = body.mcp_servers {
        return Ok(json!({"mcpServers": servers}));
    }
    Err(AppError::BadRequest("MCP config is required".into()))
}

fn preview(config: Value, source: &str) -> Result<Value, AppError> {
    let root = config.as_object().ok_or_else(|| AppError::BadRequest("MCP config must be an object".into()))?;
    let servers_value = root.get("mcpServers").or_else(|| root.get("mcp_servers")).unwrap_or(&config);
    let servers = servers_value.as_object().ok_or_else(|| AppError::BadRequest("mcpServers must be an object".into()))?;
    let mut normalized = Map::new();
    let mut previews = Vec::new();
    let mut errors = Vec::new();
    for (name, item) in servers {
        let Some(obj) = item.as_object() else {
            errors.push(format!("{name}: server config must be an object"));
            continue;
        };
        let command = obj.get("command").and_then(Value::as_str).map(str::to_string);
        let url = obj.get("url").and_then(Value::as_str).map(str::to_string);
        if command.is_none() && url.is_none() {
            errors.push(format!("{name}: either command or url is required"));
        }
        let args = obj.get("args").and_then(Value::as_array).map(|items| {
            items.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()
        }).unwrap_or_default();
        let env_keys = obj.get("env").and_then(Value::as_object).map(|env| {
            let mut keys = env.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            keys
        }).unwrap_or_default();
        let transport = obj.get("transport")
            .and_then(Value::as_str)
            .unwrap_or(if url.is_some() { "http" } else { "stdio" });
        normalized.insert(name.clone(), json!({
            "command": command,
            "args": args,
            "url": url,
            "transport": transport,
            "env": env_keys.iter().map(|k| (k.clone(), Value::String("***".into()))).collect::<Map<_, _>>(),
        }));
        previews.push(json!({
            "name": name,
            "transport": transport,
            "command": command,
            "args": args,
            "url": url,
            "env_keys": env_keys,
            "has_env": !env_keys.is_empty(),
        }));
    }
    Ok(json!({
        "source": source,
        "server_count": previews.len(),
        "is_valid": errors.is_empty(),
        "servers": previews,
        "warnings": [],
        "errors": errors,
        "normalized_config": {"mcpServers": normalized},
    }))
}

pub async fn preview_mcp_config(
    Extension(_claims): Extension<Claims>,
    Json(body): Json<McpInput>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(preview(parse_input(body)?, "mcp")?))
}

pub async fn parse_claude_config(
    Extension(_claims): Extension<Claims>,
    Json(body): Json<McpInput>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(preview(parse_input(body)?, "claude_desktop")?))
}
