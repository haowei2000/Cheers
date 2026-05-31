use axum::{extract::{Path, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{app_state::AppState, errors::AppError, api::middleware::Claims};

#[derive(Deserialize)]
pub struct BotAcpSecurityConfig {
    pub enabled: bool,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub algorithm: Option<String>,
    #[serde(default)]
    pub allow_plaintext_fallback: Option<bool>,
}

#[derive(Deserialize)]
pub struct BotCreateRequest {
    pub bot_id: Option<String>,
    pub username: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub model_id: Option<String>,
    pub template_id: Option<String>,
    pub custom_system_prompt: Option<String>,
    pub status: Option<String>,
    pub scope: Option<String>,
    pub intro: Option<String>,
    pub avatar_url: Option<String>,
    pub binding_type: Option<String>,
    pub bridge_provider: Option<String>,
    pub binding_config: Option<Value>,
    pub acp_security: Option<BotAcpSecurityConfig>,
}

pub async fn list_bots(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    let rows = sqlx::query(
        "SELECT bot_id, username, display_name, description, avatar_url, status, scope,
                binding_type, bridge_provider, model_id, template_id, intro, binding_config, created_at
         FROM bot_accounts
         ORDER BY username",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(|r| json!({
        "bot_id": r.try_get::<String, _>("bot_id").unwrap_or_default(),
        "username": r.try_get::<String, _>("username").unwrap_or_default(),
        "display_name": r.try_get::<String, _>("display_name").ok(),
        "description": r.try_get::<String, _>("description").ok(),
        "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
        "status": r.try_get::<String, _>("status").unwrap_or_else(|_| "online".into()),
        "scope": r.try_get::<String, _>("scope").unwrap_or_else(|_| "friend".into()),
        "binding_type": r.try_get::<String, _>("binding_type").unwrap_or_else(|_| "http".into()),
        "bridge_provider": r.try_get::<String, _>("bridge_provider").unwrap_or_else(|_| "generic".into()),
        "model_id": r.try_get::<String, _>("model_id").ok(),
        "template_id": r.try_get::<String, _>("template_id").ok(),
        "intro": r.try_get::<String, _>("intro").ok(),
        "binding_config": r.try_get::<Value, _>("binding_config").ok(),
    })).collect()))
}

pub async fn create_bot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<BotCreateRequest>,
) -> Result<Json<Value>, AppError> {
    if body.username.trim().is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }
    let binding_config = normalize_binding_config(body.binding_config, body.acp_security)?;
    let bot_id = body.bot_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let status = body.status.unwrap_or_else(|| "online".into());
    let scope = body.scope.unwrap_or_else(|| "friend".into());
    let binding_type = body.binding_type.unwrap_or_else(|| "http".into());
    let bridge_provider = body.bridge_provider.unwrap_or_else(|| "generic".into());
    let row = sqlx::query(
        "INSERT INTO bot_accounts
         (bot_id, username, display_name, description, avatar_url, model_id, template_id,
             custom_system_prompt, status, scope, intro, binding_type, bridge_provider,
             binding_config, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING bot_id, username, display_name, description, avatar_url, status, scope,
                   binding_type, bridge_provider, model_id, template_id, intro, binding_config",
    )
    .bind(&bot_id)
    .bind(body.username.trim())
    .bind(body.display_name)
    .bind(body.description)
    .bind(body.avatar_url)
    .bind(body.model_id)
    .bind(body.template_id)
    .bind(body.custom_system_prompt)
    .bind(status)
        .bind(scope)
        .bind(body.intro)
        .bind(binding_type)
        .bind(bridge_provider)
        .bind(binding_config)
        .bind(&claims.sub)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(json!({
        "bot_id": row.try_get::<String, _>("bot_id").unwrap_or_default(),
        "username": row.try_get::<String, _>("username").unwrap_or_default(),
        "display_name": row.try_get::<String, _>("display_name").ok(),
        "description": row.try_get::<String, _>("description").ok(),
        "avatar_url": row.try_get::<String, _>("avatar_url").ok(),
        "status": row.try_get::<String, _>("status").unwrap_or_else(|_| "online".into()),
        "scope": row.try_get::<String, _>("scope").unwrap_or_else(|_| "friend".into()),
        "binding_type": row.try_get::<String, _>("binding_type").unwrap_or_else(|_| "http".into()),
        "bridge_provider": row.try_get::<String, _>("bridge_provider").unwrap_or_else(|_| "generic".into()),
        "model_id": row.try_get::<String, _>("model_id").ok(),
        "template_id": row.try_get::<String, _>("template_id").ok(),
        "intro": row.try_get::<String, _>("intro").ok(),
        "binding_config": row.try_get::<Value, _>("binding_config").ok(),
    })))
}

fn normalize_binding_config(
    binding_config: Option<Value>,
    acp_security: Option<BotAcpSecurityConfig>,
) -> Result<Option<Value>, AppError> {
    let mut merged = match binding_config {
        Some(Value::Object(map)) => map,
        Some(Value::Null) => Map::new(),
        Some(_) => {
            return Err(AppError::BadRequest("binding_config must be a JSON object".into()));
        }
        None => Map::new(),
    };

    if let Some(sec) = acp_security {
        let algorithm = sec.algorithm.unwrap_or_else(|| "AES-256-GCM".into());
        let mode = sec.mode.unwrap_or_else(|| "X25519-ECDH".into());
        let mut sec_obj = Map::new();
        sec_obj.insert("enabled".into(), Value::Bool(sec.enabled));
        sec_obj.insert("mode".into(), Value::String(mode));
        sec_obj.insert("algorithm".into(), Value::String(algorithm));

        if let Some(allow_plaintext_fallback) = sec.allow_plaintext_fallback {
            sec_obj.insert("allow_plaintext_fallback".into(), Value::Bool(allow_plaintext_fallback));
        }

        merged.insert("acp_security".into(), Value::Object(sec_obj));
    }

    if merged.is_empty() {
        return Ok(None);
    }

    Ok(Some(Value::Object(merged)))
}

pub async fn get_bot_status(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = sqlx::query(
        "SELECT bot_id, status, binding_type FROM bot_accounts WHERE bot_id = $1",
    )
    .bind(&bot_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let status: String = row.try_get("status").unwrap_or_else(|_| "offline".into());
    Ok(Json(json!({
        "bot_id": row.try_get::<String, _>("bot_id").unwrap_or(bot_id),
        "status": status,
        "binding_type": row.try_get::<String, _>("binding_type").unwrap_or_else(|_| "http".into()),
        "connection_status": if status == "offline" { "offline" } else { "online" },
        "is_online": status != "offline",
    })))
}

pub async fn test_bot(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let exists = sqlx::query("SELECT EXISTS(SELECT 1 FROM bot_accounts WHERE bot_id = $1) AS ok")
        .bind(&bot_id)
        .fetch_one(&state.db)
        .await?
        .try_get::<bool, _>("ok")
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({"bot_id": bot_id, "ok": true, "message": "bot configuration is readable"})))
}
