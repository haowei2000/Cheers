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

fn scope_columns(scope_type: &str, scope_id: &str, _task_id: Option<&str>) -> (Option<String>, Option<String>) {
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

/// Create an additional ("other") session bound to a channel, keyed by its own
/// `session_id` (`cheers:session:{id}`) so it's addressed independently of the
/// channel's primary. Topic-free: extras are distinguished by session_id + the
/// non-primary binding role, never by a label.
pub async fn create_channel_session(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    channel_id: &str,
    role: &str,
) -> Result<SessionHandle, AppError> {
    let provider_account_id = provider_account_id.trim();
    if provider_account_id.is_empty() {
        return Err(AppError::BadRequest("provider_account_id can not be empty".into()));
    }
    let channel_id = channel_id.trim();
    if channel_id.is_empty() {
        return Err(AppError::BadRequest("channel_id can not be empty".into()));
    }
    let session_uuid = Uuid::new_v4();
    let provider_session_key = format!("cheers:session:{session_uuid}");
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO cheers_sessions (
            session_id, bot_id, provider, provider_account_id, provider_agent_id,
            provider_session_key, provider_session_id, current_scope_type, current_scope_id,
            status, metadata, last_used_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, '{}'::jsonb, $10, $10, $10)",
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

/// A channel's sessions for a bot (primary first), for the session switcher.
pub async fn list_channel_sessions(
    db: &PgPool,
    bot_id: Uuid,
    channel_id: &str,
) -> Result<Vec<Value>, AppError> {
    let rows = sqlx::query(
        // No detached_at filter: bindings are detached on every finalize, but an
        // idle session stays addressable. Exclude only truly-closed sessions.
        "SELECT s.session_id, b.role, s.status, s.provider_session_key, s.last_used_at
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
            json!({
                "session_id": r.try_get::<String, _>("session_id").unwrap_or_default(),
                "role": role.clone(),
                "is_primary": role == "primary",
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
                "last_used_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("last_used_at")
                    .map(|t| t.to_rfc3339()).unwrap_or_default(),
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
        "UPDATE cheers_session_bindings SET detached_at = COALESCE(detached_at, $1)
         WHERE session_id = $2 AND detached_at IS NULL",
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
    sqlx::query(
        "INSERT INTO cheers_session_bindings (
            binding_id, session_id, bot_id, provider, provider_account_id, provider_agent_id,
            scope_type, scope_id, channel_id, task_id, role, created_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
        )
        ON CONFLICT (bot_id, provider, provider_agent_id, provider_account_id, scope_type, scope_id)
        WHERE role = 'primary'
        DO UPDATE SET
            session_id = EXCLUDED.session_id,
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
