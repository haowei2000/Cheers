use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use serde_json::Value;
use tokio::sync::mpsc;
use uuid::Uuid;

// ── Trait 定义（可替换实现的接口）────────────────────────────────────────────

/// 【业务层接口】向 bot 派发任务 / 发送数据帧。
/// 单实例：InProcessBotLocator。多实例：RedisBotLocator。
#[async_trait]
pub trait BotLocator: Send + Sync {
    async fn dispatch_task(&self, bot_id: Uuid, task: Value) -> bool;
    async fn send_data(&self, bot_id: Uuid, frame: Value) -> bool;
}

/// 【WS 连接层接口】管理 bot 的 control/data WS 连接注册。
/// 只有 transport/ws/acp_bridge.rs 使用。
/// 单实例：InProcessBotLocator。多实例：RedisBotRegistry。
pub trait BotRegistry: Send + Sync {
    fn bind_control(&self, bot_id: Uuid, conn_id: Uuid, task_tx: mpsc::Sender<Value>);
    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>);
    fn unbind(&self, bot_id: Uuid);
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

impl BotRegistry for InProcessBotLocator {
    fn bind_control(&self, bot_id: Uuid, conn_id: Uuid, task_tx: mpsc::Sender<Value>) {
        self.sessions.insert(bot_id, BotSession {
            bot_id,
            connection_id: conn_id,
            control_tx: task_tx,
            data_tx: None,
        });
    }

    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>) {
        if let Some(mut s) = self.sessions.get_mut(&bot_id) {
            s.data_tx = Some(data_tx);
        }
    }

    fn unbind(&self, bot_id: Uuid) {
        self.sessions.remove(&bot_id);
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
