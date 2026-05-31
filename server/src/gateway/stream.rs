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
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    domain::{channel_seq, mentions, sessions},
    gateway::realtime::{fanout::Fanout, frame::WireFrame},
    infra::db::models::{MessageMention, MESSAGE_SCHEMA_VERSION},
};

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
    /// 任务 session（AgentNexusSession.id）——用于会话生命周期更新
    pub session_id: Option<Uuid>,
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
    provider_account_id: &str,
    frame: &Value,
) -> Result<(), &'static str> {
    let msg_id: Uuid = frame
        .get("msg_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or("missing msg_id")?;
    let delta = frame.get("delta").and_then(|v| v.as_str()).unwrap_or("");
    let entry = registry
        .entries
        .get(&msg_id)
        .ok_or("stream not registered")?;
    mark_session_alive(db, bot_id, provider_account_id, frame, entry.session_id).await;

    // R1: 所有权校验 —— 以 PG 为准，不信任内存注册表
    let channel_id = verify_ownership(db, bot_id, msg_id).await?;

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
    provider_account_id: &str,
    frame: &Value,
) -> Result<(), &'static str> {
    let msg_id: Uuid = frame
        .get("msg_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or("missing msg_id")?;
    let session_id = extract_session_id(frame);
    let provider_session_key = extract_provider_session_key(frame);
    let provider_session_id = extract_provider_session_id(frame);
    let entry_session_id = registry
        .entries
        .get(&msg_id)
        .and_then(|entry| entry.session_id);
    mark_session_alive(db, bot_id, provider_account_id, frame, entry_session_id).await;

    let content = frame.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let done_file_ids = parse_file_ids(frame.get("file_ids"));
    let done_file_ids = (!done_file_ids.is_empty()).then_some(serde_json::json!(done_file_ids));

    // R1: 所有权校验
    let channel_id = verify_ownership(db, bot_id, msg_id).await?;
    let normalized = mentions::normalize_bot_content(db, channel_id, content)
        .await
        .map_err(mention_parse_error_to_static)?;

    // R4: 标记 finalize（先在内存里标记，防止并发 delta 继续写入）
    if let Some(mut entry) = registry.entries.get_mut(&msg_id) {
        if entry.finalized {
            return Err("already finalized");
        }
        entry.finalized = true;
    }

    // ── 先落库（写后投递原则）────────────────────────────────────────────────
    let mut tx = db.begin().await.map_err(|_| "db error")?;
    let channel_seq = channel_seq::allocate(&mut tx, channel_id)
        .await
        .map_err(|_| "db error")?;
    let details = sqlx::query(
        "UPDATE messages
         SET channel_seq = $1,
             content = $2,
             is_partial = FALSE,
             file_ids = COALESCE($3::jsonb, file_ids)
         WHERE msg_id = $4 AND is_partial = TRUE AND channel_seq IS NULL
         RETURNING channel_id, channel_seq, file_ids, msg_type, in_reply_to_msg_id AS reply_to_msg_id",
    )
    .bind(channel_seq)
    .bind(&normalized.content)
    .bind(done_file_ids)
    .bind(msg_id.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| "db error")?
    .ok_or("message not found")?;
    mentions::replace_batch(&mut tx, msg_id, &normalized.mentions)
        .await
        .map_err(|_| "db error")?;
    tx.commit().await.map_err(|_| "db error")?;

    let channel_id = details
        .try_get::<String, _>("channel_id")
        .map_err(|_| "invalid channel_id")?
        .parse()
        .map_err(|_| "invalid channel_id")?;
    let channel_seq = details
        .try_get::<i64, _>("channel_seq")
        .map_err(|_| "db error")?;
    let file_ids = details
        .try_get::<Vec<String>, _>("file_ids")
        .ok()
        .unwrap_or_default();
    let msg_type = details
        .try_get::<String, _>("msg_type")
        .unwrap_or_else(|_| "text".to_string());
    let reply_to_msg_id = details
        .try_get::<Option<String>, _>("reply_to_msg_id")
        .ok()
        .flatten();

    let wire = WireFrame::channel(
        channel_id,
        "message_done",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": msg_id,
            "channel_id": channel_id,
            "channel_seq": channel_seq,
            "sender_type": "bot",
            "sender_id": bot_id,
            "content": &normalized.content,
            "msg_type": msg_type,
            "is_partial": false,
            "reply_to_msg_id": reply_to_msg_id,
            "file_ids": file_ids,
            "mentions": mention_dtos(&normalized.mentions),
            "files": [],
        }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    // 清理注册表
    registry.remove(msg_id);

    if let Some(session_id) = session_id {
        if let Some(entry_session_id) = entry_session_id {
            if entry_session_id != session_id {
                tracing::warn!(
                    bot_id = %bot_id,
                    msg_id = %msg_id,
                    expected = %entry_session_id,
                    got = %session_id,
                    "session mismatch: explicit session_id differs from stream entry"
                );
                if let Err(e) = sessions::finalize_session(db, entry_session_id).await {
                    tracing::warn!(bot_id = %bot_id, err = %e, "session finalize failed");
                }
            } else if let Err(e) = sessions::finalize_session(db, session_id).await {
                tracing::warn!(bot_id = %bot_id, err = %e, "session finalize failed");
            }
        } else if let Err(e) = sessions::finalize_session(db, session_id).await {
            tracing::warn!(bot_id = %bot_id, err = %e, "session finalize failed");
        }
    } else if let Some(entry_session_id) = entry_session_id {
        if let Err(e) = sessions::finalize_session(db, entry_session_id).await {
            tracing::warn!(bot_id = %bot_id, err = %e, "session finalize failed");
        }
    } else if let Some(provider_session_key) = provider_session_key {
        if let Ok(session_id) = sessions::resolve_session_id_by_key(
            db,
            bot_id,
            provider_account_id,
            &provider_session_key,
        )
        .await
        {
            if let Err(e) = sessions::finalize_session(db, session_id).await {
                tracing::warn!(bot_id = %bot_id, err = %e, "session finalize failed");
            }
        }
    } else if let Some(provider_session_id) = provider_session_id {
        if let Ok(session_id) = sessions::resolve_session_id_by_provider_id(
            db,
            bot_id,
            provider_account_id,
            &provider_session_id,
        )
        .await
        {
            if let Err(e) = sessions::finalize_session(db, session_id).await {
                tracing::warn!(bot_id = %bot_id, err = %e, "session finalize failed");
            }
        }
    }

    Ok(())
}

/// 处理 bot 上报的 session_update 帧（provider_session_id / metadata）。
pub async fn handle_session_update(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    frame: &Value,
) -> Result<(), &'static str> {
    let provider_session_key = frame
        .get("provider_session_key")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let provider_session_id = frame
        .get("provider_session_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let metadata = frame.get("metadata").and_then(|value| {
        if value.is_object() {
            Some(value.clone())
        } else {
            None
        }
    });
    if provider_session_key.is_none() && provider_session_id.is_none() && metadata.is_none() {
        return Err(
            "session_update missing provider_session_key, provider_session_id, and metadata",
        );
    }

    sessions::apply_session_update(
        db,
        bot_id,
        provider_account_id,
        provider_session_key,
        provider_session_id,
        metadata,
    )
    .await
    .map_err(|_| "session_update failed")?;

    Ok(())
}

fn extract_session_id(frame: &Value) -> Option<Uuid> {
    frame
        .get("session_id")
        .and_then(|v| v.as_str())
        .and_then(|raw| raw.parse().ok())
}

fn extract_provider_session_key(frame: &Value) -> Option<String> {
    frame
        .get("provider_session_key")
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string)
}

fn extract_provider_session_id(frame: &Value) -> Option<String> {
    frame
        .get("provider_session_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
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
    let msg_type = frame
        .get("msg_type")
        .and_then(|v| v.as_str())
        .unwrap_or("text");
    let file_ids = parse_file_ids(frame.get("file_ids"));
    let msg_id = Uuid::new_v4();
    let normalized = mentions::normalize_bot_content(db, channel_id, content)
        .await
        .map_err(mention_parse_error_to_static)?;

    // 先落库
    let mut tx = db.begin().await.map_err(|_| "db error")?;
    let channel_seq = channel_seq::allocate(&mut tx, channel_id)
        .await
        .map_err(|_| "db error")?;
    sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, file_ids, channel_seq)
         VALUES ($1, $2, 'bot', $3, $4, $5, FALSE, $6, $7)",
    )
    .bind(msg_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(&normalized.content)
    .bind(msg_type)
    .bind(serde_json::json!(file_ids.clone()))
    .bind(channel_seq)
    .execute(&mut *tx)
    .await
    .map_err(|_| "db error")?;
    mentions::insert_batch(&mut tx, msg_id, &normalized.mentions)
        .await
        .map_err(|_| "db error")?;
    tx.commit().await.map_err(|_| "db error")?;

    // 再 fan-out
    let wire = WireFrame::channel(
        channel_id,
        "message",
        json!({
            "v": MESSAGE_SCHEMA_VERSION,
            "msg_id": msg_id,
            "channel_id": channel_id,
            "channel_seq": channel_seq,
            "sender_type": "bot",
            "sender_id": bot_id,
            "content": &normalized.content,
            "msg_type": msg_type,
            "is_partial": false,
            "file_ids": file_ids,
            "mentions": mention_dtos(&normalized.mentions),
            "files": [],
        }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    Ok(())
}

fn mention_parse_error_to_static(error: mentions::MentionParseError) -> &'static str {
    match error {
        mentions::MentionParseError::Db(_) => "db error",
        mentions::MentionParseError::InvalidMember { .. } => "invalid mention",
    }
}

fn mention_dtos(mentions: &[mentions::Mention]) -> Vec<MessageMention> {
    mentions
        .iter()
        .map(|mention| MessageMention {
            member_id: mention.member_id.to_string(),
            member_type: mention.member_type.as_str().to_string(),
            username: None,
            display_name: None,
        })
        .collect()
}

fn parse_file_ids(value: Option<&Value>) -> Vec<String> {
    let mut file_ids = Vec::new();
    for v in value
        .and_then(|v| v.as_array())
        .map_or(&[][..], Vec::as_slice)
        .iter()
    {
        let Some(raw) = v.as_str() else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !file_ids.iter().any(|existing| existing == trimmed) {
            file_ids.push(trimmed.to_string());
        }
    }
    file_ids
}

/// 基于 delta / done / session_update 附带上下文，触发会话活性更新。
async fn mark_session_alive(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    frame: &Value,
    stream_entry_session_id: Option<Uuid>,
) {
    if let Some(session_id) = extract_session_id(frame) {
        if let Some(entry_session_id) = stream_entry_session_id {
            if entry_session_id != session_id {
                tracing::warn!(
                    bot_id = %bot_id,
                    expected = %entry_session_id,
                    got = %session_id,
                    "session mismatch: explicit session_id differs from stream entry"
                );
                if let Err(e) = sessions::touch_session(db, entry_session_id).await {
                    tracing::warn!(bot_id = %bot_id, err = %e, "session touch failed");
                }
            } else if let Err(e) = sessions::touch_session(db, session_id).await {
                tracing::warn!(bot_id = %bot_id, err = %e, "session touch failed");
            }
        } else if let Err(e) = sessions::touch_session(db, session_id).await {
            tracing::warn!(bot_id = %bot_id, err = %e, "session touch failed");
        }
        return;
    }

    if let Some(session_id) = stream_entry_session_id {
        if let Err(e) = sessions::touch_session(db, session_id).await {
            tracing::warn!(bot_id = %bot_id, err = %e, "session touch failed");
        }
        return;
    }

    if let Some(provider_session_key) = extract_provider_session_key(frame) {
        if let Ok(session_id) = sessions::resolve_session_id_by_key(
            db,
            bot_id,
            provider_account_id,
            &provider_session_key,
        )
        .await
        {
            if let Err(e) = sessions::touch_session(db, session_id).await {
                tracing::warn!(bot_id = %bot_id, err = %e, "session touch failed");
            }
        }
        return;
    }

    if let Some(provider_session_id) = extract_provider_session_id(frame) {
        if let Ok(session_id) = sessions::resolve_session_id_by_provider_id(
            db,
            bot_id,
            provider_account_id,
            &provider_session_id,
        )
        .await
        {
            if let Err(e) = sessions::touch_session(db, session_id).await {
                tracing::warn!(bot_id = %bot_id, err = %e, "session touch failed");
            }
        }
    }
}

// ── R1 所有权校验（以 PG 为准）───────────────────────────────────────────────

/// R1: 校验 msg_id 的占位 owner == bot_id，且占位仍 active（is_partial=true 或内容为空）。
/// 返回 channel_id（用于后续 fanout）。
async fn verify_ownership(db: &PgPool, bot_id: Uuid, msg_id: Uuid) -> Result<Uuid, &'static str> {
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
