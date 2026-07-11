/// Agent Bridge 流式回流层。
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
    domain::{chains, channel_seq, mentions, sessions},
    gateway::{
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
    },
    infra::db::models::{MessageMention, MESSAGE_SCHEMA_VERSION},
    resource::{authorize_channel_write, Principal},
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
    /// 任务 session（CheersSession.id）——用于会话生命周期更新
    pub session_id: Option<Uuid>,
    /// 是否已 finalize（R4 守卫：finalize 后拒绝迟到 delta）
    pub finalized: bool,
    /// 上次 touch_session 的时间戳（epoch millis）。每个 delta 都 touch 同一 session
    /// 行会产生写放大，故按 `SESSION_TOUCH_DEBOUNCE_MS` 去抖；首个 delta 仍立即置 busy。
    /// `Arc` 让 StreamEntry 的 Clone 与 DashMap Ref 共享同一计数器。
    pub last_touched_ms: Arc<AtomicU64>,
}

/// 同一 session 行的 touch 去抖窗口（毫秒）。窗口内的 delta 仅损失亚秒级 last_used_at 精度。
const SESSION_TOUCH_DEBOUNCE_MS: u64 = 2000;

/// 当前时间的 epoch 毫秒（touch 去抖用）。时钟回拨时 saturating_sub 会退化为立即 touch。
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

    /// R4 守卫：原子地认领 finalize（在 DashMap 分片写锁下 read-and-set，
    /// 无独立读写窗口）。done 帧借此挡住并发迟到的 delta / 第二个 done。
    fn claim_finalize(&self, msg_id: Uuid) -> FinalizeClaim {
        match self.entries.get_mut(&msg_id) {
            None => FinalizeClaim::NotRegistered,
            Some(mut entry) => {
                if entry.finalized {
                    FinalizeClaim::AlreadyFinalized
                } else {
                    entry.finalized = true;
                    FinalizeClaim::Claimed
                }
            }
        }
    }

    /// 清理注册表（done 帧到达后调用）。
    pub fn remove(&self, msg_id: Uuid) {
        self.entries.remove(&msg_id);
        self.seq_counters.remove(&msg_id);
    }

    /// 是否存在该 msg_id 的存活流（孤儿回收器据此跳过正在流式的占位）。
    pub fn contains(&self, msg_id: Uuid) -> bool {
        self.entries.contains_key(&msg_id)
    }
}

/// `claim_finalize` 的认领结果（R4 守卫）。
#[derive(Debug, PartialEq, Eq)]
enum FinalizeClaim {
    /// 本次成功把流标记为 finalize（此前未 finalize）。
    Claimed,
    /// 流已被先前的 done 帧 finalize——并发迟到的 done 应被拒绝。
    AlreadyFinalized,
    /// 流未注册——done 到达时占位理应仍在；按既有行为放行。
    NotRegistered,
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

    // 复制所需字段后立即释放 DashMap 分片读锁——不得跨 .await 持有守卫，否则并发写者
    // （register / claim_finalize / remove）会在 DB 往返期间被同步阻塞其 worker 线程。
    let (session_id, last_touched_ms) = {
        let entry = registry
            .entries
            .get(&msg_id)
            .ok_or("stream not registered")?;
        (entry.session_id, entry.last_touched_ms.clone())
    };

    // touch 去抖：首个 delta 立即置 busy；窗口内的后续 delta 跳过 session 行 UPDATE，
    // 仅损失亚秒级 last_used_at 精度。compare_exchange 防止并发帧重复 touch。
    let now = now_millis();
    let prev = last_touched_ms.load(Ordering::Relaxed);
    let should_touch = now.saturating_sub(prev) >= SESSION_TOUCH_DEBOUNCE_MS
        && last_touched_ms
            .compare_exchange(prev, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok();

    // R1 所有权校验与（偶发的）session touch 并发执行——两者互不依赖，省去一次串行往返。
    let (owner, _) = tokio::join!(verify_ownership(db, bot_id, msg_id), async {
        if should_touch {
            mark_session_alive(db, bot_id, provider_account_id, frame, session_id).await;
        }
    });
    let channel_id = owner?;

    // R4: finalize 守卫——.await 后重新读取（done 已 remove entry 视同 gone）。
    match registry.entries.get(&msg_id).map(|e| e.finalized) {
        None => return Err("stream not registered"),
        Some(true) => return Err("stream already finalized"),
        Some(false) => {}
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

/// bot@bot 回复触发从数据 WS 读循环里 spawn 出去执行。触发的下一跳
/// （acquire_scope_session + dispatch 的 S3 拉取 + base64）耗时可达数百 ms；若 inline
/// await，会 head-of-line 阻塞该 connector 上多路复用的所有其他流。此时源消息已落库、
/// 终态帧已广播、ack 已发出——链的排序不属于协议契约，故安全后台化。
/// Returns the spawned task's handle. Production callers drop it (fire-and-forget —
/// that IS the point: don't block the read loop). Tests can `.await` it to observe the
/// otherwise-async trigger deterministically.
#[allow(clippy::too_many_arguments)]
fn spawn_trigger_bot_replies(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &Arc<StreamRegistry>,
    bot_locator: &Arc<dyn BotLocator>,
    channel_id: Uuid,
    msg_id: Uuid,
    channel_seq: i64,
    depth: i32,
    author_bot_id: Uuid,
    mentions: Vec<mentions::Mention>,
    chain_id: Option<String>,
) -> tokio::task::JoinHandle<()> {
    let db = db.clone();
    let fanout = fanout.clone();
    let registry = registry.clone();
    let bot_locator = bot_locator.clone();
    tokio::spawn(async move {
        if let Err(e) = chains::trigger_bot_replies(
            &db,
            &fanout,
            &registry,
            &bot_locator,
            channel_id,
            msg_id,
            channel_seq,
            depth,
            author_bot_id,
            &mentions,
            chain_id.as_deref(),
        )
        .await
        {
            tracing::warn!(msg_id = %msg_id, err = %e, "bot reply trigger failed");
        }
    })
}

/// 处理 bot 发来的 done 帧。
///
/// 写后投递原则：先更新 PG，再 fan-out 终态帧。
pub async fn handle_done(
    registry: &Arc<StreamRegistry>,
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    bot_id: Uuid,
    provider_account_id: &str,
    frame: &Value,
) -> Result<(), &'static str> {
    let msg_id: Uuid = frame
        .get("msg_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or("missing msg_id")?;
    let entry_session_id = registry
        .entries
        .get(&msg_id)
        .and_then(|entry| entry.session_id);
    mark_session_alive(db, bot_id, provider_account_id, frame, entry_session_id).await;

    let content = frame.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let done_file_ids = parse_file_ids(frame.get("file_ids"));
    let done_file_ids = (!done_file_ids.is_empty()).then_some(serde_json::json!(done_file_ids));
    let mention_ids = parse_mention_ids(frame.get("mention_ids"));

    // R1: 所有权校验
    let channel_id = verify_ownership(db, bot_id, msg_id).await?;
    let mentions = mentions::validate_mention_ids(db, channel_id, &mention_ids)
        .await
        .map_err(mention_parse_error_to_static)?;

    // R4: 标记 finalize（先在内存里标记，防止并发 delta 继续写入）
    if registry.claim_finalize(msg_id) == FinalizeClaim::AlreadyFinalized {
        return Err("already finalized");
    }

    // ── 先落库（写后投递原则）────────────────────────────────────────────────
    let mut tx = db
        .begin()
        .await
        .map_err(crate::gateway::log_db_err("stream.done: begin tx"))?;
    let channel_seq =
        channel_seq::allocate(&mut tx, channel_id)
            .await
            .map_err(crate::gateway::log_db_err(
                "stream.done: allocate channel_seq",
            ))?;
    let details = sqlx::query(
        "UPDATE messages
         SET channel_seq = $1,
             content = $2,
             is_partial = FALSE,
             file_ids = COALESCE($3::jsonb, file_ids)
         WHERE msg_id = $4 AND is_partial = TRUE AND channel_seq IS NULL
         RETURNING channel_id, channel_seq, depth, file_ids, msg_type, in_reply_to_msg_id AS reply_to_msg_id, chain_id",
    )
    .bind(channel_seq)
    .bind(content)
    .bind(done_file_ids)
    .bind(msg_id.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(crate::gateway::log_db_err("stream.done: finalize message update"))?
    .ok_or("message not found")?;
    mentions::replace_batch(&mut tx, msg_id, &mentions)
        .await
        .map_err(crate::gateway::log_db_err("stream.done: replace mentions"))?;
    tx.commit()
        .await
        .map_err(crate::gateway::log_db_err("stream.done: commit tx"))?;

    let channel_id = details
        .try_get::<String, _>("channel_id")
        .map_err(|_| "invalid channel_id")?
        .parse()
        .map_err(|_| "invalid channel_id")?;
    let channel_seq =
        details
            .try_get::<i64, _>("channel_seq")
            .map_err(crate::gateway::log_db_err(
                "stream.done: read channel_seq column",
            ))?;
    let depth = details.try_get::<i32, _>("depth").unwrap_or(0);
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
    // The chain this reply belongs to — propagated to any next hop so the whole
    // bot@bot cascade shares one cancelable chain (§8).
    let chain_id = details
        .try_get::<Option<String>, _>("chain_id")
        .ok()
        .flatten();

    // Resolve attachment metadata (incl. staged files, with status) so the live
    // frame renders attachments immediately — e.g. a staged file as a clickable
    // tile to realize — instead of only after a history reload.
    let files = crate::domain::messages::load_message_files(db, &file_ids)
        .await
        .unwrap_or_default();

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
            "content": content,
            "msg_type": msg_type,
            "is_partial": false,
            "reply_to_msg_id": reply_to_msg_id,
            "file_ids": file_ids,
            "mentions": mention_dtos(&mentions),
            "files": files,
        }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    // 清理注册表
    registry.remove(msg_id);

    // depth 上限 / 自 @ 过滤 / bot@bot INITIATE 门禁都在 trigger_bot_replies 内部处理。
    // chain_id 从本条回复继承，下一跳共享同一条可取消链（§8 gate 也在内部）。
    // spawn 出去，避免下一跳的 dispatch（S3 拉取 + base64）阻塞本 connector 的读循环。
    spawn_trigger_bot_replies(
        db, fanout, registry, bot_locator, channel_id, msg_id, channel_seq, depth, bot_id,
        mentions, chain_id,
    );

    // finalize_session 保持 inline：单条快速 UPDATE，且 spawn 会扩大与 acquire_scope_session
    // 无条件 upsert 的 BUSY/IDLE 竞态窗口。
    if let Some(sid) =
        resolve_session_id(db, bot_id, provider_account_id, frame, entry_session_id).await
    {
        if let Err(e) = sessions::finalize_session(db, sid).await {
            tracing::warn!(bot_id = %bot_id, err = %e, "session finalize failed");
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

/// Pure precedence between an explicit session id and the stream entry id.
///
/// - Explicit id present + entry id present + they differ → log the "session
///   mismatch" warning (once) and prefer the **entry** id.
/// - Explicit id present + entry id present + equal → use the explicit id.
/// - Only one of them present → use whichever is present.
///
/// No DB access; unit-testable without a live Postgres.
fn decide_explicit_or_entry(
    bot_id: Uuid,
    explicit_session_id: Option<Uuid>,
    entry_session_id: Option<Uuid>,
) -> Option<Uuid> {
    match (explicit_session_id, entry_session_id) {
        (Some(explicit), Some(entry)) => {
            if explicit != entry {
                tracing::warn!(
                    bot_id = %bot_id,
                    expected = %entry,
                    got = %explicit,
                    "session mismatch: explicit session_id differs from stream entry"
                );
                Some(entry)
            } else {
                Some(explicit)
            }
        }
        (Some(explicit), None) => Some(explicit),
        (None, entry) => entry,
    }
}

/// Resolve which session_id a done/update frame refers to, by the 4-source
/// precedence (explicit id > stream entry > provider_session_key > provider_session_id).
/// On explicit-vs-entry mismatch, logs the warning and prefers the entry id.
/// Returns None if nothing resolves.
async fn resolve_session_id(
    db: &PgPool,
    bot_id: Uuid,
    provider_account_id: &str,
    frame: &Value,
    stream_entry_session_id: Option<Uuid>,
) -> Option<Uuid> {
    // Sources 1-2: explicit id vs stream entry (pure, no DB).
    if let Some(sid) =
        decide_explicit_or_entry(bot_id, extract_session_id(frame), stream_entry_session_id)
    {
        return Some(sid);
    }

    // Source 3: provider_session_key → DB lookup (errors silently ignored).
    if let Some(key) = extract_provider_session_key(frame) {
        return sessions::resolve_session_id_by_key(db, bot_id, provider_account_id, &key)
            .await
            .ok();
    }

    // Source 4: provider_session_id → DB lookup (errors silently ignored).
    if let Some(id) = extract_provider_session_id(frame) {
        return sessions::resolve_session_id_by_provider_id(db, bot_id, provider_account_id, &id)
            .await
            .ok();
    }

    None
}

/// 处理 bot 主动发新消息（send 帧）。
///
/// 不同于 delta/done（续写占位），send 是建全新 Message。
/// 权限检查：bot token 只映射身份；频道写权限由 membership role 决定。
pub async fn handle_send(
    registry: &Arc<StreamRegistry>,
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    bot_id: Uuid,
    frame: &Value,
) -> Result<Uuid, &'static str> {
    let channel_id: Uuid = frame
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or("missing channel_id")?;

    let principal = Principal::bot(bot_id);
    authorize_channel_write(db, &principal, channel_id)
        .await
        .map_err(|(code, _)| {
            if code == "INTERNAL_ERROR" {
                "db error"
            } else {
                "bot is not allowed to write to the target channel"
            }
        })?;

    let content = frame
        .get("content")
        .or_else(|| frame.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let msg_type = frame
        .get("msg_type")
        .and_then(|v| v.as_str())
        .unwrap_or("text");
    let reply_to_msg_id = frame
        .get("in_reply_to_msg_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let file_ids = parse_file_ids(frame.get("file_ids"));
    let mention_ids = parse_mention_ids(frame.get("mention_ids"));
    let msg_id = Uuid::new_v4();
    let mentions = mentions::validate_mention_ids(db, channel_id, &mention_ids)
        .await
        .map_err(mention_parse_error_to_static)?;

    // 先落库
    let mut tx = db
        .begin()
        .await
        .map_err(crate::gateway::log_db_err("stream.send: begin tx"))?;
    let channel_seq =
        channel_seq::allocate(&mut tx, channel_id)
            .await
            .map_err(crate::gateway::log_db_err(
                "stream.send: allocate channel_seq",
            ))?;
    sqlx::query(
        "INSERT INTO messages
            (msg_id, channel_id, sender_type, sender_id, content, msg_type,
             is_partial, file_ids, channel_seq, in_reply_to_msg_id)
         VALUES ($1, $2, 'bot', $3, $4, $5, FALSE, $6, $7, $8)",
    )
    .bind(msg_id.to_string())
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .bind(content)
    .bind(msg_type)
    .bind(serde_json::json!(file_ids.clone()))
    .bind(channel_seq)
    .bind(&reply_to_msg_id)
    .execute(&mut *tx)
    .await
    .map_err(crate::gateway::log_db_err("stream.send: insert message"))?;
    mentions::insert_batch(&mut tx, msg_id, &mentions)
        .await
        .map_err(crate::gateway::log_db_err("stream.send: insert mentions"))?;
    tx.commit()
        .await
        .map_err(crate::gateway::log_db_err("stream.send: commit tx"))?;

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
            "content": content,
            "msg_type": msg_type,
            "is_partial": false,
            "reply_to_msg_id": reply_to_msg_id,
            "file_ids": file_ids,
            "mentions": mention_dtos(&mentions),
            "files": [],
        }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    // 主动 send 里的 @bot 也要能派活。视作 depth=0（与用户发消息触发对等），
    // 后续 done 链再逐跳 +1 受 MAX_BOT_REPLY_DEPTH 约束。自 @ 过滤与 INITIATE
    // 门禁在 trigger_bot_replies 内部统一处理。
    // chain：主动 send 拿不到当前任务上下文，best-effort 继承发送 bot 进行中任务
    // 的链（让多跳 post_message 级联共享同一条可取消链），无则新起一条（§8）。
    let chain_id = chain_for_proactive_send(db, channel_id, bot_id, msg_id, &mentions).await;
    // spawn：同 handle_done，避免下一跳 dispatch 阻塞 connector 读循环。
    spawn_trigger_bot_replies(
        db, fanout, registry, bot_locator, channel_id, msg_id, channel_seq, 0, bot_id, mentions,
        chain_id,
    );

    Ok(msg_id)
}

/// Chain assignment for a bot's proactive send / post_message. There is no task
/// context on this path (same gap as the depth reset), so we best-effort inherit
/// the chain of the bot's in-flight task — keeping a multi-hop post_message
/// cascade on ONE cancelable chain — and only root a fresh chain when the bot
/// isn't already in one AND the message actually triggers a bot (no dead rows).
async fn chain_for_proactive_send(
    db: &PgPool,
    channel_id: Uuid,
    author_bot_id: Uuid,
    msg_id: Uuid,
    mentions: &[mentions::Mention],
) -> Option<String> {
    if mentions.is_empty() {
        return None;
    }
    match crate::domain::task_chains::chain_of_active_bot_task(db, channel_id, author_bot_id).await {
        Ok(Some(cid)) => Some(cid),
        _ => crate::domain::task_chains::start_chain(db, channel_id, msg_id, msg_id)
            .await
            .ok()
            .map(|c| c.to_string()),
    }
}

/// `channel.messages.create`（bot 主动 post_message 走的 resource 路径）落库后的副作用：
/// **live 广播** + **bot@bot 触发**。
///
/// `resource::dispatch` 只带 `db`，广播/触发所需的 fanout/registry/bot_locator 只在
/// bot-bridge WS 边界才有，所以在 agent_bridge 收到 `resource_res` 后由这里补做——
/// 与 [`handle_send`] / [`handle_done`] 的行为对齐（同样的自 @ 过滤 / depth 上限 /
/// INITIATE 门禁，都在 `trigger_bot_replies` 内部）。`created` 是 `handle_create`
/// 返回的 `MessageDto` JSON；解析失败则静默跳过（消息已落库，不影响主流程）。
/// Returns the bot@bot trigger's spawned task handle (or `None` when nothing is
/// triggered). Production drops it (fire-and-forget); tests `.await` it to observe the
/// trigger deterministically.
pub async fn broadcast_and_trigger_created_message(
    registry: &Arc<StreamRegistry>,
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    author_bot_id: Uuid,
    created: &Value,
) -> Option<tokio::task::JoinHandle<()>> {
    let (Some(msg_id), Some(channel_id)) = (
        created
            .get("msg_id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<Uuid>().ok()),
        created
            .get("channel_id")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<Uuid>().ok()),
    ) else {
        return None;
    };

    // 1) live 广播：DTO 原样投递，前端与 handle_send 的 "message" 帧同形（多余字段无害）。
    let wire = WireFrame::channel(channel_id, "message", created.clone());
    fanout.broadcast_channel(channel_id, wire).await;

    // 2) bot@bot 触发：从 DTO 的 mentions 还原 Vec<Mention>，depth=0（与用户发消息对等）。
    let mentions = dto_mentions(created);
    if mentions.is_empty() {
        return None;
    }
    let Some(channel_seq) = created.get("channel_seq").and_then(Value::as_i64) else {
        return None;
    };
    // Same proactive-send chain assignment as handle_send: inherit the author
    // bot's in-flight chain (multi-hop post_message stays one cancelable chain),
    // else root a new one (§8).
    let chain_id = chain_for_proactive_send(db, channel_id, author_bot_id, msg_id, &mentions).await;
    // spawn：同 handle_done / handle_send，避免下一跳 dispatch 阻塞 connector 读循环。
    Some(spawn_trigger_bot_replies(
        db, fanout, registry, bot_locator, channel_id, msg_id, channel_seq, 0, author_bot_id,
        mentions, chain_id,
    ))
}

/// 从 `MessageDto` JSON 的 `mentions` 数组还原 [`mentions::Mention`]（丢弃无法解析的项）。
fn dto_mentions(created: &Value) -> Vec<mentions::Mention> {
    created
        .get("mentions")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let member_id = m
                        .get("member_id")
                        .and_then(Value::as_str)
                        .and_then(|s| s.parse::<Uuid>().ok())?;
                    let member_type = match m.get("member_type").and_then(Value::as_str) {
                        Some("bot") => mentions::MemberType::Bot,
                        Some("user") => mentions::MemberType::User,
                        _ => return None,
                    };
                    Some(mentions::Mention {
                        member_id,
                        member_type,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn mention_parse_error_to_static(error: mentions::MentionParseError) -> &'static str {
    match error {
        mentions::MentionParseError::Db(_) => "db error",
        mentions::MentionParseError::InvalidMember { .. } => "invalid mention",
        mentions::MentionParseError::NameNotFound { .. } => "mention name not found",
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

fn parse_mention_ids(value: Option<&Value>) -> Vec<Uuid> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().and_then(|s| s.parse().ok()))
                .collect()
        })
        .unwrap_or_default()
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
    if let Some(sid) = resolve_session_id(
        db,
        bot_id,
        provider_account_id,
        frame,
        stream_entry_session_id,
    )
    .await
    {
        if let Err(e) = sessions::touch_session(db, sid).await {
            tracing::warn!(bot_id = %bot_id, err = %e, "session touch failed");
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
    .map_err(crate::gateway::log_db_err(
        "verify_ownership: select message",
    ))?
    .ok_or("message not found")?;

    // owner 必须是当前 bot
    let sender_id: String = row
        .try_get("sender_id")
        .map_err(crate::gateway::log_db_err(
            "verify_ownership: read sender_id column",
        ))?;
    if sender_id != bot_id.to_string() {
        return Err("ownership check failed: msg_id not owned by this bot");
    }

    // 占位必须仍 active
    let is_partial: bool = row.try_get("is_partial").unwrap_or(false);
    let content: String = row.try_get("content").unwrap_or_default();
    if !is_partial && !content.is_empty() {
        return Err("message already finalized");
    }

    let channel_id_str: String = row
        .try_get("channel_id")
        .map_err(crate::gateway::log_db_err(
            "verify_ownership: read channel_id column",
        ))?;
    channel_id_str.parse().map_err(|_| "invalid channel_id")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(msg_id: Uuid) -> StreamEntry {
        StreamEntry {
            msg_id,
            bot_id: Uuid::new_v4(),
            channel_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            session_id: None,
            finalized: false,
            last_touched_ms: Default::default(),
        }
    }

    // ── R9: session-id 解析优先级（纯逻辑，不依赖 DB）─────────────────────────

    /// Source 1: 显式 session_id 存在且与 entry 一致 → 用显式 id。
    #[test]
    fn resolve_explicit_equals_entry_uses_explicit() {
        let bot = Uuid::new_v4();
        let sid = Uuid::new_v4();
        assert_eq!(
            decide_explicit_or_entry(bot, Some(sid), Some(sid)),
            Some(sid)
        );
    }

    /// Source 1 (mismatch): 显式与 entry 不一致 → 用 **entry** id（并告警）。
    #[test]
    fn resolve_explicit_mismatch_prefers_entry() {
        let bot = Uuid::new_v4();
        let explicit = Uuid::new_v4();
        let entry = Uuid::new_v4();
        assert_ne!(explicit, entry);
        assert_eq!(
            decide_explicit_or_entry(bot, Some(explicit), Some(entry)),
            Some(entry),
            "mismatch 必须落到 entry_session_id"
        );
    }

    /// Source 1（仅显式）：只有显式 id、无 entry → 用显式 id。
    #[test]
    fn resolve_explicit_only_uses_explicit() {
        let bot = Uuid::new_v4();
        let explicit = Uuid::new_v4();
        assert_eq!(
            decide_explicit_or_entry(bot, Some(explicit), None),
            Some(explicit)
        );
    }

    /// Source 2: 无显式 id、有 entry → 用 entry id。
    #[test]
    fn resolve_entry_only_uses_entry() {
        let bot = Uuid::new_v4();
        let entry = Uuid::new_v4();
        assert_eq!(
            decide_explicit_or_entry(bot, None, Some(entry)),
            Some(entry)
        );
    }

    /// Sources 1-2 均无 → None（交给 provider_* 的 DB 分支处理）。
    #[test]
    fn resolve_no_explicit_no_entry_is_none() {
        let bot = Uuid::new_v4();
        assert_eq!(decide_explicit_or_entry(bot, None, None), None);
    }

    /// extract_session_id 解析帧里的显式 session_id（喂给 source 1）。
    #[test]
    fn extract_session_id_parses_frame() {
        let sid = Uuid::new_v4();
        let frame = json!({ "session_id": sid.to_string() });
        assert_eq!(extract_session_id(&frame), Some(sid));
        assert_eq!(extract_session_id(&json!({})), None);
    }

    /// R2 / I7：seq 由 Backend 单调盖戳，从 0 起每帧 +1。
    #[test]
    fn next_seq_is_monotonic_from_zero() {
        let reg = StreamRegistry::new();
        let msg = Uuid::new_v4();
        reg.register(entry(msg));
        assert_eq!(reg.next_seq(msg), 0);
        assert_eq!(reg.next_seq(msg), 1);
        assert_eq!(reg.next_seq(msg), 2);
    }

    /// 每条流的 seq 计数器相互独立。
    #[test]
    fn next_seq_is_independent_per_stream() {
        let reg = StreamRegistry::new();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        reg.register(entry(a));
        reg.register(entry(b));
        assert_eq!(reg.next_seq(a), 0);
        assert_eq!(reg.next_seq(a), 1);
        assert_eq!(reg.next_seq(b), 0, "b 的计数器不受 a 影响");
    }

    /// 未注册的流盖戳返回 0（不 panic）。
    #[test]
    fn next_seq_unregistered_returns_zero() {
        let reg = StreamRegistry::new();
        assert_eq!(reg.next_seq(Uuid::new_v4()), 0);
    }

    /// R4：首个 done 认领 finalize，并发迟到的第二个 done 被拒。
    #[test]
    fn claim_finalize_rejects_second_claim() {
        let reg = StreamRegistry::new();
        let msg = Uuid::new_v4();
        reg.register(entry(msg));
        assert_eq!(reg.claim_finalize(msg), FinalizeClaim::Claimed);
        assert_eq!(reg.claim_finalize(msg), FinalizeClaim::AlreadyFinalized);
    }

    /// 未注册的流：finalize 认领返回 NotRegistered（handle_done 据此放行）。
    #[test]
    fn claim_finalize_unregistered_is_not_rejected() {
        let reg = StreamRegistry::new();
        assert_eq!(
            reg.claim_finalize(Uuid::new_v4()),
            FinalizeClaim::NotRegistered
        );
    }
}
