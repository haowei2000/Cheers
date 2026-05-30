/// 任务派发器。
///
/// 职责：
/// - 幂等检查（占位是否已存在）
/// - 创建 is_partial=true 占位消息
/// - 注册到 StreamRegistry
/// - 通过 BotLocator 发 control WS task 帧
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    registry::BotLocator,
    stream::{StreamEntry, StreamRegistry},
};
use crate::realtime::{fanout::Fanout, frame::WireFrame};

/// 派发参数。
pub struct DispatchParams {
    pub trigger_msg_id: Uuid,
    pub bot_id: Uuid,
    pub channel_id: Uuid,
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

    if let Err(e) = create_placeholder(db, placeholder_id, params.channel_id, params.bot_id).await {
        return DispatchResult::DbError(e);
    }

    // ── 注册 StreamEntry ─────────────────────────────────────────────────────
    registry.register(StreamEntry {
        msg_id: placeholder_id,
        bot_id: params.bot_id,
        channel_id: params.channel_id,
        task_id,
        finalized: false,
    });

    // ── fan-out 占位气泡给浏览器（终态帧，先落库再投递）─────────────────────
    let bubble = WireFrame::channel(
        params.channel_id,
        "message",
        json!({
            "msg_id": placeholder_id,
            "sender_id": params.bot_id,
            "sender_type": "bot",
            "content": "",
            "is_partial": true,
        }),
    );
    fanout.broadcast_channel(params.channel_id, bubble).await;

    // ── 通过 control WS 派发 task 帧给 bot ───────────────────────────────────
    let task_frame = build_task_frame(
        task_id,
        params.channel_id,
        params.trigger_msg_id,
        placeholder_id,
        params.session_id,
    );

    let delivered = bot_locator
        .dispatch_task(params.bot_id, task_frame)
        .await;

    if !delivered {
        // bot 不在线：清理占位（或标记为失败，让前端看到错误提示）
        let _ = mark_placeholder_failed(db, placeholder_id).await;
        registry.remove(placeholder_id);
        return DispatchResult::BotOffline;
    }

    DispatchResult::Dispatched { placeholder_msg_id: placeholder_id }
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
    use sqlx::Row;

    match sqlx::query(
        "SELECT is_partial, content FROM messages WHERE msg_id = $1",
    )
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
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO messages (msg_id, channel_id, sender_type, sender_id, content, is_partial)
         VALUES ($1, $2, 'bot', $3, '', TRUE)
         ON CONFLICT (msg_id) DO NOTHING",
    )
    .bind(placeholder_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

async fn mark_placeholder_failed(db: &PgPool, placeholder_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE messages SET is_partial = FALSE, content = '[bot offline]'
         WHERE msg_id = $1 AND is_partial = TRUE",
    )
    .bind(placeholder_id.to_string())
    .execute(db)
    .await
    .map(|_| ())
}

fn build_task_frame(
    task_id: Uuid,
    channel_id: Uuid,
    msg_id: Uuid,
    placeholder_msg_id: Uuid,
    session_id: Option<Uuid>,
) -> Value {
    json!({
        "type": "task",
        "task_id": task_id,
        "channel_id": channel_id,
        "msg_id": msg_id,
        "placeholder_msg_id": placeholder_msg_id,
        "trigger": "user_message",
        "session_id": session_id,
        "enqueued_at": chrono::Utc::now().to_rfc3339(),
    })
}
