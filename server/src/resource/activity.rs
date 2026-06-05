//! `channel.activity.read` — 统一事件流（messages ∪ channel_operations）。
//!
//! DECENTRALIZED_MESH §6：两张表共享 `channel_seq` 计数器，UNION 后按 seq 排序，
//! bot 的 cursor 在一个流里同时看到对话消息与操作事件（文件变更、成员变动等）。
//!
//! 操作事件对浏览器不 fan-out（realtime::Fanout 只推对话帧）；bot 通过 pull 发现。
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
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

    let rows = sqlx::query(
        r#"
        SELECT event_type, channel_seq, created_at, payload
        FROM (
            SELECT
                'message'::text AS event_type,
                m.channel_seq,
                m.created_at,
                jsonb_build_object(
                    'v', 1,
                    'msg_id', m.msg_id,
                    'channel_id', m.channel_id,
                    'channel_seq', m.channel_seq,
                    'sender_type', m.sender_type,
                    'sender_id', m.sender_id,
                    'content', m.content,
                    'msg_type', m.msg_type,
                    'is_partial', m.is_partial,
                    'reply_to_msg_id', m.in_reply_to_msg_id,
                    'file_ids', COALESCE(m.file_ids, '[]'::jsonb),
                    'mentions', COALESCE(mm.mentions, '[]'::jsonb),
                    'created_at', m.created_at
                ) AS payload
            FROM messages m
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'member_id', member_id,
                        'member_type', member_type
                    )
                    ORDER BY member_type, member_id
                ) AS mentions
                FROM message_mentions
                WHERE msg_id = m.msg_id
            ) mm ON TRUE
            WHERE m.channel_id = $1
              AND m.channel_seq IS NOT NULL
              AND m.channel_seq > $2
              AND m.is_partial = FALSE

            UNION ALL

            SELECT
                'operation'::text AS event_type,
                o.channel_seq,
                o.created_at,
                jsonb_build_object(
                    'op_id', o.id,
                    'channel_id', o.channel_id,
                    'channel_seq', o.channel_seq,
                    'op_type', o.op_type,
                    'actor_type', o.actor_type,
                    'actor_id', o.actor_id,
                    'target_ref', o.target_ref,
                    'payload', COALESCE(o.payload, '{}'::jsonb),
                    'created_at', o.created_at
                ) AS payload
            FROM channel_operations o
            WHERE o.channel_id = $1
              AND o.channel_seq > $2
        ) events
        ORDER BY channel_seq ASC
        LIMIT $3
        "#,
    )
    .bind(channel_id.to_string())
    .bind(since_seq)
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let events: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "event_type": row.try_get::<String, _>("event_type").unwrap_or_default(),
                "channel_seq": row.try_get::<i64, _>("channel_seq").unwrap_or_default(),
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "data": row.try_get::<Value, _>("payload").unwrap_or_else(|_| json!({})),
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

    let row = sqlx::query(
        "SELECT MIN(channel_seq) AS min_seq,
                MAX(channel_seq) AS max_seq,
                COUNT(*) AS count
         FROM messages
         WHERE channel_id = $1
           AND channel_seq IS NOT NULL
           AND is_partial = FALSE",
    )
    .bind(channel_id.to_string())
    .fetch_one(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "channel_id": channel_id,
        "min_seq": row.try_get::<Option<i64>, _>("min_seq").ok().flatten(),
        "max_seq": row.try_get::<Option<i64>, _>("max_seq").ok().flatten(),
        "count": row.try_get::<i64, _>("count").unwrap_or(0),
    }))
}
