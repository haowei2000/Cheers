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
    http::HeaderMap,
    Extension, Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims, app_state::AppState, domain::bot_event_policy::Capability,
    errors::AppError,
};

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
    if t.split_once("://")
        .map(|(scheme, _)| {
            scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
        })
        .unwrap_or(false)
    {
        return false; // URL scheme
    }
    let has_slash = t.contains('/');
    let has_ext = t
        .rsplit_once('.')
        .map(|(_, ext)| {
            !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or(false);
    has_slash || has_ext
}

#[derive(Deserialize)]
pub struct TreeQuery {
    pub bot_id: Uuid,
    #[serde(default)]
    pub path: String,
    pub root: Option<String>,
    /// Optional: scope the browse to this session's root set (`cwd` +
    /// `additionalDirectories`). Omitted ⇒ the bot-wide `allowed_roots` view.
    pub session_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct FileQuery {
    pub bot_id: Uuid,
    pub path: String,
    pub root: Option<String>,
    /// Optional: scope to this session's root set (see [`TreeQuery::session_id`]).
    pub session_id: Option<Uuid>,
}

/// `GET workspace/git/diff` — same shape as [`TreeQuery`] plus `staged`. `path` is
/// optional: empty ⇒ diff the whole repo (working dir = chosen root); a file ⇒ diff
/// that pathspec; a subdir ⇒ diff within it.
#[derive(Deserialize)]
pub struct GitDiffQuery {
    pub bot_id: Uuid,
    #[serde(default)]
    pub path: String,
    pub root: Option<String>,
    pub session_id: Option<Uuid>,
    /// Diff the staged index (`--staged`) rather than the working tree.
    pub staged: Option<bool>,
}

/// `GET workspace/git/log` — same shape as [`TreeQuery`] plus `limit`/`skip`.
#[derive(Deserialize)]
pub struct GitLogQuery {
    pub bot_id: Uuid,
    #[serde(default)]
    pub path: String,
    pub root: Option<String>,
    pub session_id: Option<Uuid>,
    /// Max commits to return (connector clamps to ≤100).
    pub limit: Option<u32>,
    /// Commits to skip before collecting (`git log --skip`) — pagination for the
    /// history view's "Load more" (connector clamps to ≤100000).
    pub skip: Option<u32>,
}

/// `POST workspace/unwatch` — stop a live file watch. Only the connector-issued
/// `watch_id` (plus the target `bot_id`) is needed; no path/root/session.
#[derive(Deserialize)]
pub struct UnwatchQuery {
    pub bot_id: Uuid,
    /// The watch handle returned by `watch` (`{watch_id, ttl_secs}`).
    pub watch_id: String,
}

/// `GET workspace/git/show` (and `git/commit-files`) — commit-detail queries.
/// `commit` is a hex hash (as emitted by `git log`); the repo is located from the
/// session roots / default cwd.
#[derive(Deserialize)]
pub struct GitShowQuery {
    pub bot_id: Uuid,
    /// The commit ref to show (connector validates `^[0-9a-fA-F]{7,64}$`).
    pub commit: String,
    /// Optional repo-root-relative file filter (as listed by `git/commit-files`):
    /// limits the `show` diff to that one file. Ignored by `commit-files`.
    pub path: Option<String>,
    pub root: Option<String>,
    pub session_id: Option<Uuid>,
}

/// Caller must be a channel user-member (or admin); the target bot must itself be a
/// member of the channel — so you can only browse a bot you actually share a channel
/// with. On top of membership, the `workspace/read` policy class must allow the
/// caller (member-ALLOW by default, so nothing changes until the bot owner writes a
/// rule; a deny narrows visibility per role/user/group/channel). Every workspace
/// op — tree/read/git/watch and the write path — flows through here.
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
    if !resolve_can_read(state, claims, channel_id, bot_id).await {
        return Err(AppError::Forbidden(
            "this agent's workspace is not visible to you in this channel".into(),
        ));
    }
    Ok(())
}

/// Whether `claims` may READ (browse/inspect) `bot_id`'s remote workspace in this
/// channel. Bot owner / platform admin always may; everyone else resolves the
/// `workspace/read` policy class — member-ALLOW by default (visibility restriction
/// is opt-in), FAIL-CLOSED on a rules/DB error. Backs [`ensure_access`] and the
/// per-bot `can_read` flag on [`list_workspace_bots`]. Mirrors [`resolve_can_write`].
async fn resolve_can_read(
    state: &AppState,
    claims: &Claims,
    channel_id: Uuid,
    bot_id: Uuid,
) -> bool {
    if crate::api::bots::ensure_bot_owner_or_admin(state, claims, &bot_id.to_string())
        .await
        .is_ok()
    {
        return true;
    }
    let role = caller_channel_role(state, channel_id, &claims.sub).await;
    crate::domain::acp_policy::allows(
        &state.db,
        &bot_id.to_string(),
        &channel_id.to_string(),
        &claims.sub,
        &role,
        "workspace/read",
        Capability::Initiate,
    )
    .await
    .unwrap_or(false) // fail-closed: a rules/DB error denies the read
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
    Ok(Json(
        json!({ "store": "none", "display_name": base, "also_in": also }),
    ))
}

/// On-the-spot validation of a candidate session `cwd` against the bot connector's
/// local policy (`validate_cwd` op): connector online, cwd absolute + inside
/// `allowed_roots` + a real directory, and `backend_may_set_cwd` allowed. Returns
/// the connector's data (`{canonical_path, matched_root, is_dir, backend_may_set_cwd}`)
/// on success, or an `AppError::BadRequest` carrying the connector's `code: message`
/// so the caller can reject the invite/creation before persisting anything.
pub async fn validate_bot_cwd(
    state: &AppState,
    bot_id: Uuid,
    cwd: &str,
) -> Result<Value, AppError> {
    workspace_call(
        state,
        bot_id,
        "validate_cwd",
        cwd,
        None,
        Value::Null,
        None,
        &[],
    )
    .await
}

/// Validate a chosen `cwd` + `additional_dirs` against the bot connector's policy,
/// returning the connector-canonicalized absolute paths — exactly what session
/// start will use. Any invalid entry (connector offline / outside allowed_roots /
/// not a directory / cwd-locked) rejects with the connector's reason. `None` cwd
/// and an empty list pass through with no connector round-trip.
pub async fn validate_workspace_paths(
    state: &AppState,
    bot_id: Uuid,
    cwd: Option<String>,
    additional_dirs: Vec<String>,
) -> Result<(Option<String>, Vec<String>), AppError> {
    fn canonical_of(data: &Value, fallback: String) -> String {
        data.get("canonical_path")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(fallback)
    }
    let cwd = match cwd {
        Some(c) => Some(canonical_of(&validate_bot_cwd(state, bot_id, &c).await?, c)),
        None => None,
    };
    let mut dirs = Vec::with_capacity(additional_dirs.len());
    for d in additional_dirs {
        let data = validate_bot_cwd(state, bot_id, &d).await?;
        dirs.push(canonical_of(&data, d));
    }
    Ok((cwd, dirs))
}

/// Send a `workspace_req` to the bot's connector and await the correlated reply.
///
/// `extra` is a JSON object whose keys are merged into the request frame as
/// top-level fields — this is how op-specific inputs reach the connector's
/// `WorkspaceReq` (e.g. `content_b64` for `write`, `staged` for `git_diff`,
/// `limit` for `git_log`). Pass `Value::Null` (or an empty object) when the op
/// carries no extra fields. `op` strings are forwarded verbatim.
///
/// `if_etag` is the `op == "write"` optimistic-concurrency precondition (safe remote
/// writes): `None` ⇒ unconditional overwrite; `Some("")` ⇒ create-only; `Some(hex)` ⇒
/// overwrite only if the file still hashes to that etag. It's a distinct frame field
/// (JSON `null` when `None`) — orthogonal to `extra`; every non-write caller passes
/// `None`.
async fn workspace_call(
    state: &AppState,
    bot_id: Uuid,
    op: &str,
    path: &str,
    root: Option<&str>,
    extra: Value,
    if_etag: Option<String>,
    roots: &[String],
) -> Result<Value, AppError> {
    if !state.bot_locator.is_online(bot_id).await {
        return Err(AppError::BadRequest("bot connector is offline".into()));
    }
    let req_id = Uuid::new_v4().to_string();
    let rx = state.workspace_rpc.register(req_id.clone());
    let mut frame = json!({
        "type": "workspace_req",
        "req_id": req_id,
        "op": op,
        "path": path,
        "root": root,
        // `op == "write"` precondition; JSON null for every read/git op.
        "if_etag": if_etag,
        // Optional session root set to scope this browse (empty ⇒ full allowed_roots).
        "roots": roots,
    });
    // Merge op-specific fields into the frame as top-level keys.
    if let (Value::Object(dst), Value::Object(src)) = (&mut frame, extra) {
        for (k, v) in src {
            dst.insert(k, v);
        }
    }
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
        let code = res
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("E_WORKSPACE");
        let msg = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("workspace operation failed");
        let full = format!("{code}: {msg}");
        // Map git-specific connector codes to HTTP the client can react to distinctly
        // instead of a generic 400. Everything else stays a BadRequest.
        Err(match code {
            // The directory exists but is not a git repo, or the connector host has
            // no `git` binary: a state conflict, not a malformed request.
            "E_NOT_A_REPO" | "E_GIT_UNAVAILABLE" => AppError::Conflict(full),
            // Connector policy disables git ops.
            "E_GIT_DISABLED" => AppError::Forbidden(full),
            // Optimistic-concurrency clash on a write: the file changed under the
            // caller (If-Match precondition failed). Carry the connector's
            // `current_etag` + `size_bytes` as a JSON body so the client can rebase and
            // retry (see `AppError`'s IntoResponse — a Conflict whose payload is a JSON
            // object surfaces that object directly).
            "E_CONFLICT" => {
                let data = res.get("data");
                AppError::Conflict(
                    json!({
                        "detail": full,
                        "current_etag": data
                            .and_then(|d| d.get("current_etag"))
                            .cloned()
                            .unwrap_or(Value::Null),
                        "size_bytes": data
                            .and_then(|d| d.get("size_bytes"))
                            .cloned()
                            .unwrap_or(Value::Null),
                    })
                    .to_string(),
                )
            }
            // The connector refused the write because the payload exceeds its size cap.
            "E_TOO_LARGE" => AppError::PayloadTooLarge(full),
            _ => AppError::BadRequest(full),
        })
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

    let mut bots: Vec<Value> = Vec::with_capacity(rows.len());
    for (bot_id, username, display_name) in rows {
        let parsed = Uuid::parse_str(&bot_id).ok();
        let online = match parsed {
            Some(id) => state.bot_locator.is_online(id).await,
            None => false,
        };
        // Per-caller read/write authorization for this bot's workspace (the same
        // gates the browse/PUT paths use), so the UI can show/hide affordances
        // without probing.
        let can_read = match parsed {
            Some(id) => resolve_can_read(&state, &claims, channel_id, id).await,
            None => false,
        };
        // A caller who can't see the workspace can't write to it either.
        let can_write = can_read
            && match parsed {
                Some(id) => resolve_can_write(&state, &claims, channel_id, id).await,
                None => false,
            };
        bots.push(json!({
            "bot_id": bot_id,
            "username": username,
            "display_name": display_name,
            "online": online,
            "can_read": can_read,
            "can_write": can_write,
        }));
    }
    Ok(Json(json!({ "bots": bots })))
}

/// Resolve the root set to scope a browse to: the given session's
/// `[cwd?, ...additional_dirs]`, or empty (bot-wide `allowed_roots`) when no session
/// is specified or it doesn't belong to the bot.
async fn browse_roots(state: &AppState, bot_id: Uuid, session_id: Option<Uuid>) -> Vec<String> {
    let Some(sid) = session_id else {
        return Vec::new();
    };
    let key: Option<String> = sqlx::query_scalar(
        "SELECT provider_session_key FROM cheers_sessions WHERE session_id = $1 AND bot_id = $2",
    )
    .bind(sid.to_string())
    .bind(bot_id.to_string())
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    match key {
        Some(k) => crate::domain::sessions::session_root_set(&state.db, &k).await,
        None => Vec::new(),
    }
}

/// GET /api/v1/channels/:channel_id/workspace/tree?bot_id=&path=&root=&session_id=
pub async fn get_tree(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "ls",
        &q.path,
        q.root.as_deref(),
        Value::Null,
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/file?bot_id=&path=&root=&session_id=
pub async fn get_file(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<FileQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "read",
        &q.path,
        q.root.as_deref(),
        Value::Null,
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// The caller's channel role for the write gate, best-effort (`"member"` when there's
/// no membership row or the lookup fails). This only *widens* the acp_policy query;
/// the actual fail-closed decision is [`resolve_can_write`]'s `unwrap_or(false)`.
async fn caller_channel_role(state: &AppState, channel_id: Uuid, user_id: &str) -> String {
    sqlx::query(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get::<Option<String>, _>("role").ok().flatten())
    .unwrap_or_else(|| "member".to_string())
}

/// Whether `claims` may WRITE to `bot_id`'s remote workspace in this channel. The bot
/// owner / platform admin always may (they own the bot-level default); every other
/// caller needs an explicit INITIATE grant for the `workspace/write` event. FAIL-CLOSED
/// — a rules/DB error resolves to `false`. Backs both [`gate_write`] (the PUT gate) and
/// the per-bot `can_write` flag on [`list_workspace_bots`]. Mirrors
/// `session_control::gate_initiate`.
async fn resolve_can_write(
    state: &AppState,
    claims: &Claims,
    channel_id: Uuid,
    bot_id: Uuid,
) -> bool {
    if crate::api::bots::ensure_bot_owner_or_admin(state, claims, &bot_id.to_string())
        .await
        .is_ok()
    {
        return true;
    }
    let role = caller_channel_role(state, channel_id, &claims.sub).await;
    crate::domain::acp_policy::allows(
        &state.db,
        &bot_id.to_string(),
        &channel_id.to_string(),
        &claims.sub,
        &role,
        "workspace/write",
        Capability::Initiate,
    )
    .await
    .unwrap_or(false) // fail-closed: a rules/DB error denies the write
}

/// FAIL-CLOSED write gate applied AFTER `ensure_access` on the PUT path. Reads
/// (ls/read/git) stay membership-only; only writes require an explicit grant.
async fn gate_write(
    state: &AppState,
    claims: &Claims,
    channel_id: Uuid,
    bot_id: Uuid,
) -> Result<(), AppError> {
    if resolve_can_write(state, claims, channel_id, bot_id).await {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "you are not authorized to write to this agent's workspace here".into(),
        ))
    }
}

/// Parse an `If-Match` request header into the connector's optimistic-concurrency
/// precondition:
/// - header ABSENT      → `None`      (unconditional overwrite)
/// - header present, EMPTY → `Some("")` (create-only: fail if the file already exists)
/// - `"<etag>"` / `<etag>` → `Some(hex)` (overwrite only if the file still has this etag)
///
/// Surrounding double quotes (the HTTP ETag form) are trimmed. A non-UTF-8 header value
/// is treated as absent (unconditional).
fn parse_if_match(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::IF_MATCH)?;
    let s = raw.to_str().ok()?.trim();
    let s = s.strip_prefix('"').unwrap_or(s);
    let s = s.strip_suffix('"').unwrap_or(s);
    Some(s.to_string())
}

/// PUT /api/v1/channels/:channel_id/workspace/file?bot_id=&path=&root=&session_id= (raw bytes body)
pub async fn put_file(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    gate_write(&state, &claims, channel_id, q.bot_id).await?;
    let if_etag = parse_if_match(&headers);
    let raw_len = body.len(); // audited size is the raw body, pre-base64
    let content_b64 = B64.encode(&body);
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "write",
        &q.path,
        q.root.as_deref(),
        json!({ "content_b64": content_b64 }),
        if_etag,
        &roots,
    )
    .await?;

    // Best-effort audit: the write already landed on the connector, so a bookkeeping
    // failure is logged, never propagated (it must not turn a successful write into an
    // error). One `channel_operations` row records who wrote what.
    if let Ok(user_id) = Uuid::parse_str(&claims.sub) {
        let root = q.root.as_deref().unwrap_or("");
        let target_ref = format!("{}:{}:{}", q.bot_id, root, q.path);
        let payload = json!({
            "path": q.path,
            "size_bytes": raw_len,
            "etag": data.get("etag").cloned().unwrap_or(Value::Null),
        });
        if let Err((code, msg)) = crate::resource::fs::record_operation(
            &state.db,
            channel_id,
            "workspace.write",
            crate::resource::Principal::user(user_id),
            &target_ref,
            payload,
        )
        .await
        {
            tracing::error!(
                channel_id = %channel_id,
                bot_id = %q.bot_id,
                code = %code,
                error = %msg,
                "failed to record workspace.write audit"
            );
        }
    }
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/git/status?bot_id=&path=&root=&session_id=
/// Read-only `git status --porcelain=v2 --branch` for the resolved workdir.
pub async fn get_git_status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = match workspace_call(
        &state,
        q.bot_id,
        "git_status",
        &q.path,
        q.root.as_deref(),
        Value::Null,
        None,
        &roots,
    )
    .await
    {
        Ok(d) => d,
        // A non-repo directory (or a connector host without git) is a NORMAL state
        // for this endpoint — the workspace dialog re-polls it on every live refresh,
        // so answering with 409 turns routine browsing into an error stream. Answer
        // as data instead; git/diff|log|show keep the 409 (user-initiated, git UI
        // only shows on a repo). Matched on the "CODE: message" prefix that
        // workspace_call formats into the Conflict payload.
        Err(AppError::Conflict(msg))
            if msg.starts_with("E_NOT_A_REPO") || msg.starts_with("E_GIT_UNAVAILABLE") =>
        {
            json!({ "repo": false, "reason": msg })
        }
        Err(e) => return Err(e),
    };
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/git/diff?bot_id=&path=&root=&session_id=&staged=
/// Read-only `git diff --no-color [--staged] [-- <path>]`.
pub async fn get_git_diff(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<GitDiffQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "git_diff",
        &q.path,
        q.root.as_deref(),
        json!({ "staged": q.staged.unwrap_or(false) }),
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/git/log?bot_id=&path=&root=&session_id=&limit=
/// Read-only `git log` (hash/author/date/subject), newest first, `limit` clamped ≤100.
pub async fn get_git_log(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<GitLogQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let extra = json!({ "limit": q.limit, "skip": q.skip });
    let data = workspace_call(
        &state,
        q.bot_id,
        "git_log",
        &q.path,
        q.root.as_deref(),
        extra,
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/git/show?bot_id=&commit=&path=&root=&session_id=
/// Read-only `git show --no-color <commit> [-- <path>]` → `{ commit, path?, diff }`.
/// The browse `path` is "" — the repo is located from the session roots / default
/// cwd; `q.path` is the optional per-file filter within the commit.
pub async fn get_git_show(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<GitShowQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "git_show",
        "",
        q.root.as_deref(),
        json!({ "commit": q.commit, "commit_path": q.path }),
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/git/commit-files?bot_id=&commit=&root=&session_id=
/// A commit's changed-file list (`git show --name-status`, no diff body) →
/// `{ commit, files: [{status, path, old_path?}] }` — lets the UI render a
/// per-commit file list and fetch single-file diffs lazily via `git/show?path=`.
pub async fn get_git_commit_files(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<GitShowQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "git_commit_files",
        "",
        q.root.as_deref(),
        json!({ "commit": q.commit }),
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// GET /api/v1/channels/:channel_id/workspace/meta?bot_id=&session_id=
/// The connector's workspace policy description: `{ allowed_roots, effective_roots,
/// default_cwd, backend_may_set_cwd, git_ops, max_read_bytes, max_write_bytes }`.
/// Backs the dialog's root picker and the session dialogs' "pick from allowed
/// roots" affordance (instead of typing absolute paths blind).
pub async fn get_workspace_meta(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "workspace_meta",
        "",
        None,
        Value::Null,
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// POST /api/v1/channels/:channel_id/workspace/watch?bot_id=&path=&root=&session_id=
/// Start a live file watch on the resolved workdir. The connector pushes
/// `workspace_event` frames as files change (relayed to browsers as
/// `workspace_signal`); this returns the connector's `{watch_id, ttl_secs}` so the
/// client can renew/stop it. Membership-only (same gate as the read ops).
pub async fn watch_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    let roots = browse_roots(&state, q.bot_id, q.session_id).await;
    let data = workspace_call(
        &state,
        q.bot_id,
        "watch",
        &q.path,
        q.root.as_deref(),
        Value::Null,
        None,
        &roots,
    )
    .await?;
    Ok(Json(data))
}

/// POST /api/v1/channels/:channel_id/workspace/unwatch?bot_id=&watch_id=
/// Stop a live file watch. The `watch_id` is threaded to the connector via `extra`
/// (it reads a top-level `watch_id` frame field). Returns `{ok}`.
pub async fn unwatch_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<UnwatchQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_access(&state, &claims, channel_id, q.bot_id).await?;
    workspace_call(
        &state,
        q.bot_id,
        "unwatch",
        "",
        None,
        json!({ "watch_id": q.watch_id }),
        None,
        &[],
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}
