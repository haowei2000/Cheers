use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use serde_json::Value;
use tokio::sync::mpsc;
use uuid::Uuid;

// ── Trait 定义（可替换实现的接口）────────────────────────────────────────────

/// 向 bot 连接派发任务 / 发送数据帧的接口。
///
/// 本期实现：InProcessBotLocator（进程内 DashMap）。
/// 未来多实例：换成一致性哈希 + 跨实例路由，只换这里。
#[async_trait]
pub trait BotLocator: Send + Sync {
    /// 通过 control WS 向 bot 派发 task 帧。
    /// 返回 false 表示 bot 不在线。
    async fn dispatch_task(&self, bot_id: Uuid, task: Value) -> bool;

    /// 通过 data WS 向 bot 发送数据帧（resource_res、permission_request 等）。
    /// 返回 false 表示 bot 不在线。
    async fn send_data(&self, bot_id: Uuid, frame: Value) -> bool;
}

// ── Bot 会话（单 bot 的连接状态）─────────────────────────────────────────────

/// 每个在线 bot 的连接句柄。
pub struct BotSession {
    pub bot_id: Uuid,
    pub connection_id: Uuid,
    /// control WS 的发送端（发 task 帧）
    pub control_tx: mpsc::Sender<Value>,
    /// data WS 的发送端（发 resource_res 等）
    pub data_tx: Option<mpsc::Sender<Value>>,
}

// ── 进程内实现 ────────────────────────────────────────────────────────────────

pub struct InProcessBotLocator {
    sessions: DashMap<Uuid, BotSession>,
}

impl InProcessBotLocator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: DashMap::new(),
        })
    }

    /// bot control WS 连接时注册。新连接 supersede 旧连接。
    pub fn bind_control(
        &self,
        bot_id: Uuid,
        connection_id: Uuid,
        control_tx: mpsc::Sender<Value>,
    ) -> Option<BotSession> {
        self.sessions.insert(
            bot_id,
            BotSession {
                bot_id,
                connection_id,
                control_tx,
                data_tx: None,
            },
        )
    }

    /// bot data WS 连接时绑定（control 必须已经连上）。
    pub fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>) {
        if let Some(mut session) = self.sessions.get_mut(&bot_id) {
            session.data_tx = Some(data_tx);
        }
    }

    /// bot 断线时移除。
    pub fn unbind(&self, bot_id: Uuid) {
        self.sessions.remove(&bot_id);
    }

    /// 查询 bot 是否在线（control + data 都已连接）。
    pub fn is_online(&self, bot_id: Uuid) -> bool {
        self.sessions
            .get(&bot_id)
            .map(|s| s.data_tx.is_some())
            .unwrap_or(false)
    }
}

impl Default for InProcessBotLocator {
    fn default() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }
}

#[async_trait]
impl BotLocator for InProcessBotLocator {
    async fn dispatch_task(&self, bot_id: Uuid, task: Value) -> bool {
        if let Some(session) = self.sessions.get(&bot_id) {
            session.control_tx.try_send(task).is_ok()
        } else {
            false
        }
    }

    async fn send_data(&self, bot_id: Uuid, frame: Value) -> bool {
        if let Some(session) = self.sessions.get(&bot_id) {
            if let Some(ref tx) = session.data_tx {
                return tx.try_send(frame).is_ok();
            }
        }
        false
    }
}
