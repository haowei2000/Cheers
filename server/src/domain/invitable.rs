//! 频道邀请候选搜索（人机统一的邀请入口）。
//!
//! 一个查询同时返回可邀请的用户和 bot，供前端统一邀请选择器使用：
//! - 用户：目标频道所在 workspace 的 active 成员（workspace-first 模型：频道邀请
//!   只能面向本 workspace 成员，故不再并入好友）。
//! - bot：未禁用，且调用者按 SESSION_WORKDIR_ROOTSET 的 AND-gate 有权邀请
//!   （平台管理员 / bot owner / 持有该 bot 在此频道的 `cheers/session_create`
//!   INITIATE 授权，fail-closed）。
//!
//! 已在频道内的候选不剔除而是标记 `already_member`，由前端置灰。

use std::sync::Arc;

use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    domain::{acp_policy, bot_event_policy::Capability, messages::escape_like_pattern},
    errors::AppError,
    gateway::registry::BotLocator,
};

#[derive(Debug, Serialize)]
pub struct InvitableItem {
    pub member_id: String,
    pub member_type: &'static str,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// bot：connector 双 WS 在线；用户：候选可能不在频道内，无 presence 语义 → None。
    pub is_online: Option<bool>,
    pub already_member: bool,
}

/// 每类候选的返回上限（用户、bot 各自截断）。
const PER_KIND_LIMIT: i64 = 20;
/// 逐个跑 policy 解析前的 bot 候选池上限。
const BOT_CANDIDATE_POOL: i64 = 50;

pub struct InvitableCaller<'a> {
    pub user_id: &'a str,
    /// 平台角色（system_admin/admin 直通 bot 侧门槛）。
    pub global_role: &'a str,
    /// 调用者在该频道的角色（policy 解析的 role 档；查不到时传 "member"）。
    pub channel_role: &'a str,
}

pub async fn search_invitable(
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    caller: &InvitableCaller<'_>,
    channel_id: &str,
    query: &str,
) -> Result<Vec<InvitableItem>, AppError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", escape_like_pattern(query));

    let mut items = search_users(db, channel_id, &pattern).await?;
    items.extend(search_bots(db, bot_locator, caller, channel_id, &pattern).await?);
    Ok(items)
}

/// 用户候选：目标频道所在 workspace 的 active 成员，按名字子串匹配。
/// `already_member` 同时覆盖现有成员与已发出的待接受邀请，前端一并置灰。
async fn search_users(
    db: &PgPool,
    channel_id: &str,
    pattern: &str,
) -> Result<Vec<InvitableItem>, AppError> {
    let rows = sqlx::query(
        "SELECT u.user_id, u.username, u.display_name, u.avatar_url,
                (EXISTS(
                    SELECT 1 FROM channel_memberships cm
                    WHERE cm.channel_id = $1 AND cm.member_id = u.user_id
                      AND cm.member_type = 'user'
                ) OR EXISTS(
                    SELECT 1 FROM channel_invites ci
                    WHERE ci.channel_id = $1 AND ci.user_id = u.user_id
                )) AS already_member
         FROM users u
         JOIN workspace_memberships wm
                ON wm.user_id = u.user_id AND wm.status = 'active'
         JOIN channels c
                ON c.workspace_id = wm.workspace_id AND c.channel_id = $1
         WHERE u.is_deleted = FALSE
           AND (u.username ILIKE $2 OR u.display_name ILIKE $2)
         ORDER BY u.username
         LIMIT $3",
    )
    .bind(channel_id)
    .bind(pattern)
    .bind(PER_KIND_LIMIT)
    .fetch_all(db)
    .await
    .map_err(AppError::Db)?;

    Ok(rows
        .into_iter()
        .map(|row| InvitableItem {
            member_id: row.try_get("user_id").unwrap_or_default(),
            member_type: "user",
            username: row.try_get("username").ok(),
            display_name: row.try_get("display_name").ok(),
            avatar_url: row.try_get("avatar_url").ok().flatten(),
            is_online: None,
            already_member: row.try_get("already_member").unwrap_or(false),
        })
        .collect())
}

/// bot 候选：名字匹配的未禁用 bot，再按邀请 AND-gate 的 bot 侧条件逐个过滤
/// （owner / 平台管理员 / session_create INITIATE 授权，fail-closed）。
async fn search_bots(
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    caller: &InvitableCaller<'_>,
    channel_id: &str,
    pattern: &str,
) -> Result<Vec<InvitableItem>, AppError> {
    let rows = sqlx::query(
        "SELECT b.bot_id, b.username, b.display_name, b.avatar_url, b.created_by,
                EXISTS(
                    SELECT 1 FROM channel_memberships cm
                    WHERE cm.channel_id = $1 AND cm.member_id = b.bot_id
                      AND cm.member_type = 'bot'
                ) AS already_member
         FROM bot_accounts b
         WHERE b.is_disabled = FALSE
           AND (b.username ILIKE $2 OR b.display_name ILIKE $2)
         ORDER BY b.username
         LIMIT $3",
    )
    .bind(channel_id)
    .bind(pattern)
    .bind(BOT_CANDIDATE_POOL)
    .fetch_all(db)
    .await
    .map_err(AppError::Db)?;

    let caller_is_admin = matches!(caller.global_role, "system_admin" | "admin");
    let mut items = Vec::new();
    for row in rows {
        if items.len() as i64 >= PER_KIND_LIMIT {
            break;
        }
        let bot_id: String = row.try_get("bot_id").unwrap_or_default();
        let owner: Option<String> = row.try_get("created_by").ok().flatten();
        let invitable = caller_is_admin
            || owner.as_deref() == Some(caller.user_id)
            || acp_policy::allows(
                db,
                &bot_id,
                channel_id,
                caller.user_id,
                caller.channel_role,
                "cheers/session_create",
                Capability::Initiate,
            )
            .await
            .unwrap_or(false); // fail-closed：解析失败不进候选
        if !invitable {
            continue;
        }
        let is_online = match Uuid::parse_str(&bot_id) {
            Ok(id) => bot_locator.is_online(id).await,
            Err(_) => false,
        };
        items.push(InvitableItem {
            member_id: bot_id,
            member_type: "bot",
            username: row.try_get("username").ok(),
            display_name: row.try_get("display_name").ok().flatten(),
            avatar_url: row.try_get("avatar_url").ok().flatten(),
            is_online: Some(is_online),
            already_member: row.try_get("already_member").unwrap_or(false),
        });
    }
    Ok(items)
}
