use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
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
/// 只有 transport/ws/agent_bridge.rs 使用。
/// 单实例：InProcessBotLocator。多实例：RedisBotRegistry。
pub trait BotRegistry: Send + Sync {
    /// 注册 control WS，返回一个取消信号接收端。
    /// 当同一 bot_id 的新连接进来（supersede）时，旧连接会通过该信号得知。
    fn bind_control(
        &self,
        bot_id: Uuid,
        conn_id: Uuid,
        task_tx: mpsc::Sender<Value>,
    ) -> oneshot::Receiver<()>;

    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>);

    /// 完整移除 bot 的 session（正常断线清理）。
    fn unbind(&self, bot_id: Uuid);

    /// 仅当 conn_id 匹配时才移除（防止新连接的 session 被旧连接 cleanup 误删）。
    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid);

    /// data WS 断线时清除 data_tx，保留 control session。
    fn unbind_data(&self, bot_id: Uuid);
}

// ── Bot 会话（单 bot 的连接状态）─────────────────────────────────────────────

/// 每个在线 bot 的连接句柄。
struct BotSession {
    connection_id: Uuid,
    /// control WS 的发送端（发 task 帧）
    control_tx: mpsc::Sender<Value>,
    /// data WS 的发送端（发 resource_res 等）
    data_tx: Option<mpsc::Sender<Value>>,
    /// 当新连接 supersede 此 session 时，向旧 WS 发取消信号
    supersede_tx: oneshot::Sender<()>,
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
    fn bind_control(
        &self,
        bot_id: Uuid,
        conn_id: Uuid,
        task_tx: mpsc::Sender<Value>,
    ) -> oneshot::Receiver<()> {
        let (supersede_tx, supersede_rx) = oneshot::channel();

        // 新连接进来：通知旧连接它被取代了（旧连接的 supersede_rx 会收到信号）
        // 必须先 insert 再 send，保证新连接已注册后旧连接才退出
        if let Some((_, old)) = self.sessions.remove(&bot_id) {
            let _ = old.supersede_tx.send(());
        }

        self.sessions.insert(
            bot_id,
            BotSession {
                connection_id: conn_id,
                control_tx: task_tx,
                data_tx: None,
                supersede_tx,
            },
        );

        supersede_rx
    }

    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>) {
        if let Some(mut s) = self.sessions.get_mut(&bot_id) {
            s.data_tx = Some(data_tx);
        }
    }

    fn unbind(&self, bot_id: Uuid) {
        self.sessions.remove(&bot_id);
    }

    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid) {
        // 只有 connection_id 匹配时才删，防止误删新连接的 session。
        // 顺序保证：bind_control 先 insert 新 session 再发 supersede 信号，
        // 所以此处调用时新连接的 conn_id 已经写入，check 不会误删。
        let matches = self
            .sessions
            .get(&bot_id)
            .map(|s| s.connection_id == conn_id)
            .unwrap_or(false);
        if matches {
            self.sessions.remove(&bot_id);
        }
    }

    fn unbind_data(&self, bot_id: Uuid) {
        if let Some(mut s) = self.sessions.get_mut(&bot_id) {
            s.data_tx = None;
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
