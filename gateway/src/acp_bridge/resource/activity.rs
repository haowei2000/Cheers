//! `channel.activity.read` — 统一事件流（messages ∪ channel_operations）。
//!
//! DECENTRALIZED_MESH §6：两张表共享 `channel_seq` 计数器，UNION 后按 seq 排序，
//! bot 的 cursor 在一个流里同时看到对话消息与操作事件（文件变更、成员变动等）。
//!
//! 操作事件对浏览器不 fan-out（realtime::Fanout 只推对话帧）；bot 通过 pull 发现。
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{check_bot_in_channel, not_found, ResourceResult};

/// 处理 `resource_req { resource: "channel.activity.read", params: { channel_id, since_seq?, limit? } }`
pub async fn handle_read(
    db: &PgPool,
    bot_id: Uuid,
    params: &Value,
) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let _since_seq: Option<i64> = params.get("since_seq").and_then(|v| v.as_i64());
    let _limit: i64 = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(50).min(200);

    todo!("mesh step 6: SELECT … FROM messages UNION ALL SELECT … FROM channel_operations WHERE channel_id=$1 AND channel_seq > $2 ORDER BY channel_seq LIMIT $3")
}

/// 处理 `resource_req { resource: "channel.messages.index", params: { channel_id } }`
///
/// 返回 `{ min_seq, max_seq, count }` 供 bot 做 gap 自愈（DECENTRALIZED_MESH §4）。
pub async fn handle_index(
    db: &PgPool,
    bot_id: Uuid,
    params: &Value,
) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    todo!("mesh step 6: SELECT MIN(channel_seq), MAX(channel_seq), COUNT(*) FROM messages WHERE channel_id=$1 AND channel_seq IS NOT NULL")
}
