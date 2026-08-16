//! 孤儿占位回收器（流程 8 缺口）。
//!
//! bot 占位 born `is_partial=TRUE, channel_seq=NULL`，仅在 `done` 帧到达时
//! finalize（此时才耗 seq）。若后端重启（内存态 [`StreamRegistry`] 丢失）或
//! bot 中途消失且未发 `done`，占位将成为孤儿——聊天气泡永远停在「思考中」。
//! 本周期性扫描删除这类孤儿占位，并发送一个瞬态 bot-unavailable 提示，与派发期
//! bot-offline 路径（`dispatcher::bot_unavailable_frame`）行为一致。
//!
//! 安全前提：占位仅在同时满足以下两条时才回收——
//!   (a) 早于 `threshold_secs`（`created_at < now() - threshold`），且
//!   (b) 无存活 `StreamEntry`（没有已连接的 bot 正在流式回写）。
//! 因此正在流式的长任务（有存活 entry）绝不会被误杀，且 bot 在后端重启后有
//! `threshold` 的时间重连并补发 `done`。

use std::sync::Arc;
use std::time::Duration;

use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::dispatcher::{bot_unavailable_frame, remove_placeholder};
use super::realtime::fanout::Fanout;
use super::stream::StreamRegistry;

/// 执行一次扫描，返回本轮回收的孤儿占位数。
pub async fn sweep_once(
    db: &PgPool,
    registry: &StreamRegistry,
    fanout: &Arc<dyn Fanout>,
    threshold_secs: u64,
) -> usize {
    let rows = match sqlx::query(
        "SELECT msg_id, sender_id
         FROM messages
         WHERE is_partial = TRUE
           AND channel_seq IS NULL
           AND created_at < NOW() - make_interval(secs => $1)",
    )
    .bind(threshold_secs as f64)
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
        let Some(msg_id) = row
            .try_get::<String, _>("msg_id")
            .ok()
            .and_then(|s| s.parse::<Uuid>().ok())
        else {
            continue;
        };

        // (b) 有存活 StreamEntry → 正在流式回写，跳过（绝不误杀长任务）。
        if registry.contains(msg_id) {
            continue;
        }

        let bot_id = row
            .try_get::<String, _>("sender_id")
            .ok()
            .and_then(|s| s.parse::<Uuid>().ok());

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
/// The periodic sweep waits `orphan_reclaim_threshold_secs` (15 min by default)
/// because it cannot tell a dead connector from a slow one. A disconnect can:
/// the gateway knows the socket is gone the instant it closes, so it only has to
/// outlast a reconnect. The connector's backoff caps at 30s, so a minute is
/// comfortably past a healthy recovery — and 15× faster than waiting for the
/// sweep, which is how long a chat bubble used to sit on "thinking".
const DISCONNECT_GRACE_SECS: u64 = 60;

/// Reclaim one bot's orphan placeholders. Same safety condition as the periodic
/// sweep — never touch a placeholder with a live [`StreamEntry`], since that is
/// a turn still streaming — but scoped to a single sender and without the age
/// filter, because the caller has already established that this bot is offline.
pub async fn sweep_bot(
    db: &PgPool,
    registry: &StreamRegistry,
    fanout: &Arc<dyn Fanout>,
    bot_id: Uuid,
) -> usize {
    let rows = match sqlx::query(
        "SELECT msg_id
         FROM messages
         WHERE is_partial = TRUE
           AND channel_seq IS NULL
           AND sender_type = 'bot'
           AND sender_id = $1",
    )
    .bind(bot_id.to_string())
    .fetch_all(db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, %bot_id, ctx = "disconnect reclaimer: select placeholders", "reclaimer db error");
            return 0;
        }
    };

    let mut reclaimed = 0usize;
    for row in rows {
        let Some(msg_id) = row
            .try_get::<String, _>("msg_id")
            .ok()
            .and_then(|s| s.parse::<Uuid>().ok())
        else {
            continue;
        };
        if registry.contains(msg_id) {
            continue;
        }
        match remove_placeholder(db, msg_id).await {
            Ok(Some(failed)) => {
                fanout
                    .broadcast_channel(
                        failed.channel_id,
                        bot_unavailable_frame(failed.channel_id, msg_id, bot_id),
                    )
                    .await;
                registry.remove(msg_id);
                reclaimed += 1;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::error!(error = %e, %msg_id, ctx = "disconnect reclaimer: remove_placeholder", "reclaimer db error");
            }
        }
    }
    if reclaimed > 0 {
        tracing::info!(
            %bot_id,
            count = reclaimed,
            "disconnect reclaimer: released placeholders left by a dropped connector"
        );
    }
    reclaimed
}

/// Schedule [`sweep_bot`] for a bot whose control connection just dropped.
///
/// Re-checks liveness after the grace window and does nothing if the connector
/// came back, so an ordinary reconnect still gets to finish its turn — only a
/// connection that stayed down releases the placeholders it stranded.
pub fn spawn_disconnect_sweep(
    db: PgPool,
    registry: Arc<StreamRegistry>,
    fanout: Arc<dyn Fanout>,
    locator: Arc<dyn super::registry::BotLocator>,
    bot_id: Uuid,
) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(DISCONNECT_GRACE_SECS)).await;
        if locator.is_online(bot_id).await {
            return;
        }
        sweep_bot(&db, &registry, &fanout, bot_id).await;
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
