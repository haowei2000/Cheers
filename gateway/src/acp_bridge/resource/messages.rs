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

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(50).min(200);

    let rows = sqlx::query(
        r#"
        SELECT id, sender_type, sender_id, content, msg_type,
               reply_to_msg_id, created_at, edited_at, is_deleted
        FROM messages
        WHERE channel_id = $1 AND is_partial = FALSE
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(channel_id.to_string())
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let messages: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::json!({
            "msg_id": r.try_get::<String, _>("id").unwrap_or_default(),
            "sender_type": r.try_get::<String, _>("sender_type").unwrap_or_default(),
            "sender_id": r.try_get::<Option<String>, _>("sender_id").unwrap_or(None),
            "content": r.try_get::<Option<String>, _>("content").unwrap_or(None),
            "msg_type": r.try_get::<Option<String>, _>("msg_type").unwrap_or(None),
            "reply_to_msg_id": r.try_get::<Option<String>, _>("reply_to_msg_id").unwrap_or(None),
            "created_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").unwrap_or(None),
            "edited_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("edited_at").unwrap_or(None),
            "is_deleted": r.try_get::<Option<bool>, _>("is_deleted").unwrap_or(None),
        }))
        .collect();

    Ok(serde_json::json!({
        "messages": messages,
        "has_more": messages.len() as i64 == limit,
    }))
}

pub async fn handle_create(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    check_write_permission(db, bot_id, channel_id, "channel:messages", "create").await?;

    let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let msg_type = params.get("msg_type").and_then(|v| v.as_str()).unwrap_or("text");
    let msg_id = Uuid::new_v4().to_string();

    sqlx::query(
        r#"
        INSERT INTO messages (id, channel_id, sender_type, sender_id, content, msg_type, is_partial)
        VALUES ($1, $2, 'bot', $3, $4, $5, FALSE)
        "#,
    )
    .bind(&msg_id)
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(content)
    .bind(msg_type)
    .execute(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(serde_json::json!({ "msg_id": msg_id }))
}
