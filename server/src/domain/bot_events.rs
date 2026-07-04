//! Bot bridge connection history（bot_connection_events）。
//!
//! agent_bridge 在 control/data WS 建立与断开时各记一行（断开带 reason），
//! 把「此刻在线与否」之外的时间线持久化下来：presence 帧是无状态的全量快照，
//! 掉线原因（心跳超时 / supersede / 协议错误…）只有这里可查。
//! 读取端：GET /api/v1/bots/:bot_id/connection-events、bot status 的
//! last_connected_at / last_disconnected_at。保留期清理见
//! gateway::connection_event_reaper。

use sqlx::PgPool;
use uuid::Uuid;

pub const EVENT_CONNECTED: &str = "connected";
pub const EVENT_DISCONNECTED: &str = "disconnected";

/// Fire-and-forget insert：历史记录绝不能阻塞或拖垮桥接读写循环。
pub fn record_bg(
    db: &PgPool,
    bot_id: Uuid,
    stream: &'static str,
    event: &'static str,
    reason: Option<&'static str>,
    connection_id: Uuid,
) {
    let db = db.clone();
    tokio::spawn(async move {
        let res = sqlx::query(
            "INSERT INTO bot_connection_events (bot_id, stream, event, reason, connection_id)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(bot_id.to_string())
        .bind(stream)
        .bind(event)
        .bind(reason)
        .bind(connection_id.to_string())
        .execute(&db)
        .await;
        if let Err(e) = res {
            tracing::warn!(%bot_id, stream, event, err = %e, "connection event persist failed");
        }
    });
}
