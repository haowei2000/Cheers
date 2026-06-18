/// Redis pub/sub 实现的 Fanout。
///
/// 设计：
/// - broadcast_channel/user → Redis PUBLISH
/// - 启动时 spawn 一个后台订阅任务，psubscribe 所有频道/用户主题
/// - 收到 Redis 消息 → 解析 channel_id → 转发给本实例的本地连接
///
/// 可靠性：Redis pub/sub 是 at-most-once，可接受——
/// 终态帧已先落 PG（写后投递原则），断线重连后 REST 补齐。
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::{
    fanout::{Fanout, InProcessFanout, WireFrame},
    manager::LocalRegistry,
};

// ── Redis key 命名规范 ────────────────────────────────────────────────────────
// agentnexus:rt:channel:{channel_id}  ← 频道事件
// agentnexus:rt:user:{user_id}        ← 用户级通知

const CHANNEL_PATTERN: &str = "agentnexus:rt:channel:*";
const USER_PATTERN: &str = "agentnexus:rt:user:*";

fn channel_subject(channel_id: Uuid) -> String {
    format!("agentnexus:rt:channel:{channel_id}")
}
fn user_subject(user_id: Uuid) -> String {
    format!("agentnexus:rt:user:{user_id}")
}

// ── RedisFanout ───────────────────────────────────────────────────────────────

pub struct RedisFanout {
    /// 发布连接（复用 multiplexed connection）
    publisher: redis::aio::ConnectionManager,
    /// 本实例的本地连接表（后台订阅任务收到消息后转发到这里）
    local: Arc<InProcessFanout>,
}

impl RedisFanout {
    pub async fn new(redis_url: &str) -> anyhow::Result<Arc<Self>> {
        let client = redis::Client::open(redis_url)?;
        let publisher = redis::aio::ConnectionManager::new(client.clone()).await?;
        let local = InProcessFanout::new();

        let fanout = Arc::new(Self {
            publisher,
            local: local.clone(),
        });

        // 启动后台订阅任务
        tokio::spawn(subscribe_loop(client, local));

        Ok(fanout)
    }

    /// 供 ConnectionManager 注册本地浏览器连接（subscribe 时调用）。
    pub fn register_user(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<()>,
    ) {
        self.local.register_user(user_id, conn_id, tx, close_tx);
    }
    pub fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        self.local.subscribe_channel(channel_id, conn_id, tx);
    }
    pub fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid) {
        self.local.unsubscribe_channel(channel_id, conn_id);
    }
    pub fn deregister_user(&self, user_id: Uuid, conn_id: Uuid) {
        self.local.deregister_user(user_id, conn_id);
    }
}

impl LocalRegistry for RedisFanout {
    fn register_user(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<()>,
    ) {
        self.local.register_user(user_id, conn_id, tx, close_tx);
    }
    fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        self.local.subscribe_channel(channel_id, conn_id, tx);
    }
    fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid) {
        self.local.unsubscribe_channel(channel_id, conn_id);
    }
    fn deregister_user(&self, user_id: Uuid, conn_id: Uuid) {
        self.local.deregister_user(user_id, conn_id);
    }
}

#[async_trait]
impl Fanout for RedisFanout {
    async fn broadcast_channel(&self, channel_id: Uuid, frame: WireFrame) {
        let subject = channel_subject(channel_id);
        publish(&self.publisher.clone(), &subject, &frame).await;
    }

    async fn broadcast_user(&self, user_id: Uuid, frame: WireFrame) {
        let subject = user_subject(user_id);
        publish(&self.publisher.clone(), &subject, &frame).await;
    }
}

// ── 后台订阅任务 ──────────────────────────────────────────────────────────────

/// 订阅所有频道/用户主题，把收到的消息转发给本实例的本地连接。
async fn subscribe_loop(client: redis::Client, local: Arc<InProcessFanout>) {
    loop {
        match do_subscribe(client.clone(), local.clone()).await {
            Ok(()) => break,
            Err(e) => {
                tracing::warn!(err = %e, "redis subscriber disconnected, retrying in 2s");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}

async fn do_subscribe(client: redis::Client, local: Arc<InProcessFanout>) -> anyhow::Result<()> {
    let conn = client.get_async_connection().await?;
    let mut pubsub = conn.into_pubsub();

    pubsub.psubscribe(CHANNEL_PATTERN).await?;
    pubsub.psubscribe(USER_PATTERN).await?;

    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        let channel: String = msg.get_channel_name().to_string();
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(_) => continue,
        };

        let frame: WireFrame = match serde_json::from_str(&payload) {
            Ok(f) => f,
            Err(_) => continue,
        };

        // 按主题路由到本地连接
        if let Some(id_str) = channel.strip_prefix("agentnexus:rt:channel:") {
            if let Ok(channel_id) = id_str.parse::<Uuid>() {
                local.broadcast_channel(channel_id, frame).await;
            }
        } else if let Some(id_str) = channel.strip_prefix("agentnexus:rt:user:") {
            if let Ok(user_id) = id_str.parse::<Uuid>() {
                local.broadcast_user(user_id, frame).await;
            }
        }
    }

    Ok(())
}

// ── 发布辅助 ──────────────────────────────────────────────────────────────────

async fn publish(conn: &redis::aio::ConnectionManager, subject: &str, frame: &WireFrame) {
    let payload = match serde_json::to_string(frame) {
        Ok(p) => p,
        Err(_) => return,
    };
    let mut c = conn.clone();
    if let Err(e) = redis::cmd("PUBLISH")
        .arg(subject)
        .arg(&payload)
        .query_async::<_, i64>(&mut c)
        .await
    {
        tracing::warn!(subject, err = %e, "redis publish failed");
    }
}
