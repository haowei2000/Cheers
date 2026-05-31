use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{check_bot_in_channel, check_write_permission, not_found, ResourceResult};

pub async fn handle_list(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(50).min(200);

    let rows = sqlx::query(
        r#"
        SELECT fr.file_id, fr.original_filename, fr.content_type,
               fr.size_bytes, fr.status, fr.created_at
        FROM file_records fr
        JOIN file_scope_links fsl ON fsl.file_id = fr.file_id
        WHERE fsl.scope_type = 'channel' AND fsl.scope_id = $1
        ORDER BY fr.created_at DESC
        LIMIT $2
        "#,
    )
    .bind(channel_id.to_string())
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let files: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::json!({
            "file_id": r.try_get::<String, _>("file_id").unwrap_or_default(),
            "filename": r.try_get::<Option<String>, _>("original_filename").unwrap_or(None),
            "content_type": r.try_get::<Option<String>, _>("content_type").unwrap_or(None),
            "size_bytes": r.try_get::<Option<i64>, _>("size_bytes").unwrap_or(None),
            "status": r.try_get::<Option<String>, _>("status").unwrap_or(None),
            "created_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").unwrap_or(None),
        }))
        .collect();

    Ok(serde_json::json!({ "files": files, "total": files.len(), "next_cursor": null }))
}

pub async fn handle_read(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    let file_id = params
        .get("file_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "file_id required"))?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let exists_row = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM file_scope_links
            WHERE file_id = $1 AND scope_type = 'channel' AND scope_id = $2
        ) AS ok",
    )
    .bind(file_id)
    .bind(channel_id.to_string())
    .fetch_one(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let exists: bool = exists_row.try_get("ok").unwrap_or(false);
    if !exists {
        return Err(not_found("file"));
    }

    let row = sqlx::query(
        "SELECT file_id, original_filename, content_type, size_bytes FROM file_records WHERE file_id = $1",
    )
    .bind(file_id)
    .fetch_optional(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .ok_or_else(|| not_found("file"))?;

    Ok(serde_json::json!({
        "file_id": row.try_get::<String, _>("file_id").unwrap_or_default(),
        "filename": row.try_get::<Option<String>, _>("original_filename").unwrap_or(None),
        "content_type": row.try_get::<Option<String>, _>("content_type").unwrap_or(None),
        "size_bytes": row.try_get::<Option<i64>, _>("size_bytes").unwrap_or(None),
        "content": null,  // TODO: S3 读取（Phase 2）
        "truncated": false,
    }))
}

pub async fn handle_create(
    db: &PgPool,
    bot_id: Uuid,
    params: &Value,
    session_id: Option<&str>,
) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    check_write_permission(db, bot_id, channel_id, "channel:files", "create", session_id).await?;

    // TODO: 实际写入 S3（Phase 2）
    let file_id = Uuid::new_v4().to_string();
    Ok(serde_json::json!({
        "file_id": file_id,
        "filename": params.get("filename"),
        "content_type": params.get("content_type"),
    }))
}
