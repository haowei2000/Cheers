//! `fs.*` — Class 2 agent workspace file operations (mesh step 6).
//!
//! Files live in `context_files` using materialized paths. Writes are transactional:
//! update the file tree, allocate the shared `channel_seq`, then append a
//! `channel_operations` record. Operations are inert for dispatch and discovered
//! by bots via `channel.activity.read`.
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::domain::channel_seq;

use super::{authorize_channel_read, authorize_channel_write, Principal, ResourceResult};

// ── Reads ────────────────────────────────────────────────────────────────────

/// `fs.ls` — list a subtree by path prefix. Root is `path=""`.
pub async fn handle_ls(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, true)?;
    authorize_channel_read(db, principal, channel_id).await?;

    let rows = sqlx::query(
        "SELECT path, version, is_dir, LENGTH(content)::bigint AS size_bytes,
                created_at, updated_at
         FROM context_files
         WHERE channel_id = $1
           AND ($2 = '' OR path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
         ORDER BY is_dir DESC, path ASC",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let entries: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "path": row.try_get::<String, _>("path").unwrap_or_default(),
                "version": row.try_get::<i64, _>("version").unwrap_or(0),
                "is_dir": row.try_get::<bool, _>("is_dir").unwrap_or(false),
                "size_bytes": row.try_get::<i64, _>("size_bytes").unwrap_or(0),
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "entries": entries,
    }))
}

/// `fs.read` — read one file.
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    authorize_channel_read(db, principal, channel_id).await?;

    let row = sqlx::query(
        "SELECT path, content, version, is_dir, created_at, updated_at
         FROM context_files
         WHERE channel_id = $1 AND path = $2",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .ok_or_else(|| super::not_found("file"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": row.try_get::<String, _>("path").unwrap_or(path),
        "content": row.try_get::<String, _>("content").unwrap_or_default(),
        "version": row.try_get::<i64, _>("version").unwrap_or(0),
        "is_dir": row.try_get::<bool, _>("is_dir").unwrap_or(false),
        "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
        "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
    }))
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// `fs.write` — create or overwrite a file. `if_version=0` means create-only.
pub async fn handle_write(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let is_dir = params
        .get("is_dir")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let if_version = params.get("if_version").and_then(|v| v.as_i64());
    enforce_file_size(content)?;

    let mut tx = db
        .begin()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let existing = sqlx::query(
        "SELECT version
         FROM context_files
         WHERE channel_id = $1 AND path = $2
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let version = if let Some(row) = existing {
        let current = row.try_get::<i64, _>("version").unwrap_or(0);
        if let Some(expected) = if_version {
            if expected != current {
                return Err(version_conflict(current));
            }
        }
        sqlx::query(
            "UPDATE context_files
             SET content = $3,
                 is_dir = $4,
                 version = version + 1,
                 updated_at = NOW()
             WHERE channel_id = $1 AND path = $2
             RETURNING version",
        )
        .bind(channel_id.to_string())
        .bind(&path)
        .bind(content)
        .bind(is_dir)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
        .try_get::<i64, _>("version")
        .unwrap_or(current + 1)
    } else {
        if let Some(expected) = if_version {
            if expected != 0 {
                return Err(version_conflict(0));
            }
        }
        enforce_channel_file_count(&mut tx, channel_id).await?;
        sqlx::query(
            "INSERT INTO context_files (
                file_id, channel_id, path, content, version, is_dir, created_by, creator_type
             ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
             RETURNING version",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(channel_id.to_string())
        .bind(&path)
        .bind(content)
        .bind(is_dir)
        .bind(principal.principal_id.to_string())
        .bind(principal.member_type())
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
        .try_get::<i64, _>("version")
        .unwrap_or(1)
    };

    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.write",
        principal,
        &path,
        json!({"path": path, "version": version, "is_dir": is_dir}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "version": version,
        "channel_seq": seq,
    }))
}

/// `fs.edit` — replace exactly one string occurrence.
pub async fn handle_edit(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let old = params
        .get("old_string")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "old_string required"))?;
    if old.is_empty() {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "old_string can not be empty",
        ));
    }
    let new = params
        .get("new_string")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let if_version = params.get("if_version").and_then(|v| v.as_i64());

    let mut tx = db
        .begin()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let row = sqlx::query(
        "SELECT content, version, is_dir
         FROM context_files
         WHERE channel_id = $1 AND path = $2
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .ok_or_else(|| super::not_found("file"))?;
    if row.try_get::<bool, _>("is_dir").unwrap_or(false) {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "path is a directory",
        ));
    }

    let current_version = row.try_get::<i64, _>("version").unwrap_or(0);
    if let Some(expected) = if_version {
        if expected != current_version {
            return Err(version_conflict(current_version));
        }
    }
    let content = row.try_get::<String, _>("content").unwrap_or_default();
    let occurrences = content.matches(old).count();
    if occurrences != 1 {
        return Err(super::resource_error(
            "EDIT_CONFLICT",
            format!("old_string matched {occurrences} times"),
        ));
    }
    let updated = content.replacen(old, new, 1);
    let version = update_content(&mut tx, channel_id, &path, &updated).await?;
    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.edit",
        principal,
        &path,
        json!({"path": path, "version": version}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "version": version,
        "channel_seq": seq,
    }))
}

/// `fs.append` — append to a file, creating it if missing.
pub async fn handle_append(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let append = params.get("content").and_then(|v| v.as_str()).unwrap_or("");

    let mut tx = db
        .begin()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let existing = sqlx::query(
        "SELECT content, version, is_dir
         FROM context_files
         WHERE channel_id = $1 AND path = $2
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let version = if let Some(row) = existing {
        if row.try_get::<bool, _>("is_dir").unwrap_or(false) {
            return Err(super::resource_error(
                "INVALID_PARAMS",
                "path is a directory",
            ));
        }
        let mut content = row.try_get::<String, _>("content").unwrap_or_default();
        content.push_str(append);
        update_content(&mut tx, channel_id, &path, &content).await?
    } else {
        enforce_channel_file_count(&mut tx, channel_id).await?;
        enforce_file_size(append)?;
        sqlx::query(
            "INSERT INTO context_files (
                file_id, channel_id, path, content, version, is_dir, created_by, creator_type
             ) VALUES ($1, $2, $3, $4, 1, FALSE, $5, $6)
             RETURNING version",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(channel_id.to_string())
        .bind(&path)
        .bind(append)
        .bind(principal.principal_id.to_string())
        .bind(principal.member_type())
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
        .try_get::<i64, _>("version")
        .unwrap_or(1)
    };

    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.append",
        principal,
        &path,
        json!({"path": path, "version": version, "appended_bytes": append.len()}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "version": version,
        "channel_seq": seq,
    }))
}

/// `fs.rm` — remove a file or, with `recursive=true`, a subtree.
pub async fn handle_rm(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let (channel_id, path) = extract_channel_path(params, false)?;
    check_fs_write(db, principal, channel_id).await?;
    let recursive = params
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut tx = db
        .begin()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let rows = sqlx::query(
        "SELECT path
         FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
         FOR UPDATE",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    if rows.is_empty() {
        return Err(super::not_found("file"));
    }
    if rows.len() > 1 && !recursive {
        return Err(super::resource_error(
            "DIRECTORY_NOT_EMPTY",
            "path has descendants; pass recursive=true",
        ));
    }

    let deleted = sqlx::query(
        "DELETE FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&path)
    .execute(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .rows_affected();
    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.rm",
        principal,
        &path,
        json!({"path": path, "recursive": recursive, "deleted": deleted}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "channel_id": channel_id,
        "path": path,
        "deleted": deleted,
        "channel_seq": seq,
    }))
}

/// `fs.mv` — move/rename one node and all descendants.
pub async fn handle_mv(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id = extract_channel_id(params)?;
    check_fs_write(db, principal, channel_id).await?;
    let from = normalize_path(
        params.get("from").and_then(|v| v.as_str()).unwrap_or(""),
        false,
    )?;
    let to = normalize_path(
        params.get("to").and_then(|v| v.as_str()).unwrap_or(""),
        false,
    )?;
    if from == to {
        return Ok(json!({
            "channel_id": channel_id,
            "from": from,
            "to": to,
            "moved": 0,
            "channel_seq": null,
        }));
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "can not move a path into its own subtree",
        ));
    }

    let mut tx = db
        .begin()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    let source_count: i64 = sqlx::query(
        "SELECT COUNT(*) AS count
         FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&from)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .try_get("count")
    .unwrap_or(0);
    if source_count == 0 {
        return Err(super::not_found("file"));
    }

    let target_count: i64 = sqlx::query(
        "SELECT COUNT(*) AS count
         FROM context_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&to)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .try_get("count")
    .unwrap_or(0);
    if target_count > 0 {
        return Err(super::resource_error(
            "PATH_CONFLICT",
            "target path already exists",
        ));
    }

    let moved = sqlx::query(
        "UPDATE context_files
         SET path = CASE
                 WHEN path = $2 THEN $3
                 ELSE $3 || substring(path from char_length($2) + 1)
             END,
             version = version + 1,
             updated_at = NOW()
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
    )
    .bind(channel_id.to_string())
    .bind(&from)
    .bind(&to)
    .execute(&mut *tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .rows_affected();
    let seq = insert_operation(
        &mut tx,
        channel_id,
        "fs.mv",
        principal,
        &from,
        json!({"from": from, "to": to, "moved": moved}),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "channel_id": channel_id,
        "from": from,
        "to": to,
        "moved": moved,
        "channel_seq": seq,
    }))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async fn check_fs_write(
    db: &PgPool,
    principal: &Principal,
    channel_id: Uuid,
) -> Result<(), (String, String)> {
    authorize_channel_write(db, principal, channel_id)
        .await
        .map(|_| ())
}

/// 单文件内容硬上限（字节）。`context_files.content` 是 TEXT 行内存储，写入还会
/// 全量经 WS 广播给每个订阅者——无上限即存储耗尽 / 网关 OOM 的口子（user 桥已
/// 让浏览器能写）。对 bot 与 user 路径同等生效（安全上限，非授权）。
const MAX_FILE_BYTES: usize = 256 * 1024;

/// 每频道文件数上限。配合 `MAX_FILE_BYTES` 给频道工作区一个有界总量
/// （≤ MAX_CHANNEL_FILES × MAX_FILE_BYTES）。
const MAX_CHANNEL_FILES: i64 = 1024;

/// 写入前校验单文件内容不超过 `MAX_FILE_BYTES`。所有写路径（write/edit/append 的
/// 最终内容）都必须过这道关，不可按 verb 绕过。
fn enforce_file_size(content: &str) -> Result<(), (String, String)> {
    if content.len() > MAX_FILE_BYTES {
        return Err(super::resource_error(
            "CONTENT_TOO_LARGE",
            format!(
                "file content {} bytes exceeds limit {MAX_FILE_BYTES}",
                content.len()
            ),
        ));
    }
    Ok(())
}

/// 新建文件前校验频道文件数未达上限（仅 INSERT 路径需要）。
async fn enforce_channel_file_count(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
) -> Result<(), (String, String)> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM context_files WHERE channel_id = $1")
            .bind(channel_id.to_string())
            .fetch_one(&mut **tx)
            .await
            .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    if count >= MAX_CHANNEL_FILES {
        return Err(super::resource_error(
            "CHANNEL_QUOTA_EXCEEDED",
            format!("channel already has {count} files (limit {MAX_CHANNEL_FILES})"),
        ));
    }
    Ok(())
}

async fn update_content(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
    path: &str,
    content: &str,
) -> Result<i64, (String, String)> {
    enforce_file_size(content)?;
    sqlx::query(
        "UPDATE context_files
         SET content = $3,
             version = version + 1,
             updated_at = NOW()
         WHERE channel_id = $1 AND path = $2
         RETURNING version",
    )
    .bind(channel_id.to_string())
    .bind(path)
    .bind(content)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .try_get::<i64, _>("version")
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))
}

async fn insert_operation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
    op_type: &str,
    principal: &Principal,
    target_ref: &str,
    payload: Value,
) -> Result<i64, (String, String)> {
    let seq = channel_seq::allocate(tx, channel_id)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    sqlx::query(
        "INSERT INTO channel_operations (
            id, channel_id, channel_seq, op_type, actor_type, actor_id, target_ref, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(channel_id.to_string())
    .bind(seq)
    .bind(op_type)
    .bind(principal.member_type())
    .bind(principal.principal_id.to_string())
    .bind(target_ref)
    .bind(payload)
    .execute(&mut **tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(seq)
}

fn extract_channel_path(
    params: &Value,
    allow_empty: bool,
) -> Result<(Uuid, String), (String, String)> {
    let channel_id = extract_channel_id(params)?;
    let path = normalize_path(
        params.get("path").and_then(|v| v.as_str()).unwrap_or(""),
        allow_empty,
    )?;
    Ok((channel_id, path))
}

fn extract_channel_id(params: &Value) -> Result<Uuid, (String, String)> {
    params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))
}

/// A bare uuid as the whole path is almost certainly a misused attachment file_id — the
/// agent confusing the read-only Inbox (channel.files, by file_id) with the editable
/// Desk/workspace (fs.*, by path). Reject it with a pointer, turning a silent miss into a
/// precise, correctable error.
fn looks_like_file_id(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn normalize_path(raw: &str, allow_empty: bool) -> Result<String, (String, String)> {
    let path = raw.trim().trim_matches('/').to_string();
    if path.is_empty() {
        if allow_empty {
            return Ok(path);
        }
        return Err(super::resource_error("BAD_REQUEST", "missing path"));
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(super::resource_error("BAD_REQUEST", "invalid path"));
    }
    if looks_like_file_id(&path) {
        return Err(super::resource_error(
            "E_LOOKS_LIKE_FILE_ID",
            "this looks like an attachment file_id, not a workspace path — chat attachments \
             are read-only; read them with inbox_open (channel.files.read), they are not \
             editable workspace files",
        ));
    }
    Ok(path)
}

fn version_conflict(current: i64) -> (String, String) {
    super::resource_error(
        "VERSION_CONFLICT",
        format!("version conflict; current_version={current}"),
    )
}
