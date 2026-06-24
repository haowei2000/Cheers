use chrono::Utc;
use serde_json::Value;
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
    })
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
        ON CONFLICT ON CONSTRAINT uq_cheers_session_binding_scope
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
