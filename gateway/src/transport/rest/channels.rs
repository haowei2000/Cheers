use axum::{extract::{Path, State}, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{app_state::AppState, errors::AppError, transport::middleware::auth::Claims};

#[derive(Serialize)]
pub struct ChannelDto {
    pub channel_id: String,
    pub workspace_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub purpose: Option<String>,
    pub auto_assist: bool,
    pub allow_member_invites: bool,
    pub allow_bot_adds: bool,
}

#[derive(Deserialize)]
pub struct ChannelCreateRequest {
    pub workspace_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: Option<String>,
    pub purpose: Option<String>,
    pub allow_member_invites: Option<bool>,
    pub allow_bot_adds: Option<bool>,
    #[serde(default)]
    pub initial_user_ids: Vec<String>,
    #[serde(default)]
    pub initial_bot_ids: Vec<String>,
}

#[derive(Deserialize)]
pub struct ChannelUpdateRequest {
    pub name: Option<String>,
    pub purpose: Option<String>,
    #[serde(rename = "type")]
    pub channel_type: Option<String>,
    pub auto_assist: Option<bool>,
    pub allow_member_invites: Option<bool>,
    pub allow_bot_adds: Option<bool>,
}

#[derive(Deserialize)]
pub struct AddMemberRequest {
    pub member_id: String,
    pub member_type: String,
}

#[derive(Deserialize)]
pub struct ContextUpdateRequest {
    #[serde(default)]
    pub anchor: Option<String>,
    #[serde(default)]
    pub decisions: Option<String>,
    #[serde(default)]
    pub files_index: Option<String>,
    #[serde(default)]
    pub recent: Option<String>,
    #[serde(default)]
    pub layers: Option<Value>,
}

fn dto(row: sqlx::postgres::PgRow) -> ChannelDto {
    ChannelDto {
        channel_id: row.try_get("channel_id").unwrap_or_default(),
        workspace_id: row.try_get("workspace_id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        channel_type: row.try_get("type").unwrap_or_else(|_| "public".to_string()),
        purpose: row.try_get("purpose").ok(),
        auto_assist: row.try_get("auto_assist").unwrap_or(false),
        allow_member_invites: row.try_get("allow_member_invites").unwrap_or(true),
        allow_bot_adds: row.try_get("allow_bot_adds").unwrap_or(true),
    }
}

async fn is_channel_member(state: &AppState, channel_id: &str, user_id: &str, role: &str) -> Result<bool, AppError> {
    if matches!(role, "system_admin" | "admin") {
        return Ok(true);
    }
    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    Ok(ok)
}

async fn ensure_channel_admin(state: &AppState, channel_id: &str, user_id: &str, role: &str) -> Result<(), AppError> {
    if matches!(role, "system_admin" | "admin") {
        return Ok(());
    }
    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user' AND role IN ('owner', 'admin')
        ) AS ok",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if ok { Ok(()) } else { Err(AppError::Forbidden("channel admin required".into())) }
}

pub async fn list_channels(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<ChannelDto>>, AppError> {
    let rows = sqlx::query(
        "SELECT DISTINCT c.channel_id, c.workspace_id, c.name, c.type, c.purpose,
                c.auto_assist, c.allow_member_invites, c.allow_bot_adds, c.created_at
         FROM channels c
         LEFT JOIN channel_memberships cm ON cm.channel_id = c.channel_id AND cm.member_id = $1
         LEFT JOIN workspace_memberships wm ON wm.workspace_id = c.workspace_id AND wm.user_id = $1
         WHERE c.type != 'dm' AND (cm.member_id IS NOT NULL OR wm.user_id IS NOT NULL OR $2 IN ('system_admin', 'admin'))
         ORDER BY c.created_at DESC",
    )
    .bind(&claims.sub)
    .bind(&claims.role)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(dto).collect()))
}

pub async fn create_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<ChannelCreateRequest>,
) -> Result<Json<ChannelDto>, AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let allowed = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2
        ) AS ok",
    )
    .bind(&body.workspace_id)
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if !allowed && !matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Err(AppError::Forbidden("workspace member required".into()));
    }
    let channel_id = Uuid::new_v4().to_string();
    let channel_type = body.channel_type.unwrap_or_else(|| "public".into());
    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "INSERT INTO channels
            (channel_id, workspace_id, name, type, purpose, allow_member_invites, allow_bot_adds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING channel_id, workspace_id, name, type, purpose, auto_assist, allow_member_invites, allow_bot_adds",
    )
    .bind(&channel_id)
    .bind(&body.workspace_id)
    .bind(body.name.trim())
    .bind(&channel_type)
    .bind(&body.purpose)
    .bind(body.allow_member_invites.unwrap_or(true))
    .bind(body.allow_bot_adds.unwrap_or(true))
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by) VALUES ($1, $2, 'user', 'owner', $2) ON CONFLICT DO NOTHING")
        .bind(&channel_id)
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?;
    for user_id in body.initial_user_ids {
        sqlx::query("INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by) VALUES ($1, $2, 'user', 'member', $3) ON CONFLICT DO NOTHING")
            .bind(&channel_id)
            .bind(user_id)
            .bind(&claims.sub)
            .execute(&mut *tx)
            .await?;
    }
    for bot_id in body.initial_bot_ids {
        sqlx::query("INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by) VALUES ($1, $2, 'bot', 'member', $3) ON CONFLICT DO NOTHING")
            .bind(&channel_id)
            .bind(bot_id)
            .bind(&claims.sub)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(dto(row)))
}

pub async fn get_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<ChannelDto>, AppError> {
    if !is_channel_member(&state, &channel_id, &claims.sub, &claims.role).await? {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    let row = sqlx::query("SELECT channel_id, workspace_id, name, type, purpose, auto_assist, allow_member_invites, allow_bot_adds FROM channels WHERE channel_id = $1")
        .bind(&channel_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(dto(row)))
}

pub async fn update_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<ChannelUpdateRequest>,
) -> Result<Json<ChannelDto>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let row = sqlx::query(
        "UPDATE channels
         SET name = COALESCE($2, name),
             purpose = COALESCE($3, purpose),
             type = COALESCE($4, type),
             auto_assist = COALESCE($5, auto_assist),
             allow_member_invites = COALESCE($6, allow_member_invites),
             allow_bot_adds = COALESCE($7, allow_bot_adds)
         WHERE channel_id = $1
         RETURNING channel_id, workspace_id, name, type, purpose, auto_assist, allow_member_invites, allow_bot_adds",
    )
    .bind(&channel_id)
    .bind(body.name)
    .bind(body.purpose)
    .bind(body.channel_type)
    .bind(body.auto_assist)
    .bind(body.allow_member_invites)
    .bind(body.allow_bot_adds)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(dto(row)))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    sqlx::query("DELETE FROM channels WHERE channel_id = $1")
        .bind(&channel_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"deleted": true})))
}

pub async fn list_channel_members(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Vec<Value>>, AppError> {
    if !is_channel_member(&state, &channel_id, &claims.sub, &claims.role).await? {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    let rows = sqlx::query(
        "SELECT cm.member_id, cm.member_type, cm.role,
                COALESCE(u.username, b.username) AS username,
                COALESCE(u.display_name, b.display_name) AS display_name
         FROM channel_memberships cm
         LEFT JOIN users u ON cm.member_type = 'user' AND u.user_id = cm.member_id
         LEFT JOIN bot_accounts b ON cm.member_type = 'bot' AND b.bot_id = cm.member_id
         WHERE cm.channel_id = $1
         ORDER BY cm.member_type, username",
    )
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(|r| json!({
        "member_id": r.try_get::<String, _>("member_id").unwrap_or_default(),
        "member_type": r.try_get::<String, _>("member_type").unwrap_or_default(),
        "role": r.try_get::<String, _>("role").unwrap_or_else(|_| "member".into()),
        "username": r.try_get::<String, _>("username").ok(),
        "display_name": r.try_get::<String, _>("display_name").ok(),
    })).collect()))
}

pub async fn add_channel_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<AddMemberRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    if !matches!(body.member_type.as_str(), "user" | "bot") {
        return Err(AppError::BadRequest("member_type must be user or bot".into()));
    }
    sqlx::query(
        "INSERT INTO channel_memberships (channel_id, member_id, member_type, role, added_by)
         VALUES ($1, $2, $3, 'member', $4)
         ON CONFLICT (channel_id, member_id) DO UPDATE SET member_type = EXCLUDED.member_type",
    )
    .bind(&channel_id)
    .bind(&body.member_id)
    .bind(&body.member_type)
    .bind(&claims.sub)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({"channel_id": channel_id, "member_id": body.member_id, "member_type": body.member_type})))
}

pub async fn remove_channel_member(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, member_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    sqlx::query("DELETE FROM channel_memberships WHERE channel_id = $1 AND member_id = $2")
        .bind(&channel_id)
        .bind(&member_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"removed": true})))
}

pub async fn get_channel_context(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    if !is_channel_member(&state, &channel_id, &claims.sub, &claims.role).await? {
        return Err(AppError::Forbidden("not a channel member".into()));
    }
    let rows = sqlx::query("SELECT layer, content FROM memory_entries WHERE channel_id = $1 ORDER BY layer, sort_order")
        .bind(&channel_id)
        .fetch_all(&state.db)
        .await?;
    let mut out = serde_json::Map::new();
    for row in rows {
        let key: String = row.try_get("layer").unwrap_or_default();
        let content: String = row.try_get("content").unwrap_or_default();
        out.insert(key.to_lowercase(), json!(content));
    }
    Ok(Json(Value::Object(out)))
}

pub async fn put_channel_context(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<String>,
    Json(body): Json<ContextUpdateRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_admin(&state, &channel_id, &claims.sub, &claims.role).await?;
    let mut layers: Vec<(String, String)> = Vec::new();
    if let Some(v) = body.anchor { layers.push(("ANCHOR".into(), v)); }
    if let Some(v) = body.decisions { layers.push(("DECISIONS".into(), v)); }
    if let Some(v) = body.files_index { layers.push(("FILES_INDEX".into(), v)); }
    if let Some(v) = body.recent { layers.push(("RECENT".into(), v)); }
    if let Some(Value::Object(map)) = body.layers {
        for (key, value) in map {
            if let Some(content) = value.as_str() {
                layers.push((key.to_uppercase(), content.to_string()));
            }
        }
    }
    for (layer, content) in layers {
        sqlx::query(
            "INSERT INTO memory_entries (entry_id, channel_id, layer, content, sort_order, created_by, creator_type)
             VALUES ($1, $2, $3, $4, 0, $5, 'user')
             ON CONFLICT (channel_id, layer, sort_order)
             DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&channel_id)
        .bind(layer)
        .bind(content)
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    }
    Ok(Json(json!({"updated": true})))
}
