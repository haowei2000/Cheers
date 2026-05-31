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
use tracing::{debug, info};
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    errors::AppError,
    domain::mentions,
    gateway::{
        dispatcher::{self, DispatchParams},
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        stream::StreamRegistry,
    },
    infra::db::models::MessageDto,
};

// ── create_message ────────────────────────────────────────────────────────────

pub struct CreateMessageParams {
    pub user_id: Uuid,
    pub channel_id: Uuid,
    pub content: String,
    pub msg_type: Option<String>,
    pub reply_to_msg_id: Option<Uuid>,
    pub file_ids: Vec<String>,
}

pub async fn create_message(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    stream_registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    params: CreateMessageParams,
) -> Result<MessageDto, AppError> {
    info!(user_id = %params.user_id, channel_id = %params.channel_id, "create_message start");

    let file_ids = normalize_file_ids(&params.file_ids);
    if !file_ids.is_empty() {
        validate_file_ids(db, params.user_id, params.channel_id, &file_ids).await?;
    }

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
        info!(user_id = %params.user_id, channel_id = %params.channel_id, "create_message denied: user is not a member");
        return Err(AppError::Forbidden("not a channel member".into()));
    }

    // ── 2. 查发送者名字（用于 DTO）───────────────────────────────────────
    let sender_name: Option<String> = sqlx::query(
        "SELECT display_name FROM users WHERE user_id = $1",
    )
    .bind(params.user_id.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get("display_name").ok());

    // ── 3. 先落库（写后投递：INSERT 成功才广播）────────────────────────
    let mentions = mentions::parse(db, params.channel_id, &params.content).await;
    debug!(channel_id = %params.channel_id, mentions = mentions.len(), "mentions parsed");
    let msg_id = Uuid::new_v4();
    let msg_type = params.msg_type.as_deref().unwrap_or("text");
    let now = Utc::now();

    let mut tx = db.begin().await.map_err(AppError::Db)?;

    sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, is_deleted, in_reply_to_msg_id, file_ids, created_at)
         VALUES ($1, $2, 'user', $3, $4, $5, FALSE, FALSE, $6, $7, $8)",
    )
    .bind(msg_id.to_string())
    .bind(params.channel_id.to_string())
        .bind(params.user_id.to_string())
        .bind(&params.content)
        .bind(msg_type)
        .bind(params.reply_to_msg_id.map(|id| id.to_string()))
        .bind(json!(file_ids.clone()))
        .bind(now)
        .execute(&mut tx)
        .await
        .map_err(AppError::Db)?;

    mentions::insert_batch(&mut tx, msg_id, &mentions)
        .await
        .map_err(AppError::Db)?;

    tx.commit().await.map_err(AppError::Db)?;
    info!(message_id = %msg_id, channel_id = %params.channel_id, "message persisted");

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
        file_ids: file_ids.clone(),
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
            "file_ids": &dto.file_ids,
            "created_at": now,
        }),
    );
    fanout.broadcast_channel(params.channel_id, wire).await;
    info!(message_id = %msg_id, channel_id = %params.channel_id, "message fanout broadcast dispatched");

    // ── 5. 解析 bot 触发，派发 task ───────────────────────────────────
    let bots = resolve_bot_triggers(db, params.channel_id, &mentions).await;
    info!(message_id = %msg_id, matched_bots = bots.len(), "resolved bot triggers");
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

    info!(message_id = %msg_id, "create_message complete");
    Ok(dto)
}

fn normalize_file_ids(file_ids: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for raw in file_ids {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !normalized.iter().any(|existing| existing == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

async fn validate_file_ids(
    db: &PgPool,
    uploader_id: Uuid,
    channel_id: Uuid,
    file_ids: &[String],
) -> Result<(), AppError> {
    for file_id in file_ids {
        let status = sqlx::query(
            "SELECT status
             FROM file_records
             WHERE file_id = $1 AND channel_id = $2 AND uploader_id = $3",
        )
        .bind(file_id)
        .bind(channel_id.to_string())
        .bind(uploader_id.to_string())
        .fetch_optional(db)
        .await
        .map_err(AppError::Db)?
        .and_then(|row| row.try_get::<Option<String>, _>("status").ok().flatten());

        match status {
            Some(status) if status == "uploaded" => {}
            Some(status) => {
                return Err(AppError::BadRequest(format!(
                    "file_id {} is not ready (status={})",
                    file_id, status
                )));
            }
            None => {
                return Err(AppError::BadRequest(format!(
                    "invalid or inaccessible file_id {}",
                    file_id
                )));
            }
        }
    }

    Ok(())
}

// ── Bot 触发解析（mesh step 2）────────────────────────────────────────────────

/// 判断哪些 bot 应该响应这条消息（去中心化网格路由）。
///
/// 目标规则（DECENTRALIZED_MESH §2）：
///   1. 从 `mentions`（写入时已解析）中取 type=bot 的成员。
///   2. 若无 @bot mention，回落 `channels.default_bot_id`（覆盖 workspace 级）。
///   3. 返回空 → 静默（消息仍记录）。
///
/// `mentions` 由 `create_message` 在消息事务内解析后传入，无额外查询。
///
/// mesh step 2 完成前此函数保留 TODO 骨架；step 3 的事务改造届时一并接入。
async fn resolve_bot_triggers(
    db: &PgPool,
    channel_id: Uuid,
    mentions: &[crate::domain::mentions::Mention],
) -> Vec<Uuid> {
    use crate::domain::mentions::MemberType;

    // 1. 从已解析的 mentions 取 bot
    let mentioned_bots: Vec<Uuid> = mentions
        .iter()
        .filter(|m| m.member_type == MemberType::Bot)
        .map(|m| m.member_id)
        .collect();

    if !mentioned_bots.is_empty() {
        return mentioned_bots;
    }

    // 2. 无 @bot → 回落 channels.default_bot_id
    use sqlx::Row;

    match sqlx::query(
        "SELECT COALESCE(c.default_bot_id, w.default_bot_id) AS default_bot_id
         FROM channels c
         JOIN workspaces w ON w.workspace_id = c.workspace_id
         WHERE c.channel_id = $1",
    )
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    {
        Ok(Some(row)) => match row.try_get::<Option<String>, _>("default_bot_id") {
            Ok(Some(raw)) => Uuid::parse_str(&raw).into_iter().collect(),
            _ => vec![],
        },
        _ => vec![],
    }
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
                    m.content, m.msg_type, m.is_partial, m.file_ids,
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
                    m.content, m.msg_type, m.is_partial, m.file_ids,
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
