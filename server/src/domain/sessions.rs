use chrono::Utc;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::errors::AppError;

const PROVIDER: &str = "acp";
const PROVIDER_AGENT_ID: &str = "main";

pub const SESSION_SCOPE_CHANNEL: &str = "channel"; // also covers DM (DM = type='dm' channel)
pub const SESSION_SCOPE_TASK: &str = "task";
pub const SESSION_SCOPE_WORKSPACE: &str = "workspace";
pub const SESSION_SCOPE_GLOBAL: &str = "global";
pub const SESSION_SCOPE_USER: &str = "user";

pub const SESSION_STATUS_ACTIVE: &str = "active";
pub const SESSION_STATUS_BUSY: &str = "busy";
pub const SESSION_STATUS_IDLE: &str = "idle";
pub const SESSION_STATUS_PAUSED: &str = "paused";
pub const SESSION_STATUS_TERMINATED: &str = "terminated";
pub const SESSION_STATUS_REVOKED: &str = "revoked";
pub const SESSION_STATUS_EXPIRED: &str = "expired";
pub const SESSION_STATUS_ERROR: &str = "error";

pub fn normalize_scope_type(raw: &str) -> &str {
    match raw {
        SESSION_SCOPE_CHANNEL
        | SESSION_SCOPE_TASK
        | SESSION_SCOPE_WORKSPACE
        | SESSION_SCOPE_GLOBAL
        | SESSION_SCOPE_USER => raw,
        // "dm" (and anything unknown) folds into channel — a DM is a type='dm' channel.
        _ => SESSION_SCOPE_CHANNEL,
    }
}

fn scope_columns(
    scope_type: &str,
    scope_id: &str,
    _task_id: Option<&str>,
) -> (Option<String>, Option<String>) {
    let scope_id = scope_id.to_string();
    match scope_type {
        SESSION_SCOPE_CHANNEL => (Some(scope_id), None),
        SESSION_SCOPE_TASK => (None, Some(scope_id)),
        SESSION_SCOPE_WORKSPACE | SESSION_SCOPE_GLOBAL | SESSION_SCOPE_USER => (None, None),
        _ => (Some(scope_id), None), // dm + unknown → channel
    }
}

fn fallback_task_id(scope_type: &str, scope_id: &str, provided: Option<&str>) -> Option<String> {
    match scope_type {
        SESSION_SCOPE_TASK => Some(scope_id.to_string()),
        SESSION_SCOPE_CHANNEL => provided.and_then(|v| {
            if v.is_empty() {
                None
            } else {
                Some(v.to_string())
            }
        }),
        _ => provided.and_then(|v| {
            if v.is_empty() {
                None
            } else {
                Some(v.to_string())
            }
        }),
    }
}

#[derive(Debug)]
pub struct SessionHandle {
    pub session_id: Uuid,
    /// The connector resume key for this session (scope-derived for the primary,
    /// `cheers:session:{id}` for an "other" session).
    pub provider_session_key: String,
}

/// 依据 provider 维度创建/复用 session，并绑定当前 scope。
pub async fn acquire_scope_session(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    provider_session_key: &str,
    scope_type: &str,
    scope_id: &str,
    task_id: Option<&str>,
    role: &str,
) -> Result<SessionHandle, AppError> {
    let scope_type = normalize_scope_type(scope_type);
    let scope_id = scope_id.trim();
    if scope_id.is_empty() {
        return Err(AppError::BadRequest("scope_id can not be empty".into()));
    }
    let provider_account_id = provider_account_id.trim();
    if provider_account_id.is_empty() {
        return Err(AppError::BadRequest(
            "provider_account_id can not be empty".into(),
        ));
    }

    let now = Utc::now();
    let session_id: String = sqlx::query_scalar(
        "INSERT INTO cheers_sessions (
            session_id, bot_id, provider, provider_account_id, provider_agent_id,
            provider_session_key, provider_session_id, current_scope_type, current_scope_id,
            status, metadata, last_used_at, created_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, '{}'::jsonb, $10, $10, $10
        )
        ON CONFLICT (provider, provider_account_id, provider_session_key)
        DO UPDATE SET
            bot_id = EXCLUDED.bot_id,
            current_scope_type = EXCLUDED.current_scope_type,
            current_scope_id = EXCLUDED.current_scope_id,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at,
            last_used_at = EXCLUDED.last_used_at
        RETURNING session_id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(bot_id.to_string())
    .bind(PROVIDER)
    .bind(provider_account_id)
    .bind(PROVIDER_AGENT_ID)
    .bind(provider_session_key)
    .bind(scope_type)
    .bind(scope_id)
    .bind(SESSION_STATUS_BUSY)
    .bind(now)
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?;

    let session_uuid = Uuid::parse_str(&session_id)
        .map_err(|_| AppError::Internal("invalid session_id".into()))?;
    upsert_session_binding(
        db,
        &session_uuid,
        bot_id,
        provider_account_id,
        scope_type,
        scope_id,
        fallback_task_id(scope_type, scope_id, task_id),
        role,
    )
    .await?;

    Ok(SessionHandle {
        session_id: session_uuid,
        provider_session_key: provider_session_key.to_string(),
    })
}

/// Build the `metadata` jsonb for a new session: `{}` when no workspace is pinned,
/// else `{"workspace": {"cwd", "additional_dirs"}}` — the per-session ACP root set
/// (`[cwd, ...additional_dirs]`). Paths are stored verbatim; the connector
/// re-validates them against its local `allowed_roots`.
pub fn workspace_metadata(cwd: Option<&str>, additional_dirs: &[String]) -> Value {
    if cwd.is_none() && additional_dirs.is_empty() {
        return json!({});
    }
    json!({
        "workspace": {
            "cwd": cwd,
            "additional_dirs": additional_dirs,
        }
    })
}

/// Create an additional ("other") session bound to a channel, keyed by its own
/// `session_id` (`cheers:session:{id}`) so it's addressed independently of the
/// channel's primary. Topic-free: extras are distinguished by session_id + the
/// non-primary binding role, never by a label. An optional `cwd` +
/// `additional_dirs` pin the session's ACP root set (stored in `metadata.workspace`).
pub async fn create_channel_session(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    channel_id: &str,
    role: &str,
    cwd: Option<&str>,
    additional_dirs: &[String],
) -> Result<SessionHandle, AppError> {
    let provider_account_id = provider_account_id.trim();
    if provider_account_id.is_empty() {
        return Err(AppError::BadRequest(
            "provider_account_id can not be empty".into(),
        ));
    }
    let channel_id = channel_id.trim();
    if channel_id.is_empty() {
        return Err(AppError::BadRequest("channel_id can not be empty".into()));
    }
    let session_uuid = Uuid::new_v4();
    let provider_session_key = format!("cheers:session:{session_uuid}");
    let now = Utc::now();
    let metadata = workspace_metadata(cwd, additional_dirs);
    sqlx::query(
        "INSERT INTO cheers_sessions (
            session_id, bot_id, provider, provider_account_id, provider_agent_id,
            provider_session_key, provider_session_id, current_scope_type, current_scope_id,
            status, metadata, last_used_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $11::jsonb, $10, $10, $10)",
    )
    .bind(session_uuid.to_string())
    .bind(bot_id.to_string())
    .bind(PROVIDER)
    .bind(provider_account_id)
    .bind(PROVIDER_AGENT_ID)
    .bind(&provider_session_key)
    .bind(SESSION_SCOPE_CHANNEL)
    .bind(channel_id)
    .bind(SESSION_STATUS_IDLE)
    .bind(now)
    .bind(metadata)
    .execute(db)
    .await
    .map_err(AppError::Db)?;

    upsert_session_binding(
        db,
        &session_uuid,
        bot_id,
        provider_account_id,
        SESSION_SCOPE_CHANNEL,
        channel_id,
        None,
        role,
    )
    .await?;

    Ok(SessionHandle {
        session_id: session_uuid,
        provider_session_key,
    })
}

/// The scope-derived provider session key for a channel's PRIMARY session — stable
/// across turns so the lazy (first-message) and eager (invite-time) paths converge
/// on the same row via `ON CONFLICT`. Mirrors the key used in `messages`/`chains`.
pub fn primary_provider_session_key(channel_id: &str, bot_id: Uuid) -> String {
    format!("cheers:channel:{channel_id}:bot:{bot_id}")
}

/// Eagerly ensure a channel's PRIMARY session exists for a bot, pinning its ACP
/// workspace (`metadata.workspace`) when the row is created here. Inviting a bot
/// into a channel = creating its primary session
/// (docs/arch/SESSION_WORKDIR_ROOTSET.md). **Idempotent**: if the primary already
/// exists (lazily created on first message, or a prior invite), the workspace is
/// LEFT UNCHANGED — `cwd` is immutable for a session's lifetime (ACP). Returns the
/// primary's handle either way.
pub async fn ensure_primary_session_workspace(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    channel_id: &str,
    cwd: Option<&str>,
    additional_dirs: &[String],
) -> Result<SessionHandle, AppError> {
    let provider_account_id = provider_account_id.trim();
    if provider_account_id.is_empty() {
        return Err(AppError::BadRequest(
            "provider_account_id can not be empty".into(),
        ));
    }
    let channel_id = channel_id.trim();
    if channel_id.is_empty() {
        return Err(AppError::BadRequest("channel_id can not be empty".into()));
    }
    let provider_session_key = primary_provider_session_key(channel_id, bot_id);
    let now = Utc::now();
    let metadata = workspace_metadata(cwd, additional_dirs);
    // Insert-if-absent, pinning the workspace on creation. On conflict, a no-op
    // touch of `updated_at` so we still get the existing session_id back WITHOUT
    // overwriting the immutable `metadata.workspace`.
    let session_id: String = sqlx::query_scalar(
        "INSERT INTO cheers_sessions (
            session_id, bot_id, provider, provider_account_id, provider_agent_id,
            provider_session_key, provider_session_id, current_scope_type, current_scope_id,
            status, metadata, last_used_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $11::jsonb, $10, $10, $10)
        ON CONFLICT (provider, provider_account_id, provider_session_key)
        DO UPDATE SET updated_at = EXCLUDED.updated_at
        RETURNING session_id",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(bot_id.to_string())
    .bind(PROVIDER)
    .bind(provider_account_id)
    .bind(PROVIDER_AGENT_ID)
    .bind(&provider_session_key)
    .bind(SESSION_SCOPE_CHANNEL)
    .bind(channel_id)
    .bind(SESSION_STATUS_IDLE)
    .bind(now)
    .bind(metadata)
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?;

    let session_uuid = Uuid::parse_str(&session_id)
        .map_err(|_| AppError::Internal("invalid session_id".into()))?;
    // A promoted primary (set_primary_session) must survive a re-invite: only
    // (re)bind the deterministic session as primary when no live primary binding
    // exists for this scope. When the deterministic session already IS the
    // primary, the upsert would be a no-op anyway.
    if resolve_primary_session(db, bot_id, channel_id).await?.is_none() {
        upsert_session_binding(
            db,
            &session_uuid,
            bot_id,
            provider_account_id,
            SESSION_SCOPE_CHANNEL,
            channel_id,
            None,
            "primary",
        )
        .await?;
    }

    Ok(SessionHandle {
        session_id: session_uuid,
        provider_session_key,
    })
}

/// A session's ACP root set as a flat list `[cwd?, ...additional_dirs]` — for
/// passing to the connector to scope a browse or a realize to the session's roots.
/// Empty when the session has no pinned workspace (the connector then falls back to
/// its `default_cwd`). Best-effort: a DB error yields an empty list.
pub async fn session_root_set(db: &PgPool, provider_session_key: &str) -> Vec<String> {
    let ws: Option<Value> = sqlx::query_scalar::<_, Option<Value>>(
        "SELECT metadata->'workspace' FROM cheers_sessions WHERE provider_session_key = $1 LIMIT 1",
    )
    .bind(provider_session_key)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .flatten();
    let mut out = Vec::new();
    if let Some(ws) = ws {
        if let Some(cwd) = ws.get("cwd").and_then(|v| v.as_str()) {
            out.push(cwd.to_string());
        }
        if let Some(dirs) = ws.get("additional_dirs").and_then(|v| v.as_array()) {
            out.extend(dirs.iter().filter_map(|d| d.as_str().map(str::to_string)));
        }
    }
    out
}

/// Distinct workspace `cwd`s of the sessions bound to a channel for a bot, most-
/// recently-used first, each paired with the session that owns it. Feeds the remote-
/// workspace root picker so it can offer the folders this channel's sessions actually
/// work in — and browsing one scopes to that session's root set (so the connector
/// accepts it as a `root`). Deduped by path (keeps the most-recent session per path);
/// entries without a pinned `cwd` are skipped. Best-effort: a DB error yields `[]`.
pub async fn channel_session_workdirs(
    db: &PgPool,
    channel_id: Uuid,
    bot_id: Uuid,
) -> Vec<(String, String)> {
    let rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT s.session_id, s.metadata->'workspace'->>'cwd' AS cwd
           FROM cheers_sessions s
           JOIN cheers_session_bindings b ON b.session_id = s.session_id
          WHERE b.channel_id = $1 AND s.bot_id = $2
          ORDER BY s.last_used_at DESC",
    )
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .fetch_all(db)
    .await
    .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (session_id, cwd) in rows {
        if let Some(cwd) = cwd {
            if cwd.is_empty() || !seen.insert(cwd.clone()) {
                continue;
            }
            out.push((cwd, session_id));
        }
    }
    out
}

/// Update **only** `metadata.workspace.additional_dirs` for a session, preserving
/// the immutable `cwd`. This is the mutable lever of the ACP root set: extra
/// accessible roots may change across loads while `cwd` stays fixed. Takes effect
/// on the session's next task/load (which resends the full `additionalDirectories`
/// list). Returns `NotFound` if the session doesn't belong to `bot_id`.
pub async fn set_session_additional_dirs(
    db: &PgPool,
    bot_id: Uuid,
    session_id: Uuid,
    additional_dirs: &[String],
) -> Result<(), AppError> {
    let dirs = serde_json::to_value(additional_dirs)
        .map_err(|e| AppError::Internal(format!("serialize additional_dirs: {e}")))?;
    // Shallow-merge a rebuilt `workspace` object so `cwd` (and any other keys)
    // survive: keep the existing workspace, overwrite only `additional_dirs`.
    let updated: Option<String> = sqlx::query_scalar(
        "UPDATE cheers_sessions
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'workspace',
                 COALESCE(metadata->'workspace', '{}'::jsonb)
                     || jsonb_build_object('additional_dirs', $1::jsonb)),
             updated_at = now()
         WHERE session_id = $2 AND bot_id = $3
         RETURNING session_id",
    )
    .bind(dirs)
    .bind(session_id.to_string())
    .bind(bot_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?;
    updated.map(|_| ()).ok_or(AppError::NotFound)
}

/// Resolve the channel's CURRENT primary session for a bot. The `role='primary'`
/// binding is the authoritative pointer — `set_primary_session` can re-point it at
/// a promoted "other" session, so dispatch must consult it BEFORE falling back to
/// the scope-derived deterministic key (which lazily creates the default primary
/// on first message). Same liveness rule as the switcher: no `detached_at` filter
/// (bindings detach on finalize but stay authoritative); exclude only truly-closed
/// sessions, so a terminated primary falls back cleanly.
pub async fn resolve_primary_session(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: &str,
) -> Result<Option<(Uuid, String)>, AppError> {
    let row = sqlx::query(
        "SELECT s.session_id, s.provider_session_key
         FROM cheers_session_bindings b
         JOIN cheers_sessions s ON s.session_id = b.session_id
         WHERE b.bot_id = $1 AND b.scope_type = $2 AND b.scope_id = $3
           AND b.role = 'primary'
           AND s.status NOT IN ('terminated', 'revoked', 'expired')
         LIMIT 1",
    )
    .bind(bot_id.to_string())
    .bind(SESSION_SCOPE_CHANNEL)
    .bind(channel_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?;
    Ok(row.and_then(|r| {
        let sid = r
            .try_get::<String, _>("session_id")
            .ok()
            .and_then(|v| Uuid::parse_str(&v).ok())?;
        let key = r.try_get::<String, _>("provider_session_key").ok()?;
        Some((sid, key))
    }))
}

/// Make an existing channel session the bot's PRIMARY — the session Auto/mention
/// messages route to. The binding role is the source of truth: demote the current
/// primary binding to 'other' and promote the target, in one transaction (the
/// partial-unique index `uq_cheers_session_binding_primary` allows at most one
/// primary per bot+scope, so demote must land first). Session keys are left
/// untouched — the promoted session keeps its own `provider_session_key`, so the
/// connector-side ACP session (and its history) follows the promotion, and the
/// demoted session stays addressable as an "other" session.
pub async fn set_primary_session(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: &str,
    session_id: Uuid,
) -> Result<(), AppError> {
    let mut tx = db.begin().await.map_err(AppError::Db)?;
    // Demote whatever holds the primary role now (skip if the target already does,
    // making a re-promote a no-op instead of a demote-then-fail).
    sqlx::query(
        "UPDATE cheers_session_bindings SET role = 'other'
         WHERE bot_id = $1 AND scope_type = $2 AND scope_id = $3
           AND role = 'primary' AND session_id <> $4",
    )
    .bind(bot_id.to_string())
    .bind(SESSION_SCOPE_CHANNEL)
    .bind(channel_id)
    .bind(session_id.to_string())
    .execute(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    // Promote the target's binding (and re-attach it). RETURNING → NotFound when
    // the session isn't bound to this channel+bot; the tx rolls back on drop, so
    // the demote above never sticks without a new primary.
    let promoted: Option<String> = sqlx::query_scalar(
        "UPDATE cheers_session_bindings SET role = 'primary', detached_at = NULL
         WHERE bot_id = $1 AND scope_type = $2 AND scope_id = $3 AND session_id = $4
         RETURNING binding_id",
    )
    .bind(bot_id.to_string())
    .bind(SESSION_SCOPE_CHANNEL)
    .bind(channel_id)
    .bind(session_id.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::Db)?;
    if promoted.is_none() {
        return Err(AppError::NotFound);
    }
    tx.commit().await.map_err(AppError::Db)?;
    Ok(())
}

/// A channel's sessions for a bot (primary first), for the session switcher.
pub async fn list_channel_sessions(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: &str,
) -> Result<Vec<Value>, AppError> {
    let rows = sqlx::query(
        // No detached_at filter: bindings are detached on every finalize, but an
        // idle session stays addressable. Exclude only truly-closed sessions.
        "SELECT s.session_id, b.role, s.status, s.provider_session_key, s.last_used_at, s.metadata
         FROM cheers_session_bindings b
         JOIN cheers_sessions s ON s.session_id = b.session_id
         WHERE b.bot_id = $1 AND b.scope_type = $2 AND b.scope_id = $3
           AND s.status NOT IN ('terminated', 'revoked', 'expired')
         ORDER BY (b.role = 'primary') DESC, s.last_used_at DESC",
    )
    .bind(bot_id.to_string())
    .bind(SESSION_SCOPE_CHANNEL)
    .bind(channel_id)
    .fetch_all(db)
    .await
    .map_err(AppError::Db)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let role: String = r.try_get("role").unwrap_or_default();
            // The session's mode/config overrides (set via set_mode / set_config_option),
            // so the UI can show each session's *current* mode + config values.
            let session_config = r
                .try_get::<Option<Value>, _>("metadata")
                .ok()
                .flatten()
                .and_then(|m| m.get("session_config").cloned())
                .unwrap_or_else(|| json!({}));
            json!({
                "session_id": r.try_get::<String, _>("session_id").unwrap_or_default(),
                "role": role.clone(),
                "is_primary": role == "primary",
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
                "last_used_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("last_used_at")
                    .map(|t| t.to_rfc3339()).unwrap_or_default(),
                "session_config": session_config,
            })
        })
        .collect())
}

/// Resolve a session targeted by a message, verifying it is bound to the given
/// channel (so a message can't target a session from another channel). Returns
/// `(bot_id, provider_session_key)` to dispatch with.
pub async fn resolve_channel_session(
    db: &PgPool,
    channel_id: &str,
    session_id: Uuid,
) -> Result<(Uuid, String), AppError> {
    let row = sqlx::query(
        "SELECT s.bot_id, s.provider_session_key
         FROM cheers_session_bindings b
         JOIN cheers_sessions s ON s.session_id = b.session_id
         WHERE b.scope_type = $1 AND b.scope_id = $2
           AND b.session_id = $3
           AND s.status NOT IN ('terminated', 'revoked', 'expired')
         LIMIT 1",
    )
    .bind(SESSION_SCOPE_CHANNEL)
    .bind(channel_id)
    .bind(session_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .ok_or(AppError::NotFound)?;
    let bot_id = row
        .try_get::<String, _>("bot_id")
        .ok()
        .and_then(|v| Uuid::parse_str(&v).ok())
        .ok_or(AppError::NotFound)?;
    let key = row
        .try_get::<String, _>("provider_session_key")
        .map_err(|_| AppError::NotFound)?;
    Ok((bot_id, key))
}

/// Close a channel session: mark it terminated + detach its binding, so it drops
/// out of the switcher and can no longer be targeted. Verifies it is bound (active)
/// to the channel first. Cheers-level only — the agent's ACP session is left to go
/// idle (no `session/delete` round-trip needed).
///
/// Also demotes a `role='primary'` binding to `'other'`: `uq_cheers_session_binding_primary`
/// only cares about `role`, not `detached_at`/session status, so a terminated
/// session left at role='primary' permanently occupies the scope's primary slot
/// — no other session (including the deterministic fallback) could ever be
/// (re)promoted to primary for this bot+scope again. The demotion can't be
/// gated on `detached_at IS NULL`: `finalize_session` detaches the binding
/// after every turn, so a primary that has ever done work already has
/// `detached_at` set while still being live/addressable (the switcher's rule
/// is status-based, not detached_at-based) — that guard would silently skip
/// the demotion on exactly the sessions most likely to be closed.
pub async fn close_channel_session(
    db: &PgPool,
    channel_id: &str,
    session_id: Uuid,
) -> Result<(), AppError> {
    // Reuse the bound-to-this-channel check (errors NotFound if not).
    resolve_channel_session(db, channel_id, session_id).await?;
    let now = Utc::now();
    sqlx::query("UPDATE cheers_sessions SET status = $1, updated_at = $2 WHERE session_id = $3")
        .bind(SESSION_STATUS_TERMINATED)
        .bind(now)
        .bind(session_id.to_string())
        .execute(db)
        .await
        .map_err(AppError::Db)?;
    sqlx::query(
        "UPDATE cheers_session_bindings
         SET detached_at = COALESCE(detached_at, $1),
             role = CASE WHEN role = 'primary' THEN 'other' ELSE role END
         WHERE session_id = $2",
    )
    .bind(now)
    .bind(session_id.to_string())
    .execute(db)
    .await
    .map_err(AppError::Db)?;
    Ok(())
}

async fn upsert_session_binding(
    db: &PgPool,
    session_id: &Uuid,
    bot_id: Uuid,
    provider_account_id: &str,
    scope_type: &str,
    scope_id: &str,
    task_id: Option<String>,
    role: &str,
) -> Result<(), AppError> {
    let (channel_id, binding_task_id) = scope_columns(scope_type, scope_id, task_id.as_deref());
    // Conflict target is `uq_cheers_session_binding_session_scope` (session_id,
    // scope_type, scope_id) — this session's OWN prior binding to this scope,
    // not the bot+scope primary-only partial index. A session demoted to
    // 'other' (set_primary_session) still holds that row, so re-acquiring it
    // (e.g. the deterministic primary falling back after its promoted
    // replacement closes) must update it in place rather than attempt a second
    // insert, which would violate the same-session unique constraint.
    // `uq_cheers_session_binding_primary` (bot+scope, role='primary') still
    // guards against two different sessions racing to hold primary.
    sqlx::query(
        "INSERT INTO cheers_session_bindings (
            binding_id, session_id, bot_id, provider, provider_account_id, provider_agent_id,
            scope_type, scope_id, channel_id, task_id, role, created_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
        )
        ON CONFLICT (session_id, scope_type, scope_id)
        DO UPDATE SET
            role = EXCLUDED.role,
            detached_at = NULL,
            bot_id = EXCLUDED.bot_id,
            provider = EXCLUDED.provider,
            provider_account_id = EXCLUDED.provider_account_id,
            provider_agent_id = EXCLUDED.provider_agent_id,
            task_id = EXCLUDED.task_id,
            channel_id = EXCLUDED.channel_id,
            created_at = EXCLUDED.created_at
        ",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(session_id.to_string())
    .bind(bot_id.to_string())
    .bind(PROVIDER)
    .bind(provider_account_id)
    .bind(PROVIDER_AGENT_ID)
    .bind(scope_type)
    .bind(scope_id)
    .bind(channel_id)
    .bind(binding_task_id.or(task_id))
    .bind(role)
    .execute(db)
    .await
    .map_err(AppError::Db)?;

    Ok(())
}

pub async fn touch_session(db: &PgPool, session_id: Uuid) -> Result<(), AppError> {
    let now = Utc::now();
    sqlx::query(
        "UPDATE cheers_sessions
         SET status = $1, last_used_at = $2, updated_at = $2
         WHERE session_id = $3",
    )
    .bind(SESSION_STATUS_BUSY)
    .bind(now)
    .bind(session_id.to_string())
    .execute(db)
    .await
    .map_err(AppError::Db)?;

    Ok(())
}

pub async fn finalize_session(db: &PgPool, session_id: Uuid) -> Result<(), AppError> {
    let now = Utc::now();
    sqlx::query(
        "UPDATE cheers_sessions
         SET status = $1, last_used_at = $2, updated_at = $2
         WHERE session_id = $3",
    )
    .bind(SESSION_STATUS_IDLE)
    .bind(now)
    .bind(session_id.to_string())
    .execute(db)
    .await
    .map_err(AppError::Db)?;

    sqlx::query(
        "UPDATE cheers_session_bindings
         SET detached_at = COALESCE(detached_at, $1)
         WHERE session_id = $2 AND detached_at IS NULL",
    )
    .bind(now)
    .bind(session_id.to_string())
    .execute(db)
    .await
    .map_err(AppError::Db)?;

    Ok(())
}

pub async fn resolve_session_id_by_key(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    provider_session_key: &str,
) -> Result<Uuid, AppError> {
    sqlx::query(
        "SELECT session_id FROM cheers_sessions
         WHERE provider = $1
           AND provider_account_id = $2
           AND bot_id = $3
           AND provider_session_key = $4
         LIMIT 1",
    )
    .bind(PROVIDER)
    .bind(provider_account_id)
    .bind(bot_id.to_string())
    .bind(provider_session_key)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .and_then(|row| row.try_get::<String, _>("session_id").ok())
    .and_then(|value| Uuid::parse_str(&value).ok())
    .ok_or_else(|| AppError::NotFound)
}

pub async fn resolve_session_id_by_provider_id(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    provider_session_id: &str,
) -> Result<Uuid, AppError> {
    sqlx::query(
        "SELECT session_id FROM cheers_sessions
         WHERE provider = $1
           AND provider_account_id = $2
           AND bot_id = $3
           AND provider_session_id = $4
         ORDER BY updated_at DESC
         LIMIT 1",
    )
    .bind(PROVIDER)
    .bind(provider_account_id)
    .bind(bot_id.to_string())
    .bind(provider_session_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .and_then(|row| row.try_get::<String, _>("session_id").ok())
    .and_then(|value| Uuid::parse_str(&value).ok())
    .ok_or_else(|| AppError::NotFound)
}

async fn resolve_session_id(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    provider_session_key: Option<&str>,
    provider_session_id: Option<&str>,
) -> Result<Uuid, AppError> {
    if let Some(provider_session_key) = provider_session_key {
        if let Ok(session_id) =
            resolve_session_id_by_key(db, bot_id, provider_account_id, provider_session_key).await
        {
            return Ok(session_id);
        }
    }
    if let Some(provider_session_id) = provider_session_id {
        resolve_session_id_by_provider_id(db, bot_id, provider_account_id, provider_session_id)
            .await
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn apply_session_update(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    provider_session_key: Option<&str>,
    provider_session_id: Option<String>,
    metadata: Option<Value>,
) -> Result<Uuid, AppError> {
    let session_id = resolve_session_id(
        db,
        bot_id,
        provider_account_id,
        provider_session_key,
        provider_session_id.as_deref(),
    )
    .await?;
    let now = Utc::now();
    let metadata_json = metadata.map(|value| value.to_string());

    let updated: String = sqlx::query_scalar(
        "UPDATE cheers_sessions
         SET provider_session_id = COALESCE($1, provider_session_id),
             metadata = CASE
                WHEN $2 IS NULL THEN metadata
                WHEN jsonb_typeof($2::jsonb) = 'object' THEN COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                ELSE metadata
             END,
             status = $3,
             last_used_at = $4,
             updated_at = $4
         WHERE session_id = $5
         RETURNING session_id",
    )
    .bind(provider_session_id)
    .bind(metadata_json)
    .bind(SESSION_STATUS_BUSY)
    .bind(now)
    .bind(session_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .ok_or_else(|| AppError::NotFound)?;

    Uuid::parse_str(&updated).map_err(|_| AppError::Internal("invalid session_id".into()))
}

pub fn normalize_runtime_status(raw: &str) -> Option<&'static str> {
    match raw {
        SESSION_STATUS_ACTIVE => Some(SESSION_STATUS_ACTIVE),
        SESSION_STATUS_BUSY => Some(SESSION_STATUS_BUSY),
        SESSION_STATUS_IDLE => Some(SESSION_STATUS_IDLE),
        SESSION_STATUS_PAUSED => Some(SESSION_STATUS_PAUSED),
        SESSION_STATUS_TERMINATED => Some(SESSION_STATUS_TERMINATED),
        SESSION_STATUS_REVOKED => Some(SESSION_STATUS_REVOKED),
        SESSION_STATUS_EXPIRED => Some(SESSION_STATUS_EXPIRED),
        SESSION_STATUS_ERROR => Some(SESSION_STATUS_ERROR),
        _ => None,
    }
}

pub async fn apply_runtime_session_ack(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    session_id: Option<Uuid>,
    provider_session_key: Option<&str>,
    provider_session_id: Option<String>,
    status: &str,
    metadata: Option<Value>,
) -> Result<Uuid, AppError> {
    let status = normalize_runtime_status(status)
        .ok_or_else(|| AppError::BadRequest(format!("invalid runtime session status: {status}")))?;
    let session_id = if let Some(session_id) = session_id {
        session_id
    } else {
        resolve_session_id(
            db,
            bot_id,
            provider_account_id,
            provider_session_key,
            provider_session_id.as_deref(),
        )
        .await?
    };
    let now = Utc::now();
    let metadata_json = metadata.map(|value| value.to_string());

    let updated: String = sqlx::query_scalar(
        "UPDATE cheers_sessions
         SET provider_session_id = COALESCE($1, provider_session_id),
             provider_session_key = COALESCE($2, provider_session_key),
             metadata = CASE
                WHEN $3 IS NULL THEN metadata
                WHEN jsonb_typeof($3::jsonb) = 'object' THEN COALESCE(metadata, '{}'::jsonb) || $3::jsonb
                ELSE metadata
             END,
             status = $4,
             last_used_at = $5,
             updated_at = $5
         WHERE session_id = $6
           AND bot_id = $7
           AND provider = $8
           AND provider_account_id = $9
         RETURNING session_id",
    )
    .bind(provider_session_id)
    .bind(provider_session_key)
    .bind(metadata_json)
    .bind(status)
    .bind(now)
    .bind(session_id.to_string())
    .bind(bot_id.to_string())
    .bind(PROVIDER)
    .bind(provider_account_id)
    .fetch_optional(db)
    .await
    .map_err(AppError::Db)?
    .ok_or_else(|| AppError::NotFound)?;

    Uuid::parse_str(&updated).map_err(|_| AppError::Internal("invalid session_id".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_metadata_empty_when_no_root_set() {
        assert_eq!(workspace_metadata(None, &[]), json!({}));
    }

    #[test]
    fn workspace_metadata_carries_cwd_and_additional_dirs() {
        let dirs = vec!["/repo/shared".to_string(), "/repo/docs".to_string()];
        assert_eq!(
            workspace_metadata(Some("/repo/service"), &dirs),
            json!({
                "workspace": {
                    "cwd": "/repo/service",
                    "additional_dirs": ["/repo/shared", "/repo/docs"],
                }
            })
        );
    }

    #[test]
    fn workspace_metadata_carries_additional_dirs_without_cwd() {
        // additionalDirectories may be set even when cwd falls back to the default.
        let dirs = vec!["/repo/shared".to_string()];
        assert_eq!(
            workspace_metadata(None, &dirs),
            json!({ "workspace": { "cwd": Value::Null, "additional_dirs": ["/repo/shared"] } })
        );
    }
}
