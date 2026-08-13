use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use dashmap::DashMap;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

/// Bound on how long `dispatch_task`/`send_data` wait for room in a bot's
/// bounded control/data queue before giving up (#330: a `try_send`-on-first-
/// attempt policy silently dropped prompts whenever a burst of rapid sends —
/// or unrelated cancel/claim frames sharing the same queue — left it momentarily
/// full, even though it drains in milliseconds under normal operation). This
/// keeps a hard cap so a truly stuck/dead connection still reports offline
/// promptly instead of hanging the caller (which, for `dispatch_task`, is the
/// same request that just persisted and is about to return the user's message).
const QUEUE_SEND_TIMEOUT: Duration = Duration::from_millis(500);

// ── Trait 定义（可替换实现的接口）────────────────────────────────────────────

/// 【业务层接口】向 bot 派发任务 / 发送数据帧。
/// 单实例：InProcessBotLocator。多实例：RedisBotLocator。
#[async_trait]
pub trait BotLocator: Send + Sync {
    async fn dispatch_task(&self, bot_id: Uuid, task: Value) -> bool;
    async fn send_data(&self, bot_id: Uuid, frame: Value) -> bool;
    /// True when the bot has both a control and a data WS bound (can receive pushes).
    /// Async because the multi-instance impl has to ask Redis (the connection may
    /// live on another gateway replica).
    async fn is_online(&self, bot_id: Uuid) -> bool;
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

    fn bind_data(&self, bot_id: Uuid, conn_id: Uuid, data_tx: mpsc::Sender<Value>);

    /// 完整移除 bot 的 session（正常断线清理）。
    fn unbind(&self, bot_id: Uuid);

    /// 仅当 conn_id 匹配时才移除（防止新连接的 session 被旧连接 cleanup 误删）。
    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid);

    /// data WS 断线时清除 data_tx，保留 control session。仅当 conn_id 与当前
    /// 绑定的 data 连接匹配才清（同 unbind_if_connection 的防误删语义：迟到的
    /// 旧 data socket cleanup 不能把重连后的新绑定打下线）。
    fn unbind_data(&self, bot_id: Uuid, conn_id: Uuid);

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
    /// data WS 的发送端（发 permission/workspace 等帧）+ 其连接标识（防旧连接误清）
    data_tx: Option<(Uuid, mpsc::Sender<Value>)>,
    /// 当新连接 supersede 此 session 时，向旧 WS 发取消信号
    supersede_tx: oneshot::Sender<()>,
}

// ── 进程内实现 ────────────────────────────────────────────────────────────────

pub struct InProcessBotLocator {
    sessions: DashMap<Uuid, BotSession>,
    /// data_tx that arrived before the control session was created.
    /// bind_control picks these up so they are not lost to the race.
    pending_data: DashMap<Uuid, (Uuid, mpsc::Sender<Value>)>,
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
        let data_tx = self.pending_data.remove(&bot_id).map(|(_, bound)| {
            tracing::debug!(%bot_id, "bind_control picked up pending data_tx");
            bound
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

    fn bind_data(&self, bot_id: Uuid, conn_id: Uuid, data_tx: mpsc::Sender<Value>) {
        if let Some(mut s) = self.sessions.get_mut(&bot_id) {
            s.data_tx = Some((conn_id, data_tx));
            tracing::debug!(%bot_id, "bind_data attached to existing session");
        } else {
            tracing::debug!(%bot_id, "bind_data: session not ready, stashing");
            self.pending_data.insert(bot_id, (conn_id, data_tx));
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

    fn unbind_data(&self, bot_id: Uuid, conn_id: Uuid) {
        // 只清自己的绑定：重连后旧 data socket 的迟到 cleanup 不能打掉新绑定。
        if let Some(mut s) = self.sessions.get_mut(&bot_id) {
            if s.data_tx.as_ref().is_some_and(|(id, _)| *id == conn_id) {
                s.data_tx = None;
            }
        }
        // pending 栈里同理（data 先到、control 未到期间断线）。
        self.pending_data
            .remove_if(&bot_id, |_, (id, _)| *id == conn_id);
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
        // Clone the sender and drop the DashMap guard before awaiting: holding a
        // shard guard across `.await` would block unrelated bind/unbind calls for
        // other bots on the same shard for the full wait.
        let Some(tx) = self.sessions.get(&bot_id).map(|s| s.control_tx.clone()) else {
            return false;
        };
        tokio::time::timeout(QUEUE_SEND_TIMEOUT, tx.send(task))
            .await
            .is_ok_and(|r| r.is_ok())
    }

    async fn send_data(&self, bot_id: Uuid, frame: Value) -> bool {
        let Some(tx) = self
            .sessions
            .get(&bot_id)
            .and_then(|s| s.data_tx.as_ref().map(|(_, tx)| tx.clone()))
        else {
            return false;
        };
        tokio::time::timeout(QUEUE_SEND_TIMEOUT, tx.send(frame))
            .await
            .is_ok_and(|r| r.is_ok())
    }

    async fn is_online(&self, bot_id: Uuid) -> bool {
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
        reg.bind_data(bot, Uuid::new_v4(), dummy_tx());
        assert!(
            !reg.is_online(bot),
            "bot must not be online with control session missing"
        );

        // control WS arrives: it must adopt the stashed data_tx.
        let _supersede_rx = reg.bind_control(bot, Uuid::new_v4(), dummy_tx());
        assert!(
            reg.is_online(bot),
            "data_tx from the early data WS must survive the race"
        );
    }

    /// Normal ordering: control first, then data. Bot is only online once both exist.
    #[test]
    fn bind_control_then_bind_data_comes_online() {
        let reg = InProcessBotLocator::new();
        let bot = Uuid::new_v4();

        let _supersede_rx = reg.bind_control(bot, Uuid::new_v4(), dummy_tx());
        assert!(
            !reg.is_online(bot),
            "control-only session is not yet online"
        );

        reg.bind_data(bot, Uuid::new_v4(), dummy_tx());
        assert!(reg.is_online(bot));
    }

    /// Reconnect race: the OLD data socket's late cleanup must not clobber the
    /// NEW connection's data binding (which would flip an online bot to offline).
    #[test]
    fn stale_unbind_data_does_not_clobber_new_binding() {
        let reg = InProcessBotLocator::new();
        let bot = Uuid::new_v4();
        let old_data_conn = Uuid::new_v4();
        let new_data_conn = Uuid::new_v4();

        // Old connection pair comes up…
        let _old_rx = reg.bind_control(bot, Uuid::new_v4(), dummy_tx());
        reg.bind_data(bot, old_data_conn, dummy_tx());
        // …silently dies; the bot reconnects (new control supersedes, new data binds).
        let _new_rx = reg.bind_control(bot, Uuid::new_v4(), dummy_tx());
        reg.bind_data(bot, new_data_conn, dummy_tx());
        assert!(reg.is_online(bot));

        // The server finally notices the old data socket died: guarded no-op.
        reg.unbind_data(bot, old_data_conn);
        assert!(
            reg.is_online(bot),
            "stale cleanup must not take the bot offline"
        );

        // The real (new) data socket closing does unbind.
        reg.unbind_data(bot, new_data_conn);
        assert!(!reg.is_online(bot));
    }
}
