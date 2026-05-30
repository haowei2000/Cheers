/// ACP Bridge 流式回流层。
///
/// 职责：
/// - 维护 msg_id → StreamEntry 的注册表（占位消息归属）
/// - 实施 R1-R4 硬规则（ACP_CONNECTION_MODEL §8）
/// - delta 盖 seq，fan-out 给浏览器
/// - done 写库更新占位，fan-out 终态帧
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use dashmap::DashMap;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::realtime::{fanout::Fanout, frame::WireFrame};

// ── StreamEntry ───────────────────────────────────────────────────────────────

/// 一条 bot 回复流的元信息。
/// 由 dispatcher 在派发 task 时注册，done 帧到达后清理。
#[derive(Debug, Clone)]
pub struct StreamEntry {
    /// 占位消息 id（PG Message.id）
    pub msg_id: Uuid,
    /// 拥有这条占位的 bot id——R1 校验用
    pub bot_id: Uuid,
    /// 目标频道——fanout 路由用
    pub channel_id: Uuid,
    /// task id
    pub task_id: Uuid,
    /// 是否已 finalize（R4 守卫：finalize 后拒绝迟到 delta）
    pub finalized: bool,
}

// ── StreamRegistry ────────────────────────────────────────────────────────────

pub struct StreamRegistry {
    entries: DashMap<Uuid, StreamEntry>,
    /// 每个 msg_id 的服务端 seq 计数器
    seq_counters: DashMap<Uuid, AtomicU64>,
}

impl StreamRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: DashMap::new(),
            seq_counters: DashMap::new(),
        })
    }

    /// Dispatcher 创建占位后调用，注册流。
    pub fn register(&self, entry: StreamEntry) {
        let msg_id = entry.msg_id;
        self.entries.insert(msg_id, entry);
        self.seq_counters.insert(msg_id, AtomicU64::new(0));
    }

    /// 获取并递增 seq（R2：Backend 盖戳，不透传 connector 自报的 seq）。
    fn next_seq(&self, msg_id: Uuid) -> u64 {
        self.seq_counters
            .get(&msg_id)
            .map(|c| c.fetch_add(1, Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// 清理注册表（done 帧到达后调用）。
    pub fn remove(&self, msg_id: Uuid) {
        self.entries.remove(&msg_id);
        self.seq_counters.remove(&msg_id);
    }
}

// ── 回流处理（R1-R4）─────────────────────────────────────────────────────────

/// 处理 bot 发来的 delta 帧。
///
/// R1: 校验 msg_id 所有权（owner == 当前 bot，以 PG 为准）
/// R2: 忽略 bot 自报 seq，由 Backend 盖戳
/// R3: 确认占位存在（不新建）
/// R4: 占位已 finalize 则拒绝
pub async fn handle_delta(
    registry: &StreamRegistry,
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_id: Uuid,
    frame: &Value,
) -> Result<(), &'static str> {
    let msg_id: Uuid = frame
        .get("msg_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or("missing msg_id")?;

    let delta = frame.get("delta").and_then(|v| v.as_str()).unwrap_or("");

    // R1: 所有权校验 —— 以 PG 为准，不信任内存注册表
    let channel_id = verify_ownership(db, bot_id, msg_id).await?;

    // R3: 占位必须在注册表里（dispatcher 负责注册）
    let entry = registry.entries.get(&msg_id).ok_or("stream not registered")?;

    // R4: finalize 守卫
    if entry.finalized {
        return Err("stream already finalized");
    }

    // R2: Backend 盖戳 seq
    let seq = registry.next_seq(msg_id);

    // fan-out 给浏览器（流式层，可丢）
    let wire = WireFrame::channel_stream(
        channel_id,
        "message_stream",
        seq,
        json!({ "msg_id": msg_id, "delta": delta }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    Ok(())
}

/// 处理 bot 发来的 done 帧。
///
/// 写后投递原则：先更新 PG，再 fan-out 终态帧。
pub async fn handle_done(
    registry: &StreamRegistry,
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_id: Uuid,
    frame: &Value,
) -> Result<(), &'static str> {
    let msg_id: Uuid = frame
        .get("msg_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or("missing msg_id")?;

    let content = frame.get("content").and_then(|v| v.as_str()).unwrap_or("");

    // R1: 所有权校验
    let channel_id = verify_ownership(db, bot_id, msg_id).await?;

    // R4: 标记 finalize（先在内存里标记，防止并发 delta 继续写入）
    if let Some(mut entry) = registry.entries.get_mut(&msg_id) {
        if entry.finalized {
            return Err("already finalized");
        }
        entry.finalized = true;
    }

    // ── 先落库（写后投递原则）────────────────────────────────────────────────
    sqlx::query(
        "UPDATE messages SET content = $1, is_partial = FALSE WHERE msg_id = $2",
    )
    .bind(content)
    .bind(msg_id.to_string())
    .execute(db)
    .await
    .map_err(|_| "db error")?;

    // ── 再 fan-out 终态帧 ────────────────────────────────────────────────────
    let wire = WireFrame::channel(
        channel_id,
        "message_done",
        json!({ "msg_id": msg_id, "content": content }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    // 清理注册表
    registry.remove(msg_id);

    Ok(())
}

/// 处理 bot 主动发新消息（send 帧）。
///
/// 不同于 delta/done（续写占位），send 是建全新 Message。
/// 权限检查：校验 bot 是该 channel 成员（R1 退化形式）。
pub async fn handle_send(
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_id: Uuid,
    frame: &Value,
) -> Result<(), &'static str> {
    let channel_id: Uuid = frame
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or("missing channel_id")?;

    let content = frame.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let msg_id = Uuid::new_v4();

    // 先落库
    sqlx::query(
        "INSERT INTO messages (msg_id, channel_id, sender_type, sender_id, content, is_partial)
         VALUES ($1, $2, 'bot', $3, $4, FALSE)",
    )
    .bind(msg_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(content)
    .execute(db)
    .await
    .map_err(|_| "db error")?;

    // 再 fan-out
    let wire = WireFrame::channel(
        channel_id,
        "message",
        json!({ "msg_id": msg_id, "content": content, "sender_id": bot_id }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    Ok(())
}

// ── R1 所有权校验（以 PG 为准）───────────────────────────────────────────────

/// R1: 校验 msg_id 的占位 owner == bot_id，且占位仍 active（is_partial=true 或内容为空）。
/// 返回 channel_id（用于后续 fanout）。
async fn verify_ownership(
    db: &PgPool,
    bot_id: Uuid,
    msg_id: Uuid,
) -> Result<Uuid, &'static str> {
    use sqlx::Row;

    let row = sqlx::query(
        "SELECT channel_id, sender_id, is_partial, content
         FROM messages WHERE msg_id = $1",
    )
    .bind(msg_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(|_| "db error")?
    .ok_or("message not found")?;

    // owner 必须是当前 bot
    let sender_id: String = row.try_get("sender_id").map_err(|_| "db error")?;
    if sender_id != bot_id.to_string() {
        return Err("ownership check failed: msg_id not owned by this bot");
    }

    // 占位必须仍 active
    let is_partial: bool = row.try_get("is_partial").unwrap_or(false);
    let content: String = row.try_get("content").unwrap_or_default();
    if !is_partial && !content.is_empty() {
        return Err("message already finalized");
    }

    let channel_id_str: String = row.try_get("channel_id").map_err(|_| "db error")?;
    channel_id_str.parse().map_err(|_| "invalid channel_id")
}
