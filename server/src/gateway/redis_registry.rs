/// Redis pub/sub 实现的 BotLocator + BotRegistry。
///
/// BotLocator（派发侧）:
///   dispatch_task  → PUBLISH agentnexus:bot:{bot_id}:control {task}
///   send_data      → PUBLISH agentnexus:bot:{bot_id}:data {frame}
///
/// BotRegistry（连接绑定侧，WS handler 调用）:
///   bind_control   → SUBSCRIBE agentnexus:bot:{bot_id}:control，spawn 转发任务
///   bind_data      → SUBSCRIBE agentnexus:bot:{bot_id}:data，spawn 转发任务
///   unbind         → 取消转发任务，DEL Redis 在线标记
///
/// 在线标记: SET agentnexus:bot:{bot_id}:online 1 EX 30
/// （通过 is_bot_online 检查，派发前先确认 bot 是否在线，避免无效 PUBLISH）
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use super::registry::{BotLocator, BotRegistry};

fn control_subject(bot_id: Uuid) -> String {
    format!("agentnexus:bot:{bot_id}:control")
}
fn data_subject(bot_id: Uuid) -> String {
    format!("agentnexus:bot:{bot_id}:data")
}
fn online_key(bot_id: Uuid) -> String {
    format!("agentnexus:bot:{bot_id}:online")
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
}

// ── RedisBotRegistry（连接绑定侧）───────────────────────────────────────────

pub struct RedisBotRegistry {
    client: redis::Client,
    publisher: redis::aio::ConnectionManager,
    /// 取消令牌：bot_id → CancelSender（drop 时取消订阅任务）
    cancel_map: dashmap::DashMap<
        Uuid,
        (
            tokio::sync::oneshot::Sender<()>,
            tokio::sync::oneshot::Sender<()>,
        ),
    >,
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
    fn bind_control(&self, bot_id: Uuid, conn_id: Uuid, task_tx: mpsc::Sender<Value>) -> oneshot::Receiver<()> {
        RedisBotRegistry::bind_control(self, bot_id, conn_id, task_tx)
    }
    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>) {
        RedisBotRegistry::bind_data(self, bot_id, data_tx);
    }
    fn unbind(&self, bot_id: Uuid) {
        RedisBotRegistry::unbind(self, bot_id);
    }
    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid) {
        RedisBotRegistry::unbind_if_connection(self, bot_id, conn_id);
    }
    fn unbind_data(&self, bot_id: Uuid) {
        RedisBotRegistry::unbind_data(self, bot_id);
    }
}

impl BotRegistry for RedisBotRegistry {
    fn bind_control(&self, bot_id: Uuid, _conn_id: Uuid, task_tx: mpsc::Sender<Value>) -> oneshot::Receiver<()> {
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        let client = self.client.clone();
        let publisher = self.publisher.clone();

        // 设置 Redis 在线标记（30s TTL，由心跳续期）
        tokio::spawn(set_online(publisher.clone(), bot_id));

        // supersede 信号：新连接进来时通知旧 WS handler 退出
        let (supersede_tx, supersede_rx) = oneshot::channel::<()>();

        // 启动订阅转发任务（cancel_rx 在 unbind 时触发）
        tokio::spawn(forward_loop(
            client,
            control_subject(bot_id),
            task_tx,
            cancel_rx,
        ));

        // 存 cancel 令牌（bind_data 时补第二个）；同时存旧 supersede_tx
        // 若已有旧 session，触发其 supersede 信号
        let (dummy_tx, _) = tokio::sync::oneshot::channel::<()>();
        if let Some((_, old)) = self.cancel_map.remove(&bot_id) {
            drop(old); // drop 旧 cancel 对（会触发旧 forward_loop 退出）
        }
        // 重用 cancel_map 中第二个槽存 supersede_tx（临时方案）
        self.cancel_map.insert(bot_id, (cancel_tx, supersede_tx));
        drop(dummy_tx);

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

        // 替换 cancel_map 里的 data cancel
        if let Some(mut entry) = self.cancel_map.get_mut(&bot_id) {
            entry.1 = cancel_tx;
        } else {
            let (ctrl_dummy, _) = tokio::sync::oneshot::channel::<()>();
            self.cancel_map.insert(bot_id, (ctrl_dummy, cancel_tx));
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
