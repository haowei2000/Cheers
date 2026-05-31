use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use tokio::sync::mpsc;
use uuid::Uuid;

pub use super::frame::WireFrame;

// ── Trait 定义（可替换实现的接口）────────────────────────────────────────────

/// 广播给浏览器 WS 连接的接口。
///
/// 本期实现：InProcessFanout（进程内 DashMap）。
/// 未来多实例：接 Redis pub/sub，只换这里。
#[async_trait]
pub trait Fanout: Send + Sync {
    /// 广播给订阅了指定频道的所有浏览器连接。
    async fn broadcast_channel(&self, channel_id: Uuid, frame: WireFrame);

    /// 广播给指定用户的所有连接（未读通知等 user 级事件）。
    async fn broadcast_user(&self, user_id: Uuid, frame: WireFrame);
}

// ── 进程内实现 ────────────────────────────────────────────────────────────────

/// 单进程 fan-out。每条浏览器 WS 连接持有一个 `mpsc::Sender<WireFrame>`，
/// 注册时把 Sender 存入 DashMap，断线时移除。
pub struct InProcessFanout {
    /// channel_id → 订阅该频道的所有连接的发送端
    channels: DashMap<Uuid, Vec<ConnSender>>,
    /// user_id → 该用户的所有连接的发送端
    users: DashMap<Uuid, Vec<ConnSender>>,
}

/// 连接的标识符 + 发送端
#[derive(Clone)]
struct ConnSender {
    conn_id: Uuid,
    tx: mpsc::Sender<WireFrame>,
}

impl InProcessFanout {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            channels: DashMap::new(),
            users: DashMap::new(),
        })
    }

    /// 浏览器 WS 连接建立后，注册 user 级发送端。
    pub fn register_user(&self, user_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        self.users
            .entry(user_id)
            .or_default()
            .push(ConnSender { conn_id, tx });
    }

    /// 浏览器订阅某频道后，注册 channel 级发送端。
    pub fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        self.channels
            .entry(channel_id)
            .or_default()
            .push(ConnSender { conn_id, tx });
    }

    /// 浏览器退订某频道或断线时，移除对应发送端。
    pub fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid) {
        if let Some(mut senders) = self.channels.get_mut(&channel_id) {
            senders.retain(|s| s.conn_id != conn_id);
        }
    }

    /// 浏览器断线时，移除该连接的所有注册。
    pub fn deregister_user(&self, user_id: Uuid, conn_id: Uuid) {
        if let Some(mut senders) = self.users.get_mut(&user_id) {
            senders.retain(|s| s.conn_id != conn_id);
        }
    }
}

impl Default for InProcessFanout {
    fn default() -> Self {
        Self {
            channels: DashMap::new(),
            users: DashMap::new(),
        }
    }
}

#[async_trait]
impl Fanout for InProcessFanout {
    async fn broadcast_channel(&self, channel_id: Uuid, frame: WireFrame) {
        if let Some(senders) = self.channels.get(&channel_id) {
            for s in senders.iter() {
                // 非阻塞发送；队列满时丢弃（delta 可丢，终态帧由背压逻辑处理）
                let _ = s.tx.try_send(frame.clone());
            }
        }
    }

    async fn broadcast_user(&self, user_id: Uuid, frame: WireFrame) {
        if let Some(senders) = self.users.get(&user_id) {
            for s in senders.iter() {
                let _ = s.tx.try_send(frame.clone());
            }
        }
    }
}
