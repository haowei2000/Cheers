/// 消息领域逻辑。
///
/// 核心流程（写后投递原则）：
///   1. 验成员资格
///   2. INSERT message → PG
///   3. fanout::broadcast（终态帧，先落库再投递）
///   4. 解析 bot 触发条件
///   5. 对每个触发的 bot 调 dispatcher::dispatch
use std::sync::Arc;

use chrono::Utc;
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    acp_bridge::{
        dispatcher::{self, DispatchParams},
        registry::BotLocator,
        stream::StreamRegistry,
    },
    errors::AppError,
    infra::db::models::MessageDto,
    realtime::{fanout::Fanout, frame::WireFrame},
};

// ── create_message ────────────────────────────────────────────────────────────

pub struct CreateMessageParams {
    pub user_id: Uuid,
    pub channel_id: Uuid,
    pub content: String,
    pub msg_type: Option<String>,
    pub reply_to_msg_id: Option<Uuid>,
}

pub async fn create_message(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    stream_registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    params: CreateMessageParams,
) -> Result<MessageDto, AppError> {
    // ── 1. 验成员资格 ─────────────────────────────────────────────────────
    let is_member = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(params.channel_id.to_string())
    .bind(params.user_id.to_string())
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if !is_member {
        return Err(AppError::Forbidden("not a channel member".into()));
    }

    // ── 2. 查发送者名字（用于 DTO）───────────────────────────────────────
    let sender_name: Option<String> = sqlx::query(
        "SELECT display_name FROM users WHERE id = $1",
    )
    .bind(params.user_id.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get("display_name").ok());

    // ── 3. 先落库（写后投递：INSERT 成功才广播）────────────────────────
    let msg_id = Uuid::new_v4();
    let msg_type = params.msg_type.as_deref().unwrap_or("text");
    let now = Utc::now();

    sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, is_deleted, in_reply_to_msg_id, created_at)
         VALUES ($1, $2, 'user', $3, $4, $5, FALSE, FALSE, $6, $7)",
    )
    .bind(msg_id.to_string())
    .bind(params.channel_id.to_string())
    .bind(params.user_id.to_string())
    .bind(&params.content)
    .bind(msg_type)
    .bind(params.reply_to_msg_id.map(|id| id.to_string()))
    .bind(now)
    .execute(db)
    .await
    .map_err(AppError::Db)?;

    let dto = MessageDto {
        msg_id: msg_id.to_string(),
        channel_id: params.channel_id.to_string(),
        sender_type: "user".into(),
        sender_id: Some(params.user_id.to_string()),
        sender_name: sender_name.clone(),
        content: params.content.clone(),
        msg_type: msg_type.to_string(),
        is_partial: false,
        reply_to_msg_id: params.reply_to_msg_id.map(|id| id.to_string()),
        created_at: now,
    };

    // ── 4. 再 fanout 终态帧（已落库，现在安全投递）────────────────────
    let wire = WireFrame::channel(
        params.channel_id,
        "message",
        json!({
            "msg_id": dto.msg_id,
            "channel_id": dto.channel_id,
            "sender_type": "user",
            "sender_id": params.user_id,
            "sender_name": sender_name,
            "content": dto.content,
            "msg_type": dto.msg_type,
            "is_partial": false,
            "created_at": now,
        }),
    );
    fanout.broadcast_channel(params.channel_id, wire).await;

    // ── 5. 解析 bot 触发，派发 task ───────────────────────────────────
    let bots = resolve_bot_triggers(db, params.channel_id, &params.content).await;
    for bot_id in bots {
        let result = dispatcher::dispatch(
            db,
            fanout,
            stream_registry,
            bot_locator,
            DispatchParams {
                trigger_msg_id: msg_id,
                bot_id,
                channel_id: params.channel_id,
                session_id: None,
            },
        )
        .await;

        if let dispatcher::DispatchResult::DbError(e) = result {
            tracing::warn!(bot_id = %bot_id, err = e, "dispatch failed");
        }
    }

    Ok(dto)
}

// ── Bot 触发解析 ──────────────────────────────────────────────────────────────

/// 判断哪些 bot 应该响应这条消息。
///
/// 当前规则（Phase 1 简化版）：
/// - 频道内所有 bot 成员
/// - 且 bot status = 'online'（有连接的 bot 才触发）
///
/// TODO Phase 2: auto_assist 开关、@mention 检测、coordinator 路由
async fn resolve_bot_triggers(db: &PgPool, channel_id: Uuid, _content: &str) -> Vec<Uuid> {
    let rows = sqlx::query(
        "SELECT cm.member_id
         FROM channel_memberships cm
         JOIN bot_accounts ba ON ba.id = cm.member_id
         WHERE cm.channel_id = $1
           AND cm.member_type = 'bot'
           AND ba.status = 'online'",
    )
    .bind(channel_id.to_string())
    .fetch_all(db)
    .await
    .unwrap_or_default();

    rows.iter()
        .filter_map(|r| {
            r.try_get::<String, _>("member_id")
                .ok()
                .and_then(|s| s.parse().ok())
        })
        .collect()
}

// ── list_messages ─────────────────────────────────────────────────────────────

pub async fn list_messages(
    db: &PgPool,
    user_id: Uuid,
    channel_id: Uuid,
    before: Option<String>,
    limit: i64,
) -> Result<Vec<MessageDto>, AppError> {
    // 成员校验
    let is_member = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2
        ) AS ok",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(db)
    .await
    .map_err(AppError::Db)?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if !is_member {
        return Err(AppError::Forbidden("not a channel member".into()));
    }

    let rows = if let Some(before_id) = before {
        sqlx::query(
            "SELECT m.msg_id AS id, m.channel_id, m.sender_type, m.sender_id,
                    u.display_name AS sender_name,
                    m.content, m.msg_type, m.is_partial,
                    m.in_reply_to_msg_id AS reply_to_msg_id, m.created_at
             FROM messages m
             LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
             WHERE m.channel_id = $1
               AND m.is_partial = FALSE
               AND m.created_at < (SELECT created_at FROM messages WHERE msg_id = $2)
             ORDER BY m.created_at DESC
             LIMIT $3",
        )
        .bind(channel_id.to_string())
        .bind(before_id)
        .bind(limit)
        .fetch_all(db)
        .await
        .map_err(AppError::Db)?
    } else {
        sqlx::query(
            "SELECT m.msg_id AS id, m.channel_id, m.sender_type, m.sender_id,
                    u.display_name AS sender_name,
                    m.content, m.msg_type, m.is_partial,
                    m.in_reply_to_msg_id AS reply_to_msg_id, m.created_at
             FROM messages m
             LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
             WHERE m.channel_id = $1 AND m.is_partial = FALSE
             ORDER BY m.created_at DESC
             LIMIT $2",
        )
        .bind(channel_id.to_string())
        .bind(limit)
        .fetch_all(db)
        .await
        .map_err(AppError::Db)?
    };

    let mut msgs: Vec<MessageDto> = rows.iter().map(MessageDto::from_row).collect();
    msgs.reverse(); // 按时间升序返回
    Ok(msgs)
}
