/// Redis pub/sub 实现的 BotLocator + BotRegistry。
///
/// BotLocator（派发侧）:
///   dispatch_task  → PUBLISH cheers:bot:{bot_id}:control {task}
///   send_data      → PUBLISH cheers:bot:{bot_id}:data {frame}
///
/// BotRegistry（连接绑定侧，WS handler 调用）:
///   bind_control   → SUBSCRIBE cheers:bot:{bot_id}:control，spawn 转发任务
///   bind_data      → SUBSCRIBE cheers:bot:{bot_id}:data，spawn 转发任务
///   unbind         → 取消转发任务，DEL Redis 在线标记
///
/// 在线标记: SET cheers:bot:{bot_id}:online 1 EX 30
/// （通过 is_bot_online 检查，派发前先确认 bot 是否在线，避免无效 PUBLISH）
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use super::registry::{BotLocator, BotRegistry};

fn control_subject(bot_id: Uuid) -> String {
    format!("cheers:bot:{bot_id}:control")
}
fn data_subject(bot_id: Uuid) -> String {
    format!("cheers:bot:{bot_id}:data")
}
fn online_key(bot_id: Uuid) -> String {
    format!("cheers:bot:{bot_id}:online")
}

// ── RedisBotLocator（派发侧）─────────────────────────────────────────────────

pub struct RedisBotLocator {
    publisher: redis::aio::ConnectionManager,
}

impl RedisBotLocator {
    pub fn new(publisher: redis::aio::ConnectionManager) -> Arc<Self> {
        Arc::new(Self { publisher })
    }
}

#[async_trait]
impl BotLocator for RedisBotLocator {
    async fn dispatch_task(&self, bot_id: Uuid, task: Value) -> bool {
        // 先检查 bot 是否在线（避免无效 PUBLISH）
        let online = check_online(&self.publisher.clone(), bot_id).await;
        if !online {
            return false;
        }
        let payload = serde_json::to_string(&task).unwrap_or_default();
        let mut conn = self.publisher.clone();
        let receivers: i64 = redis::cmd("PUBLISH")
            .arg(control_subject(bot_id))
            .arg(&payload)
            .query_async(&mut conn)
            .await
            .unwrap_or(0);
        receivers > 0
    }

    async fn send_data(&self, bot_id: Uuid, frame: Value) -> bool {
        let payload = serde_json::to_string(&frame).unwrap_or_default();
        let mut conn = self.publisher.clone();
        let receivers: i64 = redis::cmd("PUBLISH")
            .arg(data_subject(bot_id))
            .arg(&payload)
            .query_async(&mut conn)
            .await
            .unwrap_or(0);
        receivers > 0
    }

    fn is_online(&self, _bot_id: Uuid) -> bool {
        // Multi-instance: liveness would need a Redis presence key; not used in the
        // single-instance path. Conservatively report false.
        false
    }
}

// ── RedisBotRegistry（连接绑定侧）───────────────────────────────────────────

struct BotCancelTokens {
    /// Drop to cancel the control forward_loop.
    control_cancel: Option<tokio::sync::oneshot::Sender<()>>,
    /// Drop to cancel the data forward_loop.
    data_cancel: Option<tokio::sync::oneshot::Sender<()>>,
    /// Send to notify old handler that a new control connection superseded it.
    supersede_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

pub struct RedisBotRegistry {
    client: redis::Client,
    publisher: redis::aio::ConnectionManager,
    cancel_map: dashmap::DashMap<Uuid, BotCancelTokens>,
}

impl RedisBotRegistry {
    pub fn new(client: redis::Client, publisher: redis::aio::ConnectionManager) -> Arc<Self> {
        Arc::new(Self {
            client,
            publisher,
            cancel_map: dashmap::DashMap::new(),
        })
    }
}

// BotRegistry 在 Arc<RedisBotRegistry> 上实现
impl BotRegistry for Arc<RedisBotRegistry> {
    fn bind_control(
        &self,
        bot_id: Uuid,
        conn_id: Uuid,
        task_tx: mpsc::Sender<Value>,
    ) -> oneshot::Receiver<()> {
        (**self).bind_control(bot_id, conn_id, task_tx)
    }
    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>) {
        (**self).bind_data(bot_id, data_tx)
    }
    fn unbind(&self, bot_id: Uuid) {
        (**self).unbind(bot_id)
    }
    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid) {
        (**self).unbind_if_connection(bot_id, conn_id)
    }
    fn unbind_data(&self, bot_id: Uuid) {
        (**self).unbind_data(bot_id)
    }
    fn kick(&self, bot_id: Uuid) {
        (**self).kick(bot_id)
    }
}

impl BotRegistry for RedisBotRegistry {
    fn bind_control(
        &self,
        bot_id: Uuid,
        _conn_id: Uuid,
        task_tx: mpsc::Sender<Value>,
    ) -> oneshot::Receiver<()> {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let client = self.client.clone();
        let publisher = self.publisher.clone();

        tokio::spawn(set_online(publisher.clone(), bot_id));

        let (supersede_tx, supersede_rx) = oneshot::channel::<()>();

        tokio::spawn(forward_loop(
            client,
            control_subject(bot_id),
            task_tx,
            cancel_rx,
        ));

        // Preserve data_cancel if bind_data arrived first (race).
        // Also signal supersede on the old control handler.
        let existing_data = self.cancel_map.remove(&bot_id).and_then(|(_, old)| {
            if let Some(tx) = old.supersede_tx {
                let _ = tx.send(());
            }
            old.data_cancel
        });

        self.cancel_map.insert(
            bot_id,
            BotCancelTokens {
                control_cancel: Some(cancel_tx),
                data_cancel: existing_data,
                supersede_tx: Some(supersede_tx),
            },
        );

        supersede_rx
    }

    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>) {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let client = self.client.clone();

        tokio::spawn(forward_loop(
            client,
            data_subject(bot_id),
            data_tx,
            cancel_rx,
        ));

        // Store data cancel; preserve existing control_cancel if bind_control was first.
        if let Some(mut entry) = self.cancel_map.get_mut(&bot_id) {
            entry.data_cancel = Some(cancel_tx);
        } else {
            self.cancel_map.insert(
                bot_id,
                BotCancelTokens {
                    control_cancel: None,
                    data_cancel: Some(cancel_tx),
                    supersede_tx: None,
                },
            );
        }
    }

    fn unbind(&self, bot_id: Uuid) {
        // 取消令牌 drop 时，forward_loop 会退出
        self.cancel_map.remove(&bot_id);
        // 清除在线标记
        let mut publisher = self.publisher.clone();
        tokio::spawn(async move {
            let _: redis::RedisResult<()> = redis::cmd("DEL")
                .arg(online_key(bot_id))
                .query_async(&mut publisher)
                .await;
        });
    }

    fn unbind_if_connection(&self, bot_id: Uuid, _conn_id: Uuid) {
        // Redis 模式下连接生命周期由 forward_loop 管理，unbind 直接清理即可
        self.unbind(bot_id);
    }

    fn unbind_data(&self, _bot_id: Uuid) {
        // Redis 模式下 data TX 不在 cancel_map 里，无需额外操作
    }

    fn kick(&self, bot_id: Uuid) {
        // Fire supersede (closes the live control WS), drop the cancel tokens so the
        // forward loops exit, then clear the online marker.
        if let Some((_, tokens)) = self.cancel_map.remove(&bot_id) {
            if let Some(tx) = tokens.supersede_tx {
                let _ = tx.send(());
            }
        }
        let mut publisher = self.publisher.clone();
        tokio::spawn(async move {
            let _: redis::RedisResult<()> = redis::cmd("DEL")
                .arg(online_key(bot_id))
                .query_async(&mut publisher)
                .await;
        });
    }
}

// ── 订阅转发任务 ──────────────────────────────────────────────────────────────

async fn forward_loop(
    client: redis::Client,
    subject: String,
    tx: mpsc::Sender<Value>,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) {
    loop {
        let result = tokio::select! {
            _ = &mut cancel => break,
            r = do_forward(client.clone(), subject.clone(), tx.clone()) => r,
        };
        match result {
            Ok(()) => break, // 正常退出（tx 被 drop）
            Err(e) => {
                tracing::warn!(subject, err = %e, "redis subscriber error, retrying");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
}

async fn do_forward(
    client: redis::Client,
    subject: String,
    tx: mpsc::Sender<Value>,
) -> anyhow::Result<()> {
    let conn = client.get_async_connection().await?;
    let mut pubsub = conn.into_pubsub();
    pubsub.subscribe(&subject).await?;

    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        let payload: String = msg.get_payload()?;
        if let Ok(value) = serde_json::from_str::<Value>(&payload) {
            if tx.send(value).await.is_err() {
                break; // 接收方（WS handler）已关闭
            }
        }
    }
    Ok(())
}

// ── 在线状态辅助 ──────────────────────────────────────────────────────────────

async fn set_online(mut conn: redis::aio::ConnectionManager, bot_id: Uuid) {
    let _: redis::RedisResult<()> = redis::cmd("SET")
        .arg(online_key(bot_id))
        .arg(1)
        .arg("EX")
        .arg(30u64)
        .query_async(&mut conn)
        .await;
}

async fn check_online(conn: &redis::aio::ConnectionManager, bot_id: Uuid) -> bool {
    let mut c = conn.clone();
    let exists: redis::RedisResult<i32> = redis::cmd("EXISTS")
        .arg(online_key(bot_id))
        .query_async(&mut c)
        .await;
    exists.unwrap_or(0) > 0
}
