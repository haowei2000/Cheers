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
    // ── 原子创建占位（先落库）────────────────────────────────────────────────
    // 占位 id 由 (trigger_msg_id, bot_id) 确定性派生（I4）：同一输入永远同一 UUID。
    // R5：不再用前置 SELECT 判幂等（与 INSERT 非原子，并发双触发会两边都通过，
    // 导致 task 帧派发两次、bot 重复跑同一任务）。改由 `INSERT … ON CONFLICT
    // DO NOTHING` 的 rows_affected 单点定胜负——只有真正插入占位的调用继续派发。
    let placeholder_id = derive_placeholder_id(params.trigger_msg_id, params.bot_id);
    let task_id = Uuid::new_v4();

    match create_placeholder(
        db,
        placeholder_id,
        params.channel_id,
        params.bot_id,
        params.depth,
    )
    .await
    {
        Ok(true) => {}                                          // 胜者：本次插入占位，继续派发
        Ok(false) => return DispatchResult::AlreadyInProgress, // 占位已存在（败者 / 重投）
        Err(e) => return DispatchResult::DbError(e),
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
    tracing::debug!(
        bot_id = %params.bot_id,
        channel_id = %params.channel_id,
        placeholder_msg_id = %placeholder_id,
        "placeholder created and empty bubble fanned out"
    );

    // ── 通过 control WS 派发 task 帧给 bot ───────────────────────────────────
    let task_context = load_task_context(db, params.trigger_msg_id)
        .await
        .unwrap_or_else(|| TaskContext::fallback(params.trigger_msg_id));
    let task_frame = build_task_frame(
        task_id,
        params.channel_id,
        params.trigger_msg_id,
        params.trigger_seq,
        params.depth,
        placeholder_id,
        &params.provider_session_key,
        params.session_id,
        task_context,
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

    tracing::info!(
        bot_id = %params.bot_id,
        channel_id = %params.channel_id,
        trigger_msg_id = %params.trigger_msg_id,
        placeholder_msg_id = %placeholder_id,
        task_id = %task_id,
        "task dispatched to bot"
    );
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

/// 原子创建占位。返回 `true` 表示本次 INSERT 胜出（rows_affected == 1）；
/// `false` 表示占位已存在（并发双触发的败者，或同一触发的重投）——调用方据此
/// 放弃派发，避免 bot 重复跑同一任务（R5）。
async fn create_placeholder(
    db: &PgPool,
    placeholder_id: Uuid,
    channel_id: Uuid,
    bot_id: Uuid,
    depth: i32,
) -> Result<bool, String> {
    let result = sqlx::query(
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
    .map_err(|e| e.to_string())?;

    Ok(result.rows_affected() == 1)
}

struct FailedPlaceholder {
    channel_id: Uuid,
    channel_seq: i64,
}

struct TaskContext {
    trigger_message: Value,
    attachments: Vec<Value>,
}

impl TaskContext {
    fn fallback(msg_id: Uuid) -> Self {
        Self {
            trigger_message: json!({ "msg_id": msg_id }),
            attachments: Vec::new(),
        }
    }
}

async fn load_task_context(db: &PgPool, msg_id: Uuid) -> Option<TaskContext> {
    let row = sqlx::query(
        "SELECT
            m.msg_id,
            m.sender_id,
            m.sender_type,
            m.content,
            m.created_at,
            m.msg_type,
            m.in_reply_to_msg_id,
            m.file_ids,
            COALESCE(NULLIF(u.display_name, ''), u.username, NULLIF(b.display_name, ''), b.username) AS sender_name
         FROM messages m
         LEFT JOIN users u ON m.sender_type = 'user' AND u.user_id = m.sender_id
         LEFT JOIN bot_accounts b ON m.sender_type = 'bot' AND b.bot_id = m.sender_id
         WHERE m.msg_id = $1",
    )
    .bind(msg_id.to_string())
    .fetch_optional(db)
    .await
    .ok()??;

    let file_ids = row
        .try_get::<Value, _>("file_ids")
        .ok()
        .and_then(|value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default();
    let attachments = file_ids
        .iter()
        .map(|file_id| json!({ "file_id": file_id }))
        .collect::<Vec<_>>();
    let timestamp = row
        .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
        .ok()
        .map(|dt| dt.to_rfc3339());
    let sender_id = row.try_get::<String, _>("sender_id").unwrap_or_default();
    let sender_name = row
        .try_get::<Option<String>, _>("sender_name")
        .ok()
        .flatten();

    Some(TaskContext {
        trigger_message: json!({
            "msg_id": msg_id,
            "user": sender_id,
            "sender_name": sender_name,
            "text": row.try_get::<String, _>("content").unwrap_or_default(),
            "timestamp": timestamp,
            "msg_type": row.try_get::<String, _>("msg_type").unwrap_or_else(|_| "text".to_string()),
            "in_reply_to_msg_id": row.try_get::<Option<String>, _>("in_reply_to_msg_id").ok().flatten(),
        }),
        attachments,
    })
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
    task_context: TaskContext,
) -> Value {
    let trigger = if depth > 0 {
        "bot_message"
    } else {
        "user_message"
    };

    json!({
        "type": "task",
        "v": 1,
        "task_id": task_id,
        "channel_id": channel_id,
        "trigger_msg_id": msg_id,
        "msg_id": msg_id,
        "trigger_seq": trigger_seq,
        "depth": depth,
        "placeholder_msg_id": placeholder_msg_id,
        "provider_session_key": provider_session_key,
        "trigger": trigger,
        "session_id": session_id,
        "session_policy": {
            "on_missing": "create",
            "on_paused": "resume",
            "after_task": "keep_active"
        },
        "trigger_message": task_context.trigger_message,
        "attachments": task_context.attachments,
        "session": {
            "id": session_id,
            "provider_session_key": provider_session_key,
            "task_scope_id": task_id,
        },
        "enqueued_at": chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// I4：同一 (trigger, bot) 必派生同一占位 id（重投收敛同一占位）。
    #[test]
    fn placeholder_id_is_deterministic() {
        let trigger = Uuid::new_v4();
        let bot = Uuid::new_v4();
        assert_eq!(
            derive_placeholder_id(trigger, bot),
            derive_placeholder_id(trigger, bot)
        );
    }

    /// 不同 trigger 或不同 bot → 不同占位 id（不会误合并两个任务）。
    #[test]
    fn placeholder_id_varies_by_inputs() {
        let trigger = Uuid::new_v4();
        let bot = Uuid::new_v4();
        let other = Uuid::new_v4();
        assert_ne!(
            derive_placeholder_id(trigger, bot),
            derive_placeholder_id(other, bot)
        );
        assert_ne!(
            derive_placeholder_id(trigger, bot),
            derive_placeholder_id(trigger, other)
        );
    }

    /// 占位 id 是 UUID v5（确定性命名空间散列，而非随机 v4）。
    #[test]
    fn placeholder_id_is_v5() {
        let id = derive_placeholder_id(Uuid::new_v4(), Uuid::new_v4());
        assert_eq!(id.get_version_num(), 5);
    }
}
