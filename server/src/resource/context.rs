use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use super::{channel_info, members, messages};
use super::{check_bot_in_channel, ResourceResult};

/// channel.context — 聚合查询（一次 round-trip 拿常用上下文）
pub async fn handle(db: &PgPool, bot_id: Uuid, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    check_bot_in_channel(db, bot_id, channel_id).await?;

    let include = params
        .get("include")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
        .unwrap_or_default();

    let mut result = serde_json::json!({});

    let chan_params = serde_json::json!({ "channel_id": channel_id.to_string() });

    if include.is_empty() || include.contains(&"info") {
        if let Ok(info) = channel_info::handle(db, bot_id, &chan_params).await {
            result["info"] = info;
        }
    }

    if include.is_empty() || include.contains(&"members_summary") {
        if let Ok(m) = members::handle(db, bot_id, &chan_params).await {
            let total = m["total"].as_i64().unwrap_or(0);
            let bots = m["members"]
                .as_array()
                .map(|arr| arr.iter().filter(|m| m["member_type"] == "bot").count())
                .unwrap_or(0);
            result["members_summary"] = serde_json::json!({
                "total": total,
                "users": total - bots as i64,
                "bots": bots,
            });
        }
    }

    if include.is_empty() || include.contains(&"recent_messages") {
        let limit = params
            .get("recent_message_limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(20);
        let msg_params = serde_json::json!({
            "channel_id": channel_id.to_string(),
            "limit": limit,
        });
        if let Ok(msgs) = messages::handle_read(db, bot_id, &msg_params).await {
            result["recent_messages"] = msgs["messages"].clone();
        }
    }

    Ok(result)
}
