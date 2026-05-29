use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{check_bot_in_channel, check_write_permission, ResourceResult};

pub async fn handle_read(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    let layer = params
        .get("layer")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "layer required"))?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let rows = sqlx::query(
        "SELECT id, title, content, metadata, created_at, updated_at
         FROM memory_entries
         WHERE channel_id = $1 AND layer = $2
         ORDER BY created_at ASC",
    )
    .bind(channel_id.to_string())
    .bind(layer)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let entries: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::json!({
            "entry_id": r.try_get::<String, _>("id").unwrap_or_default(),
            "title": r.try_get::<Option<String>, _>("title").unwrap_or(None),
            "content": r.try_get::<Option<String>, _>("content").unwrap_or(None),
            "metadata": r.try_get::<Option<Value>, _>("metadata").unwrap_or(None),
            "created_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").unwrap_or(None),
            "updated_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("updated_at").unwrap_or(None),
        }))
        .collect();

    Ok(serde_json::json!({
        "channel_id": channel_id,
        "layer": layer,
        "entries": entries,
    }))
}

pub async fn handle_update(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    let layer = params
        .get("layer")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "layer required"))?
        .to_string();

    check_write_permission(db, bot_id, channel_id, "channel:memory", "write").await?;

    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("replace");
    let entries = params
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "entries required"))?;

    if mode == "replace" {
        sqlx::query("DELETE FROM memory_entries WHERE channel_id = $1 AND layer = $2")
            .bind(channel_id.to_string())
            .bind(&layer)
            .execute(db)
            .await
            .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    }

    for entry in entries {
        let title = entry.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let content = entry.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let id = Uuid::new_v4().to_string();

        sqlx::query(
            "INSERT INTO memory_entries (id, channel_id, layer, title, content)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&id)
        .bind(channel_id.to_string())
        .bind(&layer)
        .bind(title)
        .bind(content)
        .execute(db)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;
    }

    Ok(serde_json::json!({
        "channel_id": channel_id,
        "layer": layer,
        "updated": entries.len(),
    }))
}
