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
    /// True when the bot has both a control and a data WS bound (can receive pushes).
    fn is_online(&self, bot_id: Uuid) -> bool;
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

    /// 强制踢掉 bot 的实时会话（管理员禁用时用）。移除 session 并向 control WS
    /// 发 supersede 信号让其关闭;之后 is_online 立即变 false,派发也会失败。
    /// 配合连接门禁(is_disabled),被禁用的 bot 无法重连。
    fn kick(&self, bot_id: Uuid);
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
    /// data_tx that arrived before the control session was created.
    /// bind_control picks these up so they are not lost to the race.
    pending_data: DashMap<Uuid, mpsc::Sender<Value>>,
}

impl InProcessBotLocator {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: DashMap::new(),
            pending_data: DashMap::new(),
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
            pending_data: DashMap::new(),
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

        // Remove any old session and signal it (genuine supersede).
        // If there's no old session the signal just drops.
        if let Some((_, old)) = self.sessions.remove(&bot_id) {
            let _ = old.supersede_tx.send(());
        }

        // Pick up any data_tx that arrived before bind_control (race).
        let data_tx = self.pending_data.remove(&bot_id).map(|(_, tx)| {
            tracing::debug!(%bot_id, "bind_control picked up pending data_tx");
            tx
        });

        self.sessions.insert(
            bot_id,
            BotSession {
                connection_id: conn_id,
                control_tx: task_tx,
                data_tx,
                supersede_tx,
            },
        );

        supersede_rx
    }

    fn bind_data(&self, bot_id: Uuid, data_tx: mpsc::Sender<Value>) {
        if let Some(mut s) = self.sessions.get_mut(&bot_id) {
            s.data_tx = Some(data_tx);
            tracing::debug!(%bot_id, "bind_data attached to existing session");
        } else {
            tracing::debug!(%bot_id, "bind_data: session not ready, stashing");
            self.pending_data.insert(bot_id, data_tx);
        }
    }

    fn unbind(&self, bot_id: Uuid) {
        self.sessions.remove(&bot_id);
    }

    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid) {
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

    fn kick(&self, bot_id: Uuid) {
        // Same teardown as a supersede, minus the new session: drop the session
        // (so is_online → false, dispatch → false) and fire supersede_tx to close
        // the live control WS. Also clear any stashed pre-control data_tx.
        if let Some((_, old)) = self.sessions.remove(&bot_id) {
            let _ = old.supersede_tx.send(());
        }
        self.pending_data.remove(&bot_id);
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

    fn is_online(&self, bot_id: Uuid) -> bool {
        InProcessBotLocator::is_online(self, bot_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_tx() -> mpsc::Sender<Value> {
        let (tx, _rx) = mpsc::channel(1);
        tx
    }

    /// Race: the data WS can arrive before the control WS. The early data_tx
    /// must be stashed in `pending_data` and picked up by `bind_control`,
    /// otherwise the bot would never come online.
    #[test]
    fn bind_data_before_bind_control_is_not_lost() {
        let reg = InProcessBotLocator::new();
        let bot = Uuid::new_v4();

        // data WS arrives first: stashed, bot not online yet (no control session).
        reg.bind_data(bot, dummy_tx());
        assert!(!reg.is_online(bot), "bot must not be online with control session missing");

        // control WS arrives: it must adopt the stashed data_tx.
        let _supersede_rx = reg.bind_control(bot, Uuid::new_v4(), dummy_tx());
        assert!(reg.is_online(bot), "data_tx from the early data WS must survive the race");
    }

    /// Normal ordering: control first, then data. Bot is only online once both exist.
    #[test]
    fn bind_control_then_bind_data_comes_online() {
        let reg = InProcessBotLocator::new();
        let bot = Uuid::new_v4();

        let _supersede_rx = reg.bind_control(bot, Uuid::new_v4(), dummy_tx());
        assert!(!reg.is_online(bot), "control-only session is not yet online");

        reg.bind_data(bot, dummy_tx());
        assert!(reg.is_online(bot));
    }
}
