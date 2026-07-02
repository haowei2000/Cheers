use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{authorize_channel_read, Principal, PrincipalType, ResourceResult};

pub async fn handle(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(100)
        .min(500);

    let rows = sqlx::query(
        r#"
        SELECT cm.member_id, cm.member_type, cm.joined_at,
               COALESCE(u.display_name, b.display_name) AS display_name,
               COALESCE(u.username, b.username) AS username
        FROM channel_memberships cm
        LEFT JOIN users u ON cm.member_type = 'user' AND u.user_id = cm.member_id
        LEFT JOIN bot_accounts b ON cm.member_type = 'bot' AND b.bot_id = cm.member_id
        WHERE cm.channel_id = $1
        LIMIT $2
        "#,
    )
    .bind(channel_id.to_string())
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(super::db_err("members.list: select channel memberships"))?;

    let members: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::json!({
            "member_id": r.try_get::<String, _>("member_id").unwrap_or_default(),
            "member_type": r.try_get::<String, _>("member_type").unwrap_or_default(),
            "display_name": r.try_get::<Option<String>, _>("display_name").unwrap_or(None),
            "username": r.try_get::<Option<String>, _>("username").unwrap_or(None),
            "joined_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("joined_at").unwrap_or(None),
        }))
        .collect();

    Ok(serde_json::json!({
        "members": members,
        "total": members.len(),
        "next_cursor": null,
    }))
}

/// 处理 `resource_req { resource: "channel.leave" }` —— bot 自己退出频道。
/// 与人类成员的 REST leave 对齐（人类走 POST /channels/:id/leave）：
/// - 仅限 bot principal（用户在 REST 侧有 last-owner 守护等完整语义）。
/// - DM 不可退出（与人类一致；DM 成员是固定的两端）。
/// - 只删自己的 membership 行；session 等衍生状态保留（与管理员移除 bot 的
///   remove_channel_member 行为一致）。presence 广播由 WS 边界补发。
pub async fn handle_leave(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    if principal.principal_type != PrincipalType::Bot {
        return Err(super::permission_denied(
            "channel.leave is for bot principals; users leave via the REST API",
        ));
    }
    authorize_channel_read(db, principal, channel_id).await?;

    let channel_type: Option<String> =
        sqlx::query_scalar("SELECT type FROM channels WHERE channel_id = $1")
            .bind(channel_id.to_string())
            .fetch_optional(db)
            .await
            .map_err(super::db_err("members.leave: select channel type"))?;
    if channel_type.as_deref() == Some("dm") {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "cannot leave a direct message",
        ));
    }

    sqlx::query(
        "DELETE FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot'",
    )
    .bind(channel_id.to_string())
    .bind(principal.principal_id.to_string())
    .execute(db)
    .await
    .map_err(super::db_err("members.leave: delete membership"))?;

    Ok(serde_json::json!({ "left": true, "channel_id": channel_id }))
}
