//! 孤儿占位回收器（流程 8 缺口）。
//!
//! bot 占位 born `is_partial=TRUE, channel_seq=NULL`，仅在 `done` 帧到达时
//! finalize（此时才耗 seq）。若后端重启（内存态 [`StreamRegistry`] 丢失）或
//! bot 中途消失且未发 `done`，占位将成为孤儿——聊天气泡永远停在「思考中」。
//! 本周期性扫描删除这类孤儿占位，并发送一个瞬态 bot-unavailable 提示，与派发期
//! bot-offline 路径（`dispatcher::bot_unavailable_frame`）行为一致。
//!
//! 周期扫描的安全前提：占位仅在同时满足以下两条时才回收——
//!   (a) 早于 `threshold_secs`（`created_at < now() - threshold`），且
//!   (b) 无注册的 `StreamEntry`。
//! 因此正在流式的长任务（有存活 entry）绝不会被误杀，且 bot 在后端重启后有
//! `threshold` 的时间重连并补发 `done`。已知断线另走连接代数门禁：宽限期后
//! 仅在原连接代数未变且 bot 仍不可用时回收，重连后的任务不受旧定时器影响。

use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use super::dispatcher::{bot_unavailable_frame, remove_placeholder};
use super::realtime::fanout::Fanout;
use super::registry::BotLocator;
use super::stream::StreamRegistry;

/// 执行一次扫描，返回本轮回收的孤儿占位数。
pub async fn sweep_once(
    db: &PgPool,
    registry: &StreamRegistry,
    fanout: &Arc<dyn Fanout>,
    threshold_secs: u64,
) -> usize {
    let rows = match sqlx::query!(
        "SELECT msg_id, sender_id
         FROM messages m
         WHERE is_partial = TRUE
           AND channel_seq IS NULL
           AND created_at < NOW() - make_interval(secs => $1)
           AND NOT EXISTS (
               SELECT 1 FROM bot_runs r WHERE r.placeholder_msg_id = m.msg_id
                 AND r.dispatch_input IS NOT NULL
                 AND r.status IN ('pending', 'prepared')
                 AND r.execution_id IS NULL AND r.accepted_at IS NULL
           )",
        threshold_secs as f64,
    )
    .fetch_all(db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, ctx = "orphan reclaimer: select stale placeholders", "reclaimer db error");
            return 0;
        }
    };

    let mut reclaimed = 0usize;
    for row in rows {
        let Some(msg_id) = Some(row.msg_id.clone()).and_then(|s| s.parse::<Uuid>().ok()) else {
            continue;
        };

        // (b) 有存活 StreamEntry → 正在流式回写，跳过（绝不误杀长任务）。
        if registry.contains(msg_id) {
            continue;
        }

        let bot_id = Some(row.sender_id.clone()).and_then(|s| s.parse::<Uuid>().ok());

        match remove_placeholder(db, msg_id).await {
            Ok(Some(failed)) => {
                // 仅当能解析出 bot_id 时才广播终态帧（前端据此解除「思考中」）。
                if let Some(bot_id) = bot_id {
                    fanout
                        .broadcast_channel(
                            failed.channel_id,
                            bot_unavailable_frame(failed.channel_id, msg_id, bot_id),
                        )
                        .await;
                }
                registry.remove(msg_id);
                reclaimed += 1;
                tracing::info!(msg_id = %msg_id, "orphan reclaimer: placeholder removed; bot unavailable notified");
            }
            // 占位已被并发 done/dispatch finalize（channel_seq 已分配）——无需处理。
            Ok(None) => {}
            Err(e) => {
                tracing::error!(error = %e, msg_id = %msg_id, ctx = "orphan reclaimer: remove_placeholder", "reclaimer db error");
            }
        }
    }

    if reclaimed > 0 {
        tracing::info!(
            count = reclaimed,
            "orphan reclaimer: swept orphaned placeholders"
        );
    }
    reclaimed
}

/// Grace between a control disconnect and reclaiming that bot's placeholders.
///
/// A minute outlasts the connector's normal reconnect backoff. Reclamation then
/// requires the original control generation and an unavailable bot; a new
/// connection invalidates this timer even if it disconnects again immediately.
const DISCONNECT_GRACE_SECS: u64 = 60;

#[derive(Default)]
pub struct ReclaimReport {
    pub reclaimed: usize,
    /// A DB failure or an in-flight terminal claim needs another fenced attempt.
    pub retry: bool,
}

async fn can_reclaim(locator: &Arc<dyn BotLocator>, bot_id: Uuid, generation: Uuid) -> bool {
    locator.control_generation(bot_id).await == Some(generation)
        && !locator.is_online(bot_id).await
        && locator.control_generation(bot_id).await == Some(generation)
}

/// Reclaim a bot that stayed unavailable after its control connection closed.
/// The caller waits the grace period first. Recheck the connection generation
/// and availability before each delete, and share the terminal claim so a DB
/// failure or cancellation cannot poison the in-memory entry.
pub async fn sweep_bot(
    db: &PgPool,
    registry: &StreamRegistry,
    fanout: &Arc<dyn Fanout>,
    locator: &Arc<dyn BotLocator>,
    bot_id: Uuid,
    expected_generation: Uuid,
) -> ReclaimReport {
    let mut report = ReclaimReport::default();
    if !can_reclaim(locator, bot_id, expected_generation).await {
        return report;
    }
    let rows = match sqlx::query!(
        "SELECT msg_id
         FROM messages m
         WHERE is_partial = TRUE
           AND channel_seq IS NULL
           AND sender_type = 'bot'
           AND sender_id = $1
           AND NOT EXISTS (
               SELECT 1 FROM bot_runs r WHERE r.placeholder_msg_id = m.msg_id
                 AND r.dispatch_input IS NOT NULL
                 AND r.status IN ('pending', 'prepared')
                 AND r.execution_id IS NULL AND r.accepted_at IS NULL
           )",
        bot_id.to_string(),
    )
    .fetch_all(db)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, %bot_id, ctx = "disconnect reclaimer: select placeholders", "reclaimer db error");
            report.retry = true;
            return report;
        }
    };
    for row in rows {
        let Ok(msg_id) = row.msg_id.parse::<Uuid>() else {
            continue;
        };
        let claim = match registry.claim_finalize(msg_id) {
            Ok(claim) => claim,
            Err(_) => {
                report.retry = true;
                continue;
            }
        };
        if !can_reclaim(locator, bot_id, expected_generation).await {
            break;
        }
        match remove_placeholder(db, msg_id).await {
            Ok(Some(failed)) => {
                if let Some(claim) = claim {
                    claim.remove();
                }
                fanout
                    .broadcast_channel(
                        failed.channel_id,
                        bot_unavailable_frame(failed.channel_id, msg_id, bot_id),
                    )
                    .await;
                report.reclaimed += 1;
            }
            // The DB row already completed or disappeared. Remove only the old
            // task's stale memory entry, leaving any replacement task intact.
            Ok(None) => {
                if let Some(claim) = claim {
                    claim.remove();
                }
            }
            Err(e) => {
                tracing::error!(error = %e, %msg_id, ctx = "disconnect reclaimer: remove_placeholder", "reclaimer db error");
                report.retry = true;
            }
        }
    }
    if report.reclaimed > 0 {
        tracing::info!(
            %bot_id,
            count = report.reclaimed,
            "disconnect reclaimer: released placeholders left by a dropped connector"
        );
    }
    report
}

/// Schedule recovery for a control connection that closed or was kicked.
///
/// Capturing the actual connection ID, rather than checking availability alone,
/// preserves a fresh grace period after every reconnect/disconnect cycle.
pub fn spawn_disconnect_sweep(
    db: PgPool,
    registry: Arc<StreamRegistry>,
    fanout: Arc<dyn Fanout>,
    locator: Arc<dyn BotLocator>,
    bot_id: Uuid,
    disconnected_connection: Uuid,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(DISCONNECT_GRACE_SECS)).await;
            let report = sweep_bot(
                &db,
                &registry,
                &fanout,
                &locator,
                bot_id,
                disconnected_connection,
            )
            .await;
            // A temporary DB outage must not leave registered turns stranded
            // forever. Retry at most once per minute; a new generation or a
            // healthy connection retires the old attempt without touching work.
            if !report.retry {
                break;
            }
        }
    });
}

/// 启动后台回收任务：先做一次启动扫描，再按 `interval_secs` 周期扫描。
/// `interval_secs == 0` 时只做启动扫描，不进入周期循环。
pub fn spawn(
    db: PgPool,
    registry: Arc<StreamRegistry>,
    fanout: Arc<dyn Fanout>,
    interval_secs: u64,
    threshold_secs: u64,
) {
    tokio::spawn(async move {
        // 启动扫描：清掉上次进程退出时遗留的孤儿（早于 threshold 的）。
        sweep_once(&db, &registry, &fanout, threshold_secs).await;

        if interval_secs == 0 {
            return;
        }

        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs));
        tick.tick().await; // 第一拍立即触发，跳过（启动扫描已做）。
        loop {
            tick.tick().await;
            sweep_once(&db, &registry, &fanout, threshold_secs).await;
        }
    });
}
