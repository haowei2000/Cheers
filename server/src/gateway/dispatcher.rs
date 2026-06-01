/// 任务派发器。
///
/// 职责：
/// - 幂等检查（占位是否已存在）
/// - 创建 is_partial=true 占位消息
/// - 注册到 StreamRegistry
/// - 通过 BotLocator 发 control WS task 帧
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{
    registry::BotLocator,
    stream::{StreamEntry, StreamRegistry},
};
use crate::domain::{channel_seq, sessions};
use crate::gateway::realtime::{fanout::Fanout, frame::WireFrame};
use crate::infra::db::models::MESSAGE_SCHEMA_VERSION;

/// 派发参数。
pub struct DispatchParams {
    pub trigger_msg_id: Uuid,
    pub trigger_seq: i64,
    pub bot_id: Uuid,
    pub channel_id: Uuid,
    pub depth: i32,
    pub provider_session_key: String,
    pub session_id: Option<Uuid>,
}

/// 派发结果。
pub enum DispatchResult {
    /// 成功派发，返回占位 msg_id。
    Dispatched { placeholder_msg_id: Uuid },
    /// 幂等：该 (trigger_msg_id, bot_id) 已有占位且仍在处理，跳过。
    AlreadyInProgress,
    /// bot 不在线。
    BotOffline,
    /// 数据库错误。
    DbError(String),
}

pub async fn dispatch(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    params: DispatchParams,
) -> DispatchResult {
    // ── 幂等检查 ──────────────────────────────────────────────────────────────
    // 占位 id 由 (trigger_msg_id, bot_id) 确定性派生（R3）。
    // 同一输入永远得到同一 UUID，重跑时 upsert 同一占位，不新建。
    let placeholder_id = derive_placeholder_id(params.trigger_msg_id, params.bot_id);

    match check_idempotency(db, placeholder_id).await {
        IdempotencyState::InProgress => return DispatchResult::AlreadyInProgress,
        IdempotencyState::Done => return DispatchResult::AlreadyInProgress,
        IdempotencyState::NotFound => {} // 继续正常派发
        IdempotencyState::DbError(e) => return DispatchResult::DbError(e),
    }

    // ── 创建占位 Message（先落库）────────────────────────────────────────────
    let task_id = Uuid::new_v4();
    if let Err(e) = create_placeholder(db, placeholder_id, params.channel_id, params.bot_id, params.depth).await {
        return DispatchResult::DbError(e);
    }

    // ── 注册 StreamEntry ─────────────────────────────────────────────────────
    registry.register(StreamEntry {
        msg_id: placeholder_id,
        bot_id: params.bot_id,
        channel_id: params.channel_id,
        task_id,
        session_id: params.session_id,
        finalized: false,
    });

    // ── fan-out 占位气泡给浏览器（终态帧，先落库再投递）─────────────────────
    let bubble = WireFrame::channel(
        params.channel_id,
        "message",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": placeholder_id,
            "channel_id": params.channel_id,
            "channel_seq": null,
            "sender_id": params.bot_id,
            "sender_type": "bot",
            "content": "",
            "msg_type": "text",
            "is_partial": true,
            "reply_to_msg_id": null,
            "file_ids": [],
            "mentions": [],
            "files": [],
        }),
    );
    fanout.broadcast_channel(params.channel_id, bubble).await;

    // ── 通过 control WS 派发 task 帧给 bot ───────────────────────────────────
    let task_frame = build_task_frame(
        task_id,
        params.channel_id,
        params.trigger_msg_id,
        params.trigger_seq,
        params.depth,
        placeholder_id,
        &params.provider_session_key,
        params.session_id,
    );

    let delivered = bot_locator.dispatch_task(params.bot_id, task_frame).await;

    if !delivered {
        // bot 不在线：清理占位（或标记为失败，让前端看到错误提示）
        if let Ok(Some(failed)) = mark_placeholder_failed(db, placeholder_id).await {
            let done = WireFrame::channel(
                failed.channel_id,
                "message_done",
                json!({
                    "v": MESSAGE_SCHEMA_VERSION,
                    "msg_id": placeholder_id,
                    "channel_id": failed.channel_id,
                    "channel_seq": failed.channel_seq,
                    "sender_id": params.bot_id,
                    "sender_type": "bot",
                    "content": "[bot offline]",
                    "msg_type": "text",
                    "is_partial": false,
                    "reply_to_msg_id": null,
                    "file_ids": [],
                    "mentions": [],
                    "files": [],
                }),
            );
            fanout.broadcast_channel(failed.channel_id, done).await;
        }
        registry.remove(placeholder_id);
        if let Some(session_id) = params.session_id {
            let _ = sessions::finalize_session(db, session_id).await;
        }
        return DispatchResult::BotOffline;
    }

    DispatchResult::Dispatched {
        placeholder_msg_id: placeholder_id,
    }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/// R3：确定性派生占位 id。
/// UUID v5（SHA-1 namespace + "trigger_id:bot_id"）保证幂等。
fn derive_placeholder_id(trigger_msg_id: Uuid, bot_id: Uuid) -> Uuid {
    use uuid::Uuid;
    // 用 UUID v5 的 DNS namespace 作为固定 namespace
    let namespace = Uuid::NAMESPACE_DNS;
    let name = format!("{trigger_msg_id}:{bot_id}");
    Uuid::new_v5(&namespace, name.as_bytes())
}

enum IdempotencyState {
    NotFound,
    InProgress,
    Done,
    DbError(String),
}

async fn check_idempotency(db: &PgPool, placeholder_id: Uuid) -> IdempotencyState {
    match sqlx::query("SELECT is_partial, content FROM messages WHERE msg_id = $1")
        .bind(placeholder_id.to_string())
        .fetch_optional(db)
        .await
    {
        Err(e) => IdempotencyState::DbError(e.to_string()),
        Ok(None) => IdempotencyState::NotFound,
        Ok(Some(row)) => {
            let is_partial: bool = row.try_get("is_partial").unwrap_or(false);
            let content: String = row.try_get("content").unwrap_or_default();
            if is_partial || content.is_empty() {
                IdempotencyState::InProgress
            } else {
                IdempotencyState::Done
            }
        }
    }
}

async fn create_placeholder(
    db: &PgPool,
    placeholder_id: Uuid,
    channel_id: Uuid,
    bot_id: Uuid,
    depth: i32,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, is_partial, depth)
         VALUES ($1, $2, 'bot', $3, '', TRUE, $4)
         ON CONFLICT (msg_id) DO NOTHING",
    )
    .bind(placeholder_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(depth)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

struct FailedPlaceholder {
    channel_id: Uuid,
    channel_seq: i64,
}

async fn mark_placeholder_failed(
    db: &PgPool,
    placeholder_id: Uuid,
) -> Result<Option<FailedPlaceholder>, sqlx::Error> {
    let Some(channel_id) = sqlx::query(
        "SELECT channel_id
         FROM messages
         WHERE msg_id = $1 AND is_partial = TRUE AND channel_seq IS NULL",
    )
    .bind(placeholder_id.to_string())
    .fetch_optional(db)
    .await?
    .and_then(|row| row.try_get::<String, _>("channel_id").ok())
    .and_then(|raw| raw.parse::<Uuid>().ok()) else {
        return Ok(None);
    };

    let mut tx = db.begin().await?;
    let seq = channel_seq::allocate(&mut tx, channel_id).await?;
    let result = sqlx::query(
        "UPDATE messages
         SET is_partial = FALSE,
             content = '[bot offline]',
             channel_seq = $2
         WHERE msg_id = $1 AND is_partial = TRUE AND channel_seq IS NULL",
    )
    .bind(placeholder_id.to_string())
    .bind(seq)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(None);
    }

    tx.commit().await?;

    Ok(Some(FailedPlaceholder {
        channel_id,
        channel_seq: seq,
    }))
}

fn build_task_frame(
    task_id: Uuid,
    channel_id: Uuid,
    msg_id: Uuid,
    trigger_seq: i64,
    depth: i32,
    placeholder_msg_id: Uuid,
    provider_session_key: &str,
    session_id: Option<Uuid>,
) -> Value {
    let trigger = if depth > 0 { "bot_message" } else { "user_message" };

    json!({
        "type": "task",
        "task_id": task_id,
        "channel_id": channel_id,
        "msg_id": msg_id,
        "trigger_seq": trigger_seq,
        "depth": depth,
        "placeholder_msg_id": placeholder_msg_id,
        "provider_session_key": provider_session_key,
        "trigger": trigger,
        "session_id": session_id,
        "enqueued_at": chrono::Utc::now().to_rfc3339(),
    })
}
