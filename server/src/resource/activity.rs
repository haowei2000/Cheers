//! `channel.activity.read` — unified event stream
//! (messages ∪ channel_operations ∪ final voice transcript segments).
//!
//! DECENTRALIZED_MESH §6：两张表共享 `channel_seq` 计数器，UNION 后按 seq 排序，
//! bot 的 cursor 在一个流里同时看到对话消息与操作事件（文件变更、成员变动等）。
//!
//! 操作事件对浏览器不 fan-out（realtime::Fanout 只推对话帧）；bot 通过 pull 发现。
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{authorize_channel_read, Principal, ResourceResult};

/// 处理 `resource_req { resource: "channel.activity.read", params: { channel_id, since_seq?, limit? } }`
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    let since_seq = params
        .get("since_seq")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .max(0);
    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50)
        .clamp(1, 200);
    struct ActivityRow {
        event_type: String,
        channel_seq: i64,
        created_at: chrono::DateTime<chrono::Utc>,
        payload: Value,
    }
    // Board mode reads newest first; bot cursor reads keep ascending order.
    let descending = params.get("desc").and_then(Value::as_bool).unwrap_or(false);
    let rows = if descending {
        sqlx::query_file_as!(
            ActivityRow,
            "queries/activity_desc.sql",
            channel_id.to_string(),
            since_seq,
            limit,
        )
        .fetch_all(db)
        .await
    } else {
        sqlx::query_file_as!(
            ActivityRow,
            "queries/activity_asc.sql",
            channel_id.to_string(),
            since_seq,
            limit,
        )
        .fetch_all(db)
        .await
    }
    .map_err(super::db_err("activity.read: select channel operations"))?;

    let events: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "event_type": row.event_type,
                "channel_seq": row.channel_seq,
                "created_at": row.created_at,
                "data": row.payload,
            })
        })
        .collect();
    let next_seq = events
        .last()
        .and_then(|event| event.get("channel_seq").and_then(Value::as_i64));

    Ok(json!({
        "channel_id": channel_id,
        "since_seq": since_seq,
        "events": events,
        "next_seq": next_seq,
        "limit": limit,
    }))
}

/// 处理 `resource_req { resource: "channel.messages.index", params: { channel_id } }`
///
/// 返回 `{ min_seq, max_seq, count }` 供 bot 做 gap 自愈（DECENTRALIZED_MESH §4）。
pub async fn handle_index(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    let row = sqlx::query!(
        "SELECT MIN(channel_seq) AS min_seq,
                MAX(channel_seq) AS max_seq,
                COUNT(*) AS count
         FROM messages
         WHERE channel_id = $1
           AND channel_seq IS NOT NULL
           AND is_partial = FALSE",
        channel_id.to_string(),
    )
    .fetch_one(db)
    .await
    .map_err(super::db_err("activity.index: select min/max/count seq"))?;

    Ok(json!({
        "channel_id": channel_id,
        "min_seq": row.min_seq.clone(),
        "max_seq": row.max_seq.clone(),
        "count": row.count.clone().unwrap_or(0),
    }))
}
