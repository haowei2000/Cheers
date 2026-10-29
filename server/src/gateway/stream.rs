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
use sqlx::PgPool;
use uuid::Uuid;

use super::task_results::{self, TerminalRequest};
pub use super::task_results::{TerminalError, TerminalOutcome};

use crate::{
    domain::{chains, channel_seq, mentions, sessions},
    gateway::{
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
    },
    infra::db::models::{MessageMention, MESSAGE_SCHEMA_VERSION},
    resource::Principal,
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
    /// 触发本轮的消息 id（用户/@bot 消息，或 bot@bot 上一跳）。用于 turn-complete
    /// BotReply APNs；`handle_done` 会 remove entry，调用方须在 done 前 peek。
    pub trigger_msg_id: Uuid,
    /// 任务 session（CheersSession.id）——用于会话生命周期更新
    pub session_id: Option<Uuid>,
    /// 是否已 finalize（R4 守卫：finalize 后拒绝迟到 delta）
    pub finalized: bool,
    /// 上次 touch_session 的时间戳（epoch millis）。每个 delta 都 touch 同一 session
    /// 行会产生写放大，故按 `SESSION_TOUCH_DEBOUNCE_MS` 去抖；首个 delta 仍立即置 busy。
    /// `Arc` 让 StreamEntry 的 Clone 与 DashMap Ref 共享同一计数器。
    pub last_touched_ms: Arc<AtomicU64>,
    /// 上次 R1 在 PG 校验通过的时间（`mono_millis`，0 = 未校验）。窗口内的后续 delta
    /// 以内存 entry 为准，免去每个 delta 一次 PG 往返（该往返串行阻塞 bridge 读循环）；
    /// 窗口过后重新校验，使注册表之外的占位删除（如频道级联删除）在该时限内生效。
    pub ownership_verified: Arc<AtomicU64>,
    /// 终态帧已路由、尚在后台处理：此后到达的 delta 一律拒绝，保证 message_stream
    /// 不会晚于 message_done 广播。
    pub terminal_pending: bool,
    /// 自上次绑定以来是否已发出过点名该流的 delta 拒绝。每次失效只点名一次，
    /// 避免在途的每个未签名 delta 都触发 connector 重签。
    pub delta_rejection_noticed: bool,
    /// 首个签名 delta 通过 capability 校验后建立的流级授权（`delta_capability:
    /// "first_per_stream"`）。同一连接上该流后续未签名 delta 沿用此授权；重连后
    /// 新连接须重新出示签名。done/error 仍逐帧校验。
    pub delta_capability: Option<DeltaCapabilityBinding>,
}

/// 流级 delta 授权：绑定到一条 data 连接与一个 delegation。未签名 delta 消耗预付
/// 次数（按 `max_uses` 在 PG 原子预留），并至少每 `DELTA_CAPABILITY_RECHECK` 在 PG
/// 复核一次 delegation 状态与作用域，使撤销/过期/会话关闭在该时限内生效。
#[derive(Debug, Clone)]
pub struct DeltaCapabilityBinding {
    pub connection_id: Uuid,
    pub delegation_id: Uuid,
    /// 签名首帧的作用域字段指纹（`acp_capability::delta_scope_fingerprint`）。
    /// 未签名 delta 必须与之一致，签名仍钉住该流全部作用域相关字段。
    pub scope: String,
    /// 已在 PG 预付、尚未消耗的 delta 次数。
    pub prepaid: i32,
    /// delegation 设有 `max_uses`：其未用预付须在同 delegation 的下一次用量校验前退还。
    pub limited: bool,
    /// 上次在 PG 复核 delegation 的时间。
    pub checked_at: std::time::Instant,
}

/// 一条流级授权未用掉的预付次数，待退还。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeltaRefund {
    pub delegation_id: Uuid,
    pub unused: i32,
    pub limited: bool,
}

impl DeltaCapabilityBinding {
    fn refund(&self) -> DeltaRefund {
        DeltaRefund {
            delegation_id: self.delegation_id,
            unused: self.prepaid,
            limited: self.limited,
        }
    }
}

/// 流级 delta 授权的最长复核间隔：撤销、过期、会话关闭的生效时限。
pub const DELTA_CAPABILITY_RECHECK: std::time::Duration = std::time::Duration::from_secs(1);

/// 一个未签名 delta 对流级授权的使用结果。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DeltaCapabilityUse {
    /// 未绑定（或不属于本 bot/连接、已 finalize）：须走完整签名校验。
    Unbound,
    /// 已消耗一次预付次数，放行。
    Granted,
    /// 须先在 PG 复核并补充预付：`full` 为复核超时（完整复核），否则仅预付耗尽
    /// （只需补充预付）。
    Recheck {
        delegation_id: Uuid,
        prepaid: i32,
        full: bool,
    },
}

/// 同一 session 行的 touch 去抖窗口（毫秒）。窗口内的 delta 仅损失亚秒级 last_used_at 精度。
const SESSION_TOUCH_DEBOUNCE_MS: u64 = 2000;

/// R1 PG 校验结果的复用窗口（毫秒）。
const OWNERSHIP_RECHECK_MS: u64 = 1000;

/// 进程内单调毫秒（≥1，0 留作“未校验”）。R1 复用窗口与流级授权同用单调时钟，
/// 不受系统时钟调整影响。
fn mono_millis() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
        + 1
}

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
    /// 流在任何路径上结束（cancel、reclaim、finalize、断线）时，其流级授权的未用
    /// 预付送到这里，由 `take_refund_receiver` 的后台任务退还到 PG。
    refund_tx: tokio::sync::mpsc::UnboundedSender<DeltaRefund>,
    refund_rx: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<DeltaRefund>>>,
}

impl StreamRegistry {
    pub fn new() -> Arc<Self> {
        let (refund_tx, refund_rx) = tokio::sync::mpsc::unbounded_channel();
        Arc::new(Self {
            entries: DashMap::new(),
            seq_counters: DashMap::new(),
            refund_tx,
            refund_rx: std::sync::Mutex::new(Some(refund_rx)),
        })
    }

    /// 取出退还队列的接收端（仅一次），交给后台任务把未用预付退还到 PG。
    pub fn take_refund_receiver(
        &self,
    ) -> Option<tokio::sync::mpsc::UnboundedReceiver<DeltaRefund>> {
        self.refund_rx.lock().ok()?.take()
    }

    /// 排队退还一份未用预付（无未用次数时忽略）。
    pub(crate) fn queue_refund(&self, refund: DeltaRefund) {
        if refund.unused > 0 {
            let _ = self.refund_tx.send(refund);
        }
    }

    fn release_dropped_entry(&self, entry: &StreamEntry) {
        if let Some(binding) = entry.delta_capability.as_ref() {
            self.queue_refund(binding.refund());
        }
    }

    /// Dispatcher 创建占位后调用，注册流。
    pub fn register(&self, entry: StreamEntry) {
        let msg_id = entry.msg_id;
        self.entries.insert(msg_id, entry);
        self.seq_counters.insert(msg_id, AtomicU64::new(0));
    }

    /// Recover the same offered turn without resetting a live stream's sequence
    /// or replacing another task. The caller holds its message/run state locks.
    pub fn register_if_absent(&self, entry: StreamEntry) -> Result<bool, &'static str> {
        match self.entries.entry(entry.msg_id) {
            dashmap::mapref::entry::Entry::Occupied(current) => {
                let current = current.get();
                if current.task_id == entry.task_id
                    && current.bot_id == entry.bot_id
                    && current.channel_id == entry.channel_id
                {
                    Ok(false)
                } else {
                    Err("another task owns this stream")
                }
            }
            dashmap::mapref::entry::Entry::Vacant(slot) => {
                self.seq_counters.insert(entry.msg_id, AtomicU64::new(0));
                slot.insert(entry);
                Ok(true)
            }
        }
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
    pub(crate) fn claim_finalize(
        &self,
        msg_id: Uuid,
    ) -> Result<Option<FinalizeGuard<'_>>, &'static str> {
        match self.entries.get_mut(&msg_id) {
            None => Ok(None),
            Some(mut entry) => {
                if entry.finalized {
                    Err("already finalized")
                } else {
                    entry.finalized = true;
                    Ok(Some(FinalizeGuard {
                        registry: self,
                        msg_id,
                        task_id: entry.task_id,
                        committed: false,
                    }))
                }
            }
        }
    }

    /// 签名 delta 校验通过后，把该流的 delta 授权绑定到当前 data 连接、delegation 与
    /// 作用域指纹。仅限流的属主 bot 且未 finalize。返回被替换绑定的未用预付，由调用方退还。
    pub(crate) fn bind_delta_capability(
        &self,
        msg_id: Uuid,
        bot_id: Uuid,
        connection_id: Uuid,
        delegation_id: Uuid,
        scope: String,
    ) -> Option<DeltaRefund> {
        let mut entry = self.entries.get_mut(&msg_id)?;
        if entry.bot_id != bot_id || entry.finalized || entry.terminal_pending {
            return None;
        }
        entry.delta_rejection_noticed = false;
        entry
            .delta_capability
            .replace(DeltaCapabilityBinding {
                connection_id,
                delegation_id,
                scope,
                prepaid: 0,
                limited: false,
                checked_at: std::time::Instant::now(),
            })
            .map(|old| old.refund())
    }

    /// 一个未签名 delta 尝试使用该流在此 bot 这条连接上的授权；`scope` 须与签名首帧一致。
    pub(crate) fn use_delta_capability(
        &self,
        msg_id: Uuid,
        bot_id: Uuid,
        connection_id: Uuid,
        scope: &str,
    ) -> DeltaCapabilityUse {
        let Some(mut entry) = self.entries.get_mut(&msg_id) else {
            return DeltaCapabilityUse::Unbound;
        };
        if entry.bot_id != bot_id || entry.finalized || entry.terminal_pending {
            return DeltaCapabilityUse::Unbound;
        }
        match entry.delta_capability.as_mut() {
            Some(binding) if binding.connection_id == connection_id && binding.scope == scope => {
                let fresh = binding.checked_at.elapsed() < DELTA_CAPABILITY_RECHECK;
                if fresh && binding.prepaid > 0 {
                    binding.prepaid -= 1;
                    DeltaCapabilityUse::Granted
                } else {
                    DeltaCapabilityUse::Recheck {
                        delegation_id: binding.delegation_id,
                        prepaid: binding.prepaid,
                        full: !fresh,
                    }
                }
            }
            _ => DeltaCapabilityUse::Unbound,
        }
    }

    /// PG 复核通过后记入新预付并消耗一次；`full` 复核会重置复核时间。失败（绑定已失效
    /// 或预付耗尽）时清除绑定，返回 `Err(未用预付)` 由调用方退还。
    pub(crate) fn finish_delta_recheck(
        &self,
        msg_id: Uuid,
        bot_id: Uuid,
        connection_id: Uuid,
        delegation_id: Uuid,
        grant: crate::domain::acp_capability::DeltaGrant,
        full: bool,
    ) -> Result<(), DeltaRefund> {
        let orphan = DeltaRefund {
            delegation_id,
            unused: grant.granted,
            limited: grant.limited,
        };
        let Some(mut entry) = self.entries.get_mut(&msg_id) else {
            return Err(orphan);
        };
        if entry.bot_id != bot_id || entry.finalized || entry.terminal_pending {
            return Err(orphan);
        }
        let Some(binding) = entry.delta_capability.as_mut().filter(|binding| {
            binding.connection_id == connection_id && binding.delegation_id == delegation_id
        }) else {
            return Err(orphan);
        };
        binding.prepaid += grant.granted;
        binding.limited |= grant.limited;
        if full {
            binding.checked_at = std::time::Instant::now();
        }
        if binding.prepaid > 0 {
            binding.prepaid -= 1;
            Ok(())
        } else {
            let refund = binding.refund();
            entry.delta_capability = None;
            Err(refund)
        }
    }

    /// 移除该流在此 bot 这条连接上的授权（流结束或复核失败），返回未用预付。
    pub(crate) fn take_delta_capability(
        &self,
        msg_id: Uuid,
        bot_id: Uuid,
        connection_id: Uuid,
    ) -> Option<DeltaRefund> {
        let mut entry = self.entries.get_mut(&msg_id)?;
        if entry.bot_id != bot_id || entry.delta_capability.as_ref()?.connection_id != connection_id
        {
            return None;
        }
        entry
            .delta_capability
            .take()
            .map(|binding| binding.refund())
    }

    /// data 连接断开：移除该连接上的全部流级授权，返回各自未用预付。
    pub(crate) fn take_delta_capabilities_on(
        &self,
        bot_id: Uuid,
        connection_id: Uuid,
    ) -> Vec<DeltaRefund> {
        let mut refunds = Vec::new();
        for mut entry in self.entries.iter_mut() {
            if entry.bot_id != bot_id {
                continue;
            }
            let on_connection = entry
                .delta_capability
                .as_ref()
                .is_some_and(|binding| binding.connection_id == connection_id);
            if on_connection {
                if let Some(binding) = entry.delta_capability.take() {
                    refunds.push(binding.refund());
                }
            }
        }
        refunds
    }

    /// 是否应为该流发出点名拒绝：自上次绑定以来只点名一次。未注册的流总是点名。
    pub(crate) fn note_delta_rejection(&self, msg_id: Uuid, bot_id: Uuid) -> bool {
        match self.entries.get_mut(&msg_id) {
            Some(mut entry) if entry.bot_id == bot_id => {
                !std::mem::replace(&mut entry.delta_rejection_noticed, true)
            }
            _ => true,
        }
    }

    /// 终态帧已被路由：在其后台处理期间拒绝该流后续 delta。
    pub(crate) fn begin_terminal(&self, msg_id: Uuid, bot_id: Uuid) {
        if let Some(mut entry) = self.entries.get_mut(&msg_id) {
            if entry.bot_id == bot_id {
                entry.terminal_pending = true;
            }
        }
    }

    /// 终态帧处理结束（无论提交与否）。提交成功时 entry 已被移除。
    pub(crate) fn end_terminal(&self, msg_id: Uuid, bot_id: Uuid) {
        if let Some(mut entry) = self.entries.get_mut(&msg_id) {
            if entry.bot_id == bot_id {
                entry.terminal_pending = false;
            }
        }
    }

    /// 清理注册表（done 帧到达后调用）。
    pub fn remove(&self, msg_id: Uuid) {
        if let Some((_, entry)) = self.entries.remove(&msg_id) {
            self.release_dropped_entry(&entry);
        }
        self.seq_counters.remove(&msg_id);
    }

    pub(crate) fn remove_task(&self, msg_id: Uuid, task_id: Uuid) {
        if let dashmap::mapref::entry::Entry::Occupied(entry) = self.entries.entry(msg_id) {
            if entry.get().task_id == task_id {
                self.seq_counters.remove(&msg_id);
                let entry = entry.remove();
                self.release_dropped_entry(&entry);
            }
        }
    }

    /// Peek the trigger message id for an active stream. Call **before**
    /// `handle_done` (which removes the entry) when wiring turn-complete pushes.
    pub fn trigger_msg_id(&self, msg_id: Uuid) -> Option<Uuid> {
        self.entries.get(&msg_id).map(|e| e.trigger_msg_id)
    }

    /// 是否存在该 msg_id 的存活流（孤儿回收器据此跳过正在流式的占位）。
    pub fn contains(&self, msg_id: Uuid) -> bool {
        self.entries.contains_key(&msg_id)
    }

    /// The channels this bot currently has a turn running in, de-duplicated.
    ///
    /// A bot works in many channels at once, so this is a set, not one value.
    /// Finalized entries are excluded: their turn has produced its terminal
    /// frame and only awaits cleanup, so anything still calling in is no longer
    /// "inside" that turn.
    ///
    /// **Process-local.** On a multi-replica gateway the stream lives on the
    /// replica holding the bot's WS, which need not be the one serving an MCP
    /// request. An empty result therefore means "no in-flight turn *here*", not
    /// "no in-flight turn" — which is why this feeds measurement and never an
    /// authorization decision (that binding belongs in the access token).
    pub fn active_channels(&self, bot_id: Uuid) -> Vec<Uuid> {
        let mut channels: Vec<Uuid> = self
            .entries
            .iter()
            .filter(|entry| entry.bot_id == bot_id && !entry.finalized)
            .map(|entry| entry.channel_id)
            .collect();
        channels.sort_unstable();
        channels.dedup();
        channels
    }
}

/// A memory claim fences concurrent terminal/delta frames only while the DB
/// transaction is pending. Failure or cancellation releases it; PostgreSQL's
/// conditional partial-row update remains the durable completion authority.
pub(crate) struct FinalizeGuard<'a> {
    registry: &'a StreamRegistry,
    msg_id: Uuid,
    task_id: Uuid,
    committed: bool,
}

impl FinalizeGuard<'_> {
    /// Remove only the task this claim fenced. Holding the entry lock through
    /// counter cleanup prevents a replacement task's sequence from being erased.
    pub(crate) fn remove(mut self) {
        self.registry.remove_task(self.msg_id, self.task_id);
        self.committed = true;
    }
}

impl Drop for FinalizeGuard<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Some(mut entry) = self.registry.entries.get_mut(&self.msg_id) {
            // Removal/replacement can happen while the transaction awaits IO.
            // A failed old task must never reopen a newer task's claim.
            if entry.task_id == self.task_id {
                entry.finalized = false;
            }
        }
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

    // 复制所需字段后立即释放 DashMap 分片读锁——不得跨 .await 持有守卫，否则并发写者
    // （register / claim_finalize / remove）会在 DB 往返期间被同步阻塞其 worker 线程。
    let (session_id, last_touched_ms, entry_bot_id, entry_channel_id, ownership_verified) = {
        let entry = registry
            .entries
            .get(&msg_id)
            .ok_or("stream not registered")?;
        (
            entry.session_id,
            entry.last_touched_ms.clone(),
            entry.bot_id,
            entry.channel_id,
            entry.ownership_verified.clone(),
        )
    };
    if entry_bot_id != bot_id {
        return Err("ownership check failed: msg_id not owned by this bot");
    }

    // touch 去抖：首个 delta 立即置 busy；窗口内的后续 delta 跳过 session 行 UPDATE，
    // 仅损失亚秒级 last_used_at 精度。compare_exchange 防止并发帧重复 touch。
    let now = now_millis();
    let prev = last_touched_ms.load(Ordering::Relaxed);
    let should_touch = now.saturating_sub(prev) >= SESSION_TOUCH_DEBOUNCE_MS
        && last_touched_ms
            .compare_exchange(prev, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok();

    // R1 所有权校验与（偶发的）session touch 并发执行——两者互不依赖，省去一次串行往返。
    // 窗口内已校验的流跳过 PG 查询，直接使用注册时的 channel_id。
    let mono = mono_millis();
    let verified_at = ownership_verified.load(Ordering::Acquire);
    let verified = verified_at != 0 && mono.saturating_sub(verified_at) < OWNERSHIP_RECHECK_MS;
    let (owner, _) = tokio::join!(
        async {
            if verified {
                Ok(entry_channel_id)
            } else {
                verify_ownership(db, bot_id, msg_id).await
            }
        },
        async {
            if should_touch {
                mark_session_alive(db, bot_id, provider_account_id, frame, session_id).await;
            }
        }
    );
    let channel_id = owner?;
    if !verified && channel_id == entry_channel_id {
        ownership_verified.store(mono, Ordering::Release);
    }

    // R4: finalize 守卫——.await 后重新读取（done 已 remove entry 视同 gone）。
    match registry
        .entries
        .get(&msg_id)
        .map(|e| e.finalized || e.terminal_pending)
    {
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
        // A browser can subscribe after the placeholder broadcast but before the
        // first delta. Carry enough identity to construct a complete temporary
        // Message until the durable done frame arrives.
        json!({
            "msg_id": msg_id,
            "sender_id": bot_id,
            "sender_type": "bot",
            "delta": delta,
        }),
    );
    fanout.broadcast_channel(channel_id, wire).await;

    Ok(())
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
    frame: &Value,
) -> Result<TerminalOutcome, TerminalError> {
    let request = TerminalRequest::parse(frame)?;
    if let Some(outcome) = task_results::replay(db, bot_id, frame).await? {
        return Ok(outcome);
    }
    let msg_id = request.msg_id;
    let content = if frame.get("type").and_then(Value::as_str) == Some("error") {
        frame
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("connector reported an error")
    } else {
        frame.get("content").and_then(Value::as_str).unwrap_or("")
    };
    let done_file_ids = parse_file_ids(frame.get("file_ids"));
    let mention_ids = parse_mention_ids(frame.get("mention_ids"));

    // Routing comes from the required grant and is checked against the locked
    // message and run before any result is committed.
    let execution = &request.execution;
    let channel_id = execution.channel_id;
    // A result may only attach files this bot delivered to this channel, the
    // same rule a bot `send` follows.
    if !done_file_ids.is_empty() {
        crate::domain::messages::validate_file_ids(db, bot_id, channel_id, &done_file_ids)
            .await
            .map_err(|error| match error {
                crate::errors::AppError::Db(error) => {
                    TerminalError::database("validate terminal file_ids")(error)
                }
                _ => TerminalError::rejected(
                    "TERMINAL_FORBIDDEN",
                    "file_ids must be files this bot delivered to the channel",
                ),
            })?;
    }
    let done_file_ids = (!done_file_ids.is_empty()).then_some(serde_json::json!(done_file_ids));
    let mentions = mentions::validate_mention_ids(db, channel_id, &mention_ids)
        .await
        .map_err(|error| match error {
            mentions::MentionParseError::Db(error) => {
                TerminalError::database("validate terminal mentions")(error)
            }
            other => {
                TerminalError::rejected("TERMINAL_FORBIDDEN", mention_parse_error_to_static(other))
            }
        })?;

    // Readiness is an admission snapshot, as on human sends. Never retain a
    // database transaction while consulting a locator. Once a ready target is
    // committed below, a subsequent disconnect cannot lose its dispatch intent.
    let mut ready_targets = Vec::new();
    if frame.get("type").and_then(Value::as_str) == Some("done") {
        for mention in &mentions {
            if mention.member_type == mentions::MemberType::Bot
                && mention.member_id != bot_id
                && bot_locator.is_online(mention.member_id).await
                && bot_locator
                    .supports_task_acceptance(mention.member_id)
                    .await
            {
                ready_targets.push(mention.member_id);
            }
        }
    }

    // R4: 标记 finalize（先在内存里标记，防止并发 delta 继续写入）
    let finalize_guard = match registry.claim_finalize(msg_id) {
        Ok(guard) => guard,
        Err(_) => {
            if let Some(outcome) = task_results::replay(db, bot_id, frame).await? {
                return Ok(outcome);
            }
            return Err(TerminalError::busy());
        }
    };

    // ── 先落库（写后投递原则）────────────────────────────────────────────────
    let mut tx = db
        .begin()
        .await
        .map_err(TerminalError::database("stream.done: begin tx"))?;
    let channel_seq = channel_seq::allocate(&mut tx, channel_id)
        .await
        .map_err(TerminalError::database("stream.done: allocate channel_seq"))?;
    let message = sqlx::query!(
        "SELECT channel_id,sender_id,sender_type,is_partial,is_deleted,channel_seq,chain_id,content_data
         FROM messages WHERE msg_id = $1 FOR UPDATE",
        msg_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(TerminalError::database(
        "stream.done: lock message",
    ))?;
    let run = task_results::lock_run(&mut tx, &request).await?;
    if let Some(outcome) = run.validate(bot_id, &request)? {
        // Drop rolls back the provisional sequence allocation. A replay
        // never repeats message writes, session changes or completion effects.
        return Ok(outcome);
    }
    let message = message
        .ok_or_else(|| TerminalError::rejected("TERMINAL_GONE", "message no longer exists"))?;
    if message.sender_id != bot_id.to_string()
        || message.sender_type != "bot"
        || message.channel_id != channel_id.to_string()
    {
        return Err(TerminalError::rejected(
            "TERMINAL_FORBIDDEN",
            "message does not belong to this bot and channel",
        ));
    }
    if message.is_deleted {
        return Err(TerminalError::rejected(
            "TERMINAL_GONE",
            "message was deleted",
        ));
    }
    if !message.is_partial || message.channel_seq.is_some() {
        return Err(TerminalError::rejected(
            "TERMINAL_CONFLICT",
            "message was finalized without this receipt",
        ));
    }
    if !super::task_acceptance::may_execute(
        &mut tx,
        bot_id,
        channel_id,
        message.chain_id.as_deref(),
    )
    .await
    .map_err(TerminalError::database("authorize terminal result"))?
    {
        return Err(TerminalError::rejected(
            "TERMINAL_FORBIDDEN",
            "bot may no longer publish this result",
        ));
    }
    let stored_id = |key: &str| {
        message
            .content_data
            .as_ref()
            .and_then(|data| data.get(key))
            .map(|value| {
                value
                    .as_str()
                    .and_then(|id| id.parse::<Uuid>().ok())
                    .ok_or_else(|| {
                        TerminalError::rejected(
                            "TERMINAL_FORBIDDEN",
                            "stored terminal session or claim identity is invalid",
                        )
                    })
            })
            .transpose()
    };
    let session_id = stored_id("session_id")?;
    let task_claim_id = stored_id("task_claim_id")?;
    let claim_update = task_results::complete(&mut tx, &request, bot_id, task_claim_id).await?;
    if let Some(data) = message.content_data {
        let finalized =
            crate::resource::messages::finalize_card_metadata(data, !content.trim().is_empty());
        sqlx::query!(
            "UPDATE messages SET content_data = $2 WHERE msg_id = $1",
            msg_id.to_string(),
            finalized,
        )
        .execute(&mut *tx)
        .await
        .map_err(TerminalError::database(
            "stream.done: publish card metadata",
        ))?;
    }
    let details = sqlx::query!(
        "UPDATE messages
         SET channel_seq = $1,
             content = $2,
             is_partial = FALSE,
             file_ids = COALESCE($3::jsonb, file_ids)
         WHERE msg_id = $4 AND is_partial = TRUE AND channel_seq IS NULL
         RETURNING channel_id, channel_seq, depth, file_ids, msg_type,
                   in_reply_to_msg_id AS reply_to_msg_id, chain_id, context_bundle, content_data",
        channel_seq,
        content,
        done_file_ids,
        msg_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(TerminalError::database(
        "stream.done: finalize message update",
    ))?
    .ok_or_else(|| TerminalError::rejected("TERMINAL_GONE", "message no longer exists"))?;
    mentions::replace_batch(&mut tx, msg_id, &mentions)
        .await
        .map_err(TerminalError::database("stream.done: replace mentions"))?;
    if let Some(session_id) = session_id {
        sessions::finalize_session_without_active_turns_tx(&mut tx, session_id)
            .await
            .map_err(|error| match error {
                crate::errors::AppError::Db(error) => {
                    TerminalError::database("stream.done: finalize session")(error)
                }
                other => {
                    tracing::error!(%other, "terminal session finalization failed");
                    TerminalError {
                        code: "INTERNAL_ERROR",
                        detail: "terminal session finalization failed",
                        retryable: true,
                    }
                }
            })?;
    }
    let child_count = if frame.get("type").and_then(Value::as_str) == Some("done") {
        chains::enqueue_terminal_children(
            &mut tx,
            channel_id,
            msg_id,
            channel_seq,
            details.depth,
            bot_id,
            &mentions,
            details.chain_id.as_deref(),
            execution.task_id,
            execution.execution_id,
            &ready_targets,
        )
        .await
        .map_err(|error| match error {
            crate::errors::AppError::Db(error) => {
                TerminalError::database("stream.done: enqueue child intents")(error)
            }
            other => {
                tracing::error!(%other, "terminal child admission failed");
                TerminalError {
                    code: "INTERNAL_ERROR",
                    detail: "terminal child admission failed",
                    retryable: true,
                }
            }
        })?
    } else {
        0
    };
    tx.commit()
        .await
        .map_err(TerminalError::database("stream.done: commit tx"))?;
    if let Some(guard) = finalize_guard {
        guard.remove();
    }

    let channel_id = details
        .channel_id
        .clone()
        .parse()
        .map_err(|_| TerminalError::rejected("INTERNAL_ERROR", "invalid channel_id"))?;
    let channel_seq = details
        .channel_seq
        .clone()
        .ok_or_else(|| sqlx::Error::Decode(Box::new(sqlx::error::UnexpectedNullError)))
        .map_err(TerminalError::database(
            "stream.done: read channel_seq column",
        ))?;
    let file_ids: Vec<String> =
        serde_json::from_value(details.file_ids.clone().unwrap_or(serde_json::Value::Null))
            .unwrap_or_default();
    let msg_type = details.msg_type.clone();
    let reply_to_msg_id = details.reply_to_msg_id.clone();

    // Resolve attachment metadata, including the status of retired historical
    // records, so the live frame can render unavailable attachments explicitly.
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
            // session_id (and any other bot-turn metadata) stamped at placeholder
            // create — keep it on finalize so Reply can reuse session/model.
            "content_data": details.content_data.clone(),
            // Preserve the F2 handoff card on the finalized bot message (round-trips
            // via the DTO too; here it keeps the card without a history refetch).
            "context_bundle": details.context_bundle.clone(),
        }),
    );
    fanout.broadcast_channel(channel_id, wire).await;
    if let Some(update) = claim_update {
        super::resource_effects::publish_claim_update(fanout.as_ref(), &update).await;
    }

    if child_count != 0 {
        let (db, fanout, registry, locator) = (
            db.clone(),
            fanout.clone(),
            registry.clone(),
            bot_locator.clone(),
        );
        tokio::spawn(async move {
            if let Err(error) =
                super::dispatch_intents::deliver_trigger(&db, &fanout, &registry, &locator, msg_id)
                    .await
            {
                tracing::warn!(%msg_id, %error, "child dispatch intents retained for recovery");
            }
        });
    }

    Ok(TerminalOutcome::Committed)
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

/// Resolve which session_id a delta frame refers to, by the 4-source
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

/// The durable write disposition controls postcommit notifications as well as
/// publication; a replay still acknowledges the original message identity.
#[derive(Debug)]
pub struct SendOutcome {
    pub msg_id: Uuid,
    pub replayed: bool,
}

/// Normalize a proactive send into the shared bot-message creation command.
pub async fn handle_send(
    registry: &Arc<StreamRegistry>,
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    bot_id: Uuid,
    frame: &Value,
) -> Result<SendOutcome, &'static str> {
    // Transport aliases normalize before the shared command hashes or validates
    // input. Capability envelopes and delivery nonces never enter a write key.
    let mut params = json!({
        "channel_id": frame.get("channel_id"),
        "content": frame.get("content").or_else(|| frame.get("text")).and_then(Value::as_str).unwrap_or(""),
        "msg_type": frame.get("msg_type").and_then(Value::as_str).unwrap_or("text"),
    });
    for key in ["file_ids", "mention_ids"] {
        if let Some(value) = frame.get(key) {
            params[key] = value.clone();
        }
    }
    if let Some(reply) = frame.get("in_reply_to_msg_id") {
        params["reply_to_msg_id"] = reply.clone();
    }
    if let Some(client_id) = frame
        .get("client_msg_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        params["idempotency_key"] = json!(format!("bridge.send:{client_id}"));
    }
    let created =
        crate::resource::messages::handle_create(db, &Principal::bot(bot_id), &params, bot_locator)
            .await
            .map_err(|(code, detail)| {
                tracing::warn!(%bot_id, %code, %detail, "bot message command rejected");
                match code.as_str() {
                    "INTERNAL_ERROR" => "db error",
                    "NOT_MEMBER" | "PERMISSION_DENIED" => {
                        "bot is not allowed to write to the target channel"
                    }
                    "MEMBER_NOT_FOUND" => "invalid mention",
                    "E_IDEMPOTENCY_KEY_REUSED" => {
                        "client_msg_id was reused for a different message"
                    }
                    _ => "invalid message",
                }
            })?;
    let msg_id = created
        .get("msg_id")
        .and_then(Value::as_str)
        .and_then(|id| id.parse().ok())
        .ok_or("invalid created message")?;
    let _ = broadcast_created_message(registry, fanout, db, bot_locator, &created).await;
    Ok(SendOutcome {
        msg_id,
        replayed: created
            .get(crate::resource::idempotency::REPLAY_FLAG)
            .and_then(Value::as_bool)
            == Some(true),
    })
}

/// Publish a committed bot message, then accelerate delivery of intents already
/// admitted by its write transaction. Cancellation here cannot lose child work.
/// A receipt replay never repeats publication or creates dispatch decisions.
pub async fn broadcast_created_message(
    registry: &Arc<StreamRegistry>,
    fanout: &Arc<dyn Fanout>,
    db: &PgPool,
    bot_locator: &Arc<dyn BotLocator>,
    created: &Value,
) -> Option<tokio::task::JoinHandle<()>> {
    if created
        .get(crate::resource::idempotency::REPLAY_FLAG)
        .and_then(Value::as_bool)
        == Some(true)
    {
        return None;
    }
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
    fanout
        .broadcast_channel(
            channel_id,
            WireFrame::channel(channel_id, "message", created.clone()),
        )
        .await;
    let (db, fanout, registry, locator) = (
        db.clone(),
        fanout.clone(),
        registry.clone(),
        bot_locator.clone(),
    );
    Some(tokio::spawn(async move {
        if let Err(error) =
            super::dispatch_intents::deliver_trigger(&db, &fanout, &registry, &locator, msg_id)
                .await
        {
            tracing::warn!(%msg_id, %error, "bot message dispatch intents retained for recovery");
        }
    }))
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
    let row = sqlx::query!(
        "SELECT channel_id, sender_id, is_partial, content
         FROM messages WHERE msg_id = $1",
        msg_id.to_string(),
    )
    .fetch_optional(db)
    .await
    .map_err(crate::gateway::log_db_err(
        "verify_ownership: select message",
    ))?
    .ok_or("message not found")?;

    // owner 必须是当前 bot
    let sender_id: String = row.sender_id.clone();
    if sender_id != bot_id.to_string() {
        return Err("ownership check failed: msg_id not owned by this bot");
    }

    // 占位必须仍 active
    let is_partial: bool = row.is_partial.clone();
    let content: String = row.content.clone();
    if !is_partial && !content.is_empty() {
        return Err("message already finalized");
    }

    let channel_id_str: String = row.channel_id.clone();
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
            trigger_msg_id: Uuid::new_v4(),
            session_id: None,
            finalized: false,
            last_touched_ms: Default::default(),
            ownership_verified: Default::default(),
            delta_capability: None,
            terminal_pending: false,
            delta_rejection_noticed: false,
        }
    }

    fn grant(granted: i32, limited: bool) -> crate::domain::acp_capability::DeltaGrant {
        crate::domain::acp_capability::DeltaGrant { granted, limited }
    }

    /// 注册一条流并以 `scope` 绑定 delta 授权，返回 (registry, msg, bot, conn, delegation)。
    fn bound_stream(scope: &str) -> (Arc<StreamRegistry>, Uuid, Uuid, Uuid, Uuid) {
        let registry = StreamRegistry::new();
        let msg_id = Uuid::new_v4();
        let e = entry(msg_id);
        let bot = e.bot_id;
        registry.register(e);
        let conn = Uuid::new_v4();
        let delegation = Uuid::new_v4();
        registry.bind_delta_capability(msg_id, bot, conn, delegation, scope.to_string());
        (registry, msg_id, bot, conn, delegation)
    }

    /// delta 授权只绑定到属主 bot 的同一条 data 连接与同一作用域，finalize 后失效。
    #[test]
    fn delta_capability_binds_to_owner_connection_and_scope_only() {
        let registry = StreamRegistry::new();
        let msg_id = Uuid::new_v4();
        let e = entry(msg_id);
        let bot = e.bot_id;
        registry.register(e);
        let conn = Uuid::new_v4();
        let delegation = Uuid::new_v4();

        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound
        );
        assert!(registry
            .bind_delta_capability(msg_id, Uuid::new_v4(), conn, delegation, "s".into())
            .is_none());
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound,
            "another bot cannot bind the stream"
        );
        registry.bind_delta_capability(msg_id, bot, conn, delegation, "s".into());
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, Uuid::new_v4(), "s"),
            DeltaCapabilityUse::Unbound,
            "another connection does not inherit the binding"
        );
        assert_eq!(
            registry.use_delta_capability(msg_id, Uuid::new_v4(), conn, "s"),
            DeltaCapabilityUse::Unbound
        );
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "other"),
            DeltaCapabilityUse::Unbound,
            "an unsigned Delta cannot change the signed scope fields"
        );

        let guard = registry.claim_finalize(msg_id).unwrap().unwrap();
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound,
            "a finalizing stream accepts no unsigned Delta"
        );
        guard.remove();
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound
        );
    }

    /// 预付耗尽时只补充预付；复核超时才完整复核；预付不足即解除绑定。
    #[test]
    fn delta_capability_spends_prepaid_uses_and_rechecks() {
        let (registry, msg_id, bot, conn, delegation) = bound_stream("s");
        let top_up = DeltaCapabilityUse::Recheck {
            delegation_id: delegation,
            prepaid: 0,
            full: false,
        };
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            top_up,
            "a fresh binding only needs prepaid uses"
        );
        assert_eq!(
            registry.finish_delta_recheck(msg_id, bot, conn, delegation, grant(2, true), false),
            Ok(())
        );
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Granted
        );
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            top_up
        );

        registry
            .finish_delta_recheck(msg_id, bot, conn, delegation, grant(3, true), false)
            .unwrap();
        registry
            .entries
            .get_mut(&msg_id)
            .unwrap()
            .delta_capability
            .as_mut()
            .unwrap()
            .checked_at -= DELTA_CAPABILITY_RECHECK;
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Recheck {
                delegation_id: delegation,
                prepaid: 2,
                full: true,
            },
            "a stale binding is fully re-checked even with prepaid uses left"
        );
        assert_eq!(
            registry.take_delta_capability(msg_id, bot, conn),
            Some(DeltaRefund {
                delegation_id: delegation,
                unused: 2,
                limited: true,
            }),
            "unused prepaid uses are returned for refund"
        );

        registry.bind_delta_capability(msg_id, bot, conn, delegation, "s".into());
        assert_eq!(
            registry
                .finish_delta_recheck(msg_id, bot, conn, delegation, grant(0, true), false)
                .map_err(|refund| refund.unused),
            Err(0),
            "an exhausted delegation unbinds the stream"
        );
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound
        );

        registry.bind_delta_capability(msg_id, bot, conn, delegation, "s".into());
        assert_eq!(
            registry
                .finish_delta_recheck(msg_id, bot, conn, Uuid::new_v4(), grant(4, false), false)
                .map_err(|refund| refund.unused),
            Err(4),
            "a grant for a replaced delegation is refunded"
        );
        registry
            .finish_delta_recheck(msg_id, bot, conn, delegation, grant(5, false), false)
            .unwrap();
        assert_eq!(
            registry.take_delta_capabilities_on(bot, conn),
            vec![DeltaRefund {
                delegation_id: delegation,
                unused: 4,
                limited: false,
            }]
        );
        assert!(registry.take_delta_capabilities_on(bot, conn).is_empty());
    }

    /// 无论流经哪条路径被移除（cancel/reclaim 的 remove_task、finalize、remove），
    /// 其未用预付都进入退还队列。
    #[test]
    fn every_stream_removal_queues_its_prepaid_refund() {
        let refunds_for = |remove: &dyn Fn(&StreamRegistry, Uuid, Uuid)| {
            let (registry, msg_id, bot, conn, delegation) = bound_stream("s");
            let mut rx = registry.take_refund_receiver().unwrap();
            registry
                .finish_delta_recheck(msg_id, bot, conn, delegation, grant(9, true), false)
                .unwrap();
            let task_id = registry.entries.get(&msg_id).unwrap().task_id;
            remove(&registry, msg_id, task_id);
            assert!(!registry.contains(msg_id));
            let refund = rx.try_recv().expect("refund queued");
            assert_eq!((refund.delegation_id, refund.unused), (delegation, 8));
        };
        refunds_for(&|registry, msg_id, task_id| registry.remove_task(msg_id, task_id));
        refunds_for(&|registry, msg_id, _| registry.remove(msg_id));
        refunds_for(&|registry, msg_id, _| {
            registry.claim_finalize(msg_id).unwrap().unwrap().remove()
        });
    }

    /// 每次失效只点名一次；重新绑定后可再次点名。
    #[test]
    fn a_lapsed_stream_is_named_once_until_rebound() {
        let (registry, msg_id, bot, conn, delegation) = bound_stream("s");
        assert!(registry.note_delta_rejection(msg_id, bot));
        assert!(!registry.note_delta_rejection(msg_id, bot));
        assert!(!registry.note_delta_rejection(msg_id, bot));
        registry.bind_delta_capability(msg_id, bot, conn, delegation, "s".into());
        assert!(registry.note_delta_rejection(msg_id, bot));
        assert!(
            registry.note_delta_rejection(Uuid::new_v4(), bot),
            "an unregistered stream is always named"
        );
    }

    /// 终态帧路由后、处理结束前，该流不再接受 delta 授权或新绑定。
    #[test]
    fn a_routed_terminal_fences_its_stream() {
        let (registry, msg_id, bot, conn, delegation) = bound_stream("s");
        registry.begin_terminal(msg_id, Uuid::new_v4());
        assert_ne!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound,
            "another bot cannot fence the stream"
        );
        registry.begin_terminal(msg_id, bot);
        assert_eq!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound
        );
        assert!(registry
            .bind_delta_capability(msg_id, bot, conn, delegation, "s".into())
            .is_none());
        registry.end_terminal(msg_id, bot);
        assert_ne!(
            registry.use_delta_capability(msg_id, bot, conn, "s"),
            DeltaCapabilityUse::Unbound
        );
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
        let _guard = reg.claim_finalize(msg).unwrap().unwrap();
        assert!(matches!(reg.claim_finalize(msg), Err("already finalized")));
    }

    /// 未注册的流：finalize 认领返回 NotRegistered（handle_done 据此放行）。
    #[test]
    fn claim_finalize_unregistered_is_not_rejected() {
        let reg = StreamRegistry::new();
        assert!(reg.claim_finalize(Uuid::new_v4()).unwrap().is_none());
    }

    #[test]
    fn recovering_the_same_stream_preserves_sequence_and_finalize_claim() {
        let registry = StreamRegistry::new();
        let original = entry(Uuid::new_v4());
        assert!(registry.register_if_absent(original.clone()).unwrap());
        assert_eq!(registry.next_seq(original.msg_id), 0);
        assert!(!registry.register_if_absent(original.clone()).unwrap());
        assert_eq!(registry.next_seq(original.msg_id), 1);
        let _claim = registry.claim_finalize(original.msg_id).unwrap();
        assert!(!registry.register_if_absent(original.clone()).unwrap());
        assert!(registry.claim_finalize(original.msg_id).is_err());
        let mut another = original;
        another.task_id = Uuid::new_v4();
        assert!(registry.register_if_absent(another).is_err());
    }

    #[test]
    fn abandoned_finalize_claim_can_be_retried() {
        let reg = StreamRegistry::new();
        let msg = Uuid::new_v4();
        reg.register(entry(msg));
        drop(reg.claim_finalize(msg).unwrap());
        assert!(reg.claim_finalize(msg).unwrap().is_some());
    }

    #[test]
    fn finished_finalize_claim_removes_its_registry_state() {
        let reg = StreamRegistry::new();
        let msg = Uuid::new_v4();
        reg.register(entry(msg));
        reg.claim_finalize(msg).unwrap().unwrap().remove();
        assert!(!reg.contains(msg));
        assert!(reg.claim_finalize(msg).unwrap().is_none());
    }

    #[test]
    fn abandoned_old_claim_cannot_reopen_a_replacement_task() {
        let reg = StreamRegistry::new();
        let msg = Uuid::new_v4();
        reg.register(entry(msg));
        let old = reg.claim_finalize(msg).unwrap();
        reg.remove(msg);
        reg.register(entry(msg));
        let _current = reg.claim_finalize(msg).unwrap();
        drop(old);
        assert!(matches!(reg.claim_finalize(msg), Err("already finalized")));
    }

    // ── active_channels：一个 bot 同时在多个频道工作时的在途频道集合 ──────────

    /// 同一 bot 的多个并发回合 → 每个频道各出现一次，去重且稳定有序。
    #[test]
    fn active_channels_collects_every_in_flight_channel_once() {
        let reg = StreamRegistry::new();
        let bot = Uuid::new_v4();
        let ch_a = Uuid::new_v4();
        let ch_b = Uuid::new_v4();
        for channel_id in [ch_a, ch_b, ch_a] {
            reg.register(StreamEntry {
                bot_id: bot,
                channel_id,
                ..entry(Uuid::new_v4())
            });
        }
        let mut expected = vec![ch_a, ch_b];
        expected.sort_unstable();
        assert_eq!(reg.active_channels(bot), expected);
    }

    /// 别的 bot 的在途回合不计入本 bot。
    #[test]
    fn active_channels_ignores_other_bots() {
        let reg = StreamRegistry::new();
        let bot = Uuid::new_v4();
        let channel_id = Uuid::new_v4();
        reg.register(StreamEntry {
            bot_id: bot,
            channel_id,
            ..entry(Uuid::new_v4())
        });
        reg.register(entry(Uuid::new_v4()));
        assert_eq!(reg.active_channels(bot), vec![channel_id]);
    }

    /// 已 finalize 的流不再算"在途"——终帧发出后调用方已在回合之外。
    #[test]
    fn active_channels_excludes_finalized_streams() {
        let reg = StreamRegistry::new();
        let bot = Uuid::new_v4();
        let msg = Uuid::new_v4();
        reg.register(StreamEntry {
            bot_id: bot,
            ..entry(msg)
        });
        assert_eq!(reg.active_channels(bot).len(), 1);
        let _guard = reg.claim_finalize(msg).unwrap();
        assert!(reg.active_channels(bot).is_empty());
    }
}
