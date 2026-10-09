use serde_json::Value;
use sqlx::PgPool;
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

    // Members carry their self-describable "information" (users.bio / bot.description)
    // and their short status line (status_text + emoji) so the agent can address the
    // room with context — who's here, what they do, and their current status. A
    // membership row is exactly one of user|bot, so the other side of each COALESCE
    // is NULL from the LEFT JOIN.
    let rows = sqlx::query!(
        r#"
        SELECT cm.member_id, cm.member_type, cm.joined_at,
               COALESCE(u.display_name, b.display_name) AS display_name,
               COALESCE(u.username, b.username) AS username,
               COALESCE(u.bio, b.description) AS info,
               COALESCE(u.status_text, b.status_text) AS status_text,
               COALESCE(u.status_emoji, b.status_emoji) AS status_emoji,
               COALESCE(u.status_updated_at, b.status_updated_at) AS status_updated_at
        FROM channel_memberships cm
        LEFT JOIN users u ON cm.member_type = 'user' AND u.user_id = cm.member_id
        LEFT JOIN bot_accounts b ON cm.member_type = 'bot' AND b.bot_id = cm.member_id
        WHERE cm.channel_id = $1
        LIMIT $2
        "#,
        channel_id.to_string(),
        limit,
    )
    .fetch_all(db)
    .await
    .map_err(super::db_err("members.list: select channel memberships"))?;

    // The caller's own membership row, so an agent can pick itself out of the
    // roster (e.g. "am I already in this channel", "don't @ myself"). A bot never
    // knew which row was "me" otherwise — member_ids are opaque UUIDs to it.
    let self_id = principal.principal_id.to_string();
    let self_type = principal.principal_type.as_member_type();

    let members: Vec<Value> = rows
        .iter()
        .map(|r| {
            let member_id = r.member_id.clone();
            let member_type = r.member_type.clone();
            let is_self = member_id == self_id && member_type == self_type;
            serde_json::json!({
                "member_id": member_id,
                "member_type": member_type,
                "is_self": is_self,
                "display_name": r.display_name.clone(),
                "username": r.username.clone(),
                "info": r.info.clone(),
                "status_text": r.status_text.clone(),
                "status_emoji": r.status_emoji.clone(),
                "status_updated_at": r.status_updated_at.clone(),
                "joined_at": Some(r.joined_at.clone()),
            })
        })
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

    let channel_type: Option<String> = sqlx::query_scalar!(
        "SELECT type FROM channels WHERE channel_id = $1",
        channel_id.to_string(),
    )
    .fetch_optional(db)
    .await
    .map_err(super::db_err("members.leave: select channel type"))?;
    if channel_type.as_deref() == Some("dm") {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "cannot leave a direct message",
        ));
    }

    sqlx::query!(
        "DELETE FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot'",
        channel_id.to_string(),
        principal.principal_id.to_string(),
    )
    .execute(db)
    .await
    .map_err(super::db_err("members.leave: delete membership"))?;

    Ok(serde_json::json!({ "left": true, "channel_id": channel_id }))
}
