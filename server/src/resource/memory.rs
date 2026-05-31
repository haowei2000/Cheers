//! Legacy `channel.memory` compatibility over the mesh `memory_files` tree.
//!
//! Mesh step 6 retires the old `memory_entries` table. Keep the public
//! `channel.memory` resources working by mapping each layer to
//! `memory/<layer>/...` files; new agents should prefer `fs.*`.
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::domain::channel_seq;

use super::{check_bot_in_channel, check_write_permission, ResourceResult};

pub async fn handle_read(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id = extract_channel_id(params)?;
    let layer = extract_layer(params)?;
    let prefix = memory_prefix(&layer)?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let rows = sqlx::query(
        "SELECT path, content, version, is_dir, created_at, updated_at
         FROM memory_files
         WHERE channel_id = $1
           AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')
         ORDER BY path ASC",
    )
    .bind(channel_id.to_string())
    .bind(&prefix)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let entries: Vec<Value> = rows
        .iter()
        .filter(|row| !row.try_get::<bool, _>("is_dir").unwrap_or(false))
        .map(|row| {
            let path = row.try_get::<String, _>("path").unwrap_or_default();
            json!({
                "entry_id": path,
                "title": title_from_path(&path),
                "content": row.try_get::<String, _>("content").unwrap_or_default(),
                "metadata": {
                    "path": path,
                    "version": row.try_get::<i64, _>("version").unwrap_or(0),
                },
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(json!({
        "channel_id": channel_id,
        "layer": layer,
        "entries": entries,
    }))
}

pub async fn handle_update(
    db: &PgPool,
    bot_id: Uuid,
    params: &Value,
    session_id: Option<&str>,
) -> ResourceResult {
    let channel_id = extract_channel_id(params)?;
    let layer = extract_layer(params)?;
    let prefix = memory_prefix(&layer)?;

    check_write_permission(
        db,
        bot_id,
        channel_id,
        "channel:memory",
        "write",
        session_id,
    )
    .await?;

    let mode = params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("replace");
    if mode != "replace" && mode != "merge" {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "mode must be replace or merge",
        ));
    }
    let entries = params
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "entries required"))?;

    let mut tx = db
        .begin()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    if mode == "replace" {
        sqlx::query(
            "DELETE FROM memory_files
             WHERE channel_id = $1
               AND (path = $2 OR left(path, char_length($2) + 1) = $2 || '/')",
        )
        .bind(channel_id.to_string())
        .bind(&prefix)
        .execute(&mut *tx)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    }

    let mut paths = Vec::new();
    for (idx, entry) in entries.iter().enumerate() {
        let title = entry.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let content = entry.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let path = entry_path(entry, &prefix, title, idx, mode)?;
        sqlx::query(
            "INSERT INTO memory_files (
                file_id, channel_id, path, content, version, is_dir, created_by, creator_type
             ) VALUES ($1, $2, $3, $4, 1, FALSE, $5, 'bot')
             ON CONFLICT (channel_id, path)
             DO UPDATE SET
                content = EXCLUDED.content,
                is_dir = FALSE,
                version = memory_files.version + 1,
                updated_at = NOW()
             RETURNING path",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(channel_id.to_string())
        .bind(&path)
        .bind(content)
        .bind(bot_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
        paths.push(path);
    }

    let channel_seq = insert_memory_operation(
        &mut tx,
        channel_id,
        bot_id,
        &layer,
        json!({
            "layer": layer,
            "mode": mode,
            "updated": entries.len(),
            "paths": paths,
        }),
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "channel_id": channel_id,
        "layer": layer,
        "updated": entries.len(),
        "paths": paths,
        "channel_seq": channel_seq,
    }))
}

async fn insert_memory_operation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
    bot_id: Uuid,
    layer: &str,
    payload: Value,
) -> Result<i64, (String, String)> {
    let seq = channel_seq::allocate(tx, channel_id)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    sqlx::query(
        "INSERT INTO channel_operations (
            id, channel_id, channel_seq, op_type, actor_type, actor_id, target_ref, payload
         ) VALUES ($1, $2, $3, 'channel.memory.update', 'bot', $4, $5, $6)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(channel_id.to_string())
    .bind(seq)
    .bind(bot_id.to_string())
    .bind(format!("memory/{layer}"))
    .bind(payload)
    .execute(&mut **tx)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(seq)
}

fn extract_channel_id(params: &Value) -> Result<Uuid, (String, String)> {
    params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))
}

fn extract_layer(params: &Value) -> Result<String, (String, String)> {
    params
        .get("layer")
        .and_then(|v| v.as_str())
        .map(normalize_path_segment)
        .transpose()?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "layer required"))
}

fn memory_prefix(layer: &str) -> Result<String, (String, String)> {
    Ok(format!("memory/{}", normalize_path_segment(layer)?))
}

fn entry_path(
    entry: &Value,
    prefix: &str,
    title: &str,
    idx: usize,
    mode: &str,
) -> Result<String, (String, String)> {
    if let Some(path) = explicit_entry_path(entry) {
        let normalized = normalize_path(&path)?;
        if normalized == prefix || normalized.starts_with(&format!("{prefix}/")) {
            return Ok(normalized);
        }
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "entry path must stay inside the memory layer",
        ));
    }

    let slug = slugify(title).unwrap_or_else(|| "entry".to_string());
    if mode == "merge" {
        Ok(format!("{prefix}/{slug}-{}.md", Uuid::new_v4()))
    } else {
        Ok(format!("{prefix}/{:04}-{slug}.md", idx + 1))
    }
}

fn explicit_entry_path(entry: &Value) -> Option<String> {
    entry
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            entry
                .get("metadata")
                .and_then(|v| v.get("path"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .or_else(|| {
            entry
                .get("entry_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
}

fn normalize_path(raw: &str) -> Result<String, (String, String)> {
    let path = raw.trim().trim_matches('/').to_string();
    if path.is_empty()
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(super::resource_error("INVALID_PARAMS", "invalid path"));
    }
    Ok(path)
}

fn normalize_path_segment(raw: &str) -> Result<String, (String, String)> {
    let value = raw.trim().trim_matches('/');
    if value.is_empty()
        || value
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "invalid path segment",
        ));
    }
    Ok(value.to_string())
}

fn slugify(value: &str) -> Option<String> {
    let mut slug = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if matches!(ch, '-' | '_' | ' ' | '.') && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

fn title_from_path(path: &str) -> String {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
        .to_string()
}
