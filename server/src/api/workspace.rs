//! Remote-workspace browser REST API.
//!
//! These endpoints proxy file-tree / read / write operations to a *specific bot's*
//! connector (the agent's real working machine), keyed by `bot_id` — a channel can
//! have many bots, each with its own workspace. The gateway forwards a
//! `workspace_req` data frame and awaits the connector's `workspace_res`
//! (see `gateway::workspace_rpc`). The connector enforces the actual filesystem
//! boundary (`policy.workspace.allowed_roots`).

use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    Extension, Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

const WORKSPACE_RPC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
pub struct ResolveRefBody {
    /// The clicked reference (a filename or path) from a bot reply. Named `ref` on
    /// the wire; `ref` is a Rust keyword so the field is renamed.
    #[serde(rename = "ref")]
    pub reference: String,
    /// The bot that sent the message the reference lives in (its machine, for the
    /// workspace candidate). Optional — workspace is only offered when present.
    pub sender_bot_id: Option<Uuid>,
}

/// Does a reference look like a filesystem path worth offering as a workspace
/// candidate? (Mirrors the frontend `looksLikePath`.)
fn looks_like_path(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() || t.len() > 200 || t.chars().any(char::is_whitespace) {
        return false;
    }
    if t.split_once("://").map(|(scheme, _)| scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')).unwrap_or(false) {
        return false; // URL scheme
    }
    let has_slash = t.contains('/');
    let has_ext = t
        .rsplit_once('.')
        .map(|(_, ext)| !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or(false);
    has_slash || has_ext
}

#[derive(Deserialize)]
pub struct TreeQuery {
    pub bot_id: Uuid,
    #[serde(default)]
    pub path: String,
    pub root: Option<String>,
}

#[derive(Deserialize)]
pub struct FileQuery {
    pub bot_id: Uuid,
    pub path: String,
    pub root: Option<String>,
}

/// Caller must be a channel user-member (or admin); the target bot must itself be a
/// member of the channel — so you can only browse a bot you actually share a channel
/// with.
async fn ensure_access(
    state: &AppState,
    claims: &Claims,
    channel_id: Uuid,
    bot_id: Uuid,
) -> Result<(), AppError> {
    if !matches!(claims.role.as_str(), "system_admin" | "admin") {
        let member = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM channel_memberships
                 WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user')",
        )
        .bind(channel_id.to_string())
        .bind(&claims.sub)
        .fetch_one(&state.db)
        .await
        .map_err(AppError::Db)?;
        if !member {
            return Err(AppError::Forbidden("channel member required".into()));
        }
    }
    let bot_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM channel_memberships
             WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot')",
    )
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .fetch_one(&state.db)
    .await
    .map_err(AppError::Db)?;
    if !bot_member {
        return Err(AppError::Forbidden(
            "bot is not a member of this channel".into(),
        ));
    }
    Ok(())
}

async fn ensure_channel_member_or_admin(
    state: &AppState,
    claims: &Claims,
    channel_id: Uuid,
) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(());
    }
    let member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM channel_memberships
             WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user')",
    )
    .bind(channel_id.to_string())
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::Db)?;
    if member {
        Ok(())
    } else {
        Err(AppError::Forbidden("channel member required".into()))
    }
}

/// POST /api/v1/channels/:channel_id/resolve-ref  { ref, sender_bot_id? }
///
/// Resolve a clicked file reference from a bot reply to the right store by
/// PROVENANCE (what the bot actually produced in this channel), not by the syntax
/// of the string. Precedence: channel inbox (by filename) > Desk (by path) >
/// workspace candidate. This is purely observational — Cheers never assumes the bot
/// followed any convention and never coerces it; an unresolved ref returns
/// `store:"none"` so the UI degrades to plain text instead of a 404. The frontend
/// checks the message's own attachments first (strongest signal) before calling.
pub async fn resolve_ref(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Json(body): Json<ResolveRefBody>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_member_or_admin(&state, &claims, channel_id).await?;
    let r = body.reference.trim();
    let base = r.rsplit('/').next().unwrap_or(r);
    let mut also: Vec<Value> = Vec::new();

    // 1. Channel inbox, by filename (newest uploaded). The bot delivered this file.
    let inbox = sqlx::query_as::<_, (String, Option<String>, Option<String>, String)>(
        "SELECT file_id, original_filename, content_type, status
         FROM file_records
         WHERE channel_id = $1 AND original_filename = $2 AND status IN ('uploaded','converted')
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(base)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::Db)?;

    // 2. Desk (context_files): prefer an exact path, else fall back to basename
    //    (a Desk file the bot mentioned by name, e.g. `todo.md` for `notes/todo.md`).
    let desk = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT path, content FROM context_files
         WHERE channel_id = $1 AND is_dir = FALSE
           AND (path = $2 OR path = $3 OR path LIKE '%/' || $3)
         ORDER BY (path = $2) DESC, length(path) ASC
         LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(r)
    .bind(base)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::Db)?;

    // 3. Workspace candidate — only if a bot is known and it looks like a path.
    //    NOT probed (the connector may be offline or not support it); the client
    //    only commits when the user opens it.
    let ws_candidate = body
        .sender_bot_id
        .filter(|_| looks_like_path(r))
        .map(|bot| (bot, r.to_string()));

    if inbox.is_some() {
        also.push(json!({ "store": "desk", "present": desk.is_some() }));
    }
    if let Some((file_id, filename, content_type, status)) = inbox {
        return Ok(Json(json!({
            "store": "inbox",
            "display_name": filename.clone().unwrap_or_else(|| base.to_string()),
            "file_id": file_id,
            "content_type": content_type,
            "status": status,
            "also_in": also,
        })));
    }
    if let Some((path, content)) = desk {
        if ws_candidate.is_some() {
            also.push(json!({ "store": "workspace" }));
        }
        return Ok(Json(json!({
            "store": "desk",
            "display_name": base,
            "path": path,
            "content": content,
            "also_in": also,
        })));
    }
    if let Some((bot, path)) = ws_candidate {
        return Ok(Json(json!({
            "store": "workspace",
            "display_name": base,
            "bot_id": bot.to_string(),
            "path": path,
            "also_in": also,
        })));
    }
    Ok(Json(json!({ "store": "none", "display_name": base, "also_in": also })))
}

/// Send a `workspace_req` to the bot's connector and await the correlated reply.
async fn workspace_call(
    state: &AppState,
    bot_id: Uuid,
    op: &str,
    path: &str,
    root: Option<&str>,
    content_b64: Option<String>,
) -> Result<Value, AppError> {
    if !state.bot_locator.is_online(bot_id) {
        return Err(AppError::BadRequest("bot connector is offline".into()));
    }
    let req_id = Uuid::new_v4().to_string();
    let rx = state.workspace_rpc.register(req_id.clone());
    let frame = json!({
        "type": "workspace_req",
        "req_id": req_id,
        "op": op,
        "path": path,
        "root": root,
        "content_b64": content_b64,
    });
    if !state.bot_locator.send_data(bot_id, frame).await {
        state.workspace_rpc.cancel(&req_id);
        return Err(AppError::BadRequest("bot connector is offline".into()));
    }
    let res = match tokio::time::timeout(WORKSPACE_RPC_TIMEOUT, rx).await {
        Ok(Ok(v)) => v,
        _ => {
            state.workspace_rpc.cancel(&req_id);
            return Err(AppError::BadRequest("workspace request timed out".into()));
        }
    };
    if res.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(res.get("data").cloned().unwrap_or(Value::Null))
    } else {
        let code = res.get("code").and_then(Value::as_str).unwrap_or("E_WORKSPACE");
        let msg = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("workspace operation failed");
        Err(AppError::BadRequest(format!("{code}: {msg}")))
    }
}

/// GET /api/v1/channels/:channel_id/workspace/bots
/// Bots in the channel that can serve a remote workspace (online connectors).
pub async fn list_workspace_bots(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    if !matches!(claims.role.as_str(), "system_admin" | "admin") {
        let member = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM channel_memberships
                 WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user')",
        )
        .bind(channel_id.to_string())
        .bind(&claims.sub)
        .fetch_one(&state.db)
        .await
        .map_err(AppError::Db)?;
        if !member {
            return Err(AppError::Forbidden("channel member required".into()));
        }
    }
    let rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT b.bot_id, b.username, b.display_name
         FROM channel_memberships m
         JOIN bot_accounts b ON b.bot_id = m.member_id
         WHERE m.channel_id = $1 AND m.member_type = 'bot'
         ORDER BY b.username",
    )
    .bind(channel_id.to_string())
    .fetch_all(&state.db)
    .await
    .map_err(AppError::Db)?;

    let bots: Vec<Value> = rows
        .into_iter()
        .map(|(bot_id, username, display_name)| {
            let online = Uuid::parse_str(&bot_id)
                .map(|id| state.bot_locator.is_online(id))
                .unwrap_or(false);
            json!({
                "bot_id": bot_id,
                "username": username,
                "display_name": display_name,
                "online": online,
            })
        })
        .collect();
    Ok(Json(json!({ "bots": bots })))
}

/// GET /api/v1/channels/:channel_id/workspace/tree?bot_id=&path=&root=
pub async fn get_tree(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let data = workspace_call(&state, q.bot_id, "ls", &q.path, q.root.as_deref(), None).await?;
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/file?bot_id=&path=&root=
pub async fn get_file(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<FileQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let data = workspace_call(&state, q.bot_id, "read", &q.path, q.root.as_deref(), None).await?;
    Ok(Json(data))
}

/// PUT /api/v1/channels/:channel_id/workspace/file?bot_id=&path=&root=  (raw bytes body)
pub async fn put_file(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<FileQuery>,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let content_b64 = B64.encode(&body);
    let data = workspace_call(
        &state,
        q.bot_id,
        "write",
        &q.path,
        q.root.as_deref(),
        Some(content_b64),
    )
    .await?;
    Ok(Json(data))
}
