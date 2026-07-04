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

    /// Broadcast to a channel, but only to connections whose user is in
    /// `allowed_users` — the live per-subscriber SEE filter (the caller computes
    /// the allowed set from bot_event_policy). Used for agent-produced events
    /// (bot traces, permission cards). Default impl falls back to a full broadcast,
    /// so a SEE-unaware transport never silently *drops* an event.
    async fn broadcast_channel_to_users(
        &self,
        channel_id: Uuid,
        frame: WireFrame,
        allowed_users: Vec<Uuid>,
    ) {
        let _ = &allowed_users;
        self.broadcast_channel(channel_id, frame).await;
    }

    /// 广播给指定用户的所有连接（未读通知等 user 级事件）。
    async fn broadcast_user(&self, user_id: Uuid, frame: WireFrame);

    /// 频道当前在线用户列表（presence）。默认空；进程内实现覆盖。
    fn online_users(&self, _channel_id: Uuid) -> Vec<Uuid> {
        Vec::new()
    }

    /// 工作台在看焦点：记录某连接正在查看哪个 bot 的工作区（可含路径）。
    /// 默认空实现；进程内实现覆盖。
    fn set_focus(&self, _conn_id: Uuid, _channel_id: Uuid, _bot_id: Uuid, _path: Option<String>) {}

    /// 清除某连接的在看焦点（退订、清焦点或断线）。默认空；进程内实现覆盖。
    fn clear_focus(&self, _conn_id: Uuid) {}

    /// 频道内所有在看焦点：`(user_id, bot_id, path)`，随 presence 快照下发。
    /// 不去重（同一用户多连接可重复；前端去重）。默认空；进程内实现覆盖。
    fn channel_focus(&self, _channel_id: Uuid) -> Vec<(Uuid, Uuid, Option<String>)> {
        Vec::new()
    }
}

// ── 进程内实现 ────────────────────────────────────────────────────────────────

/// 单进程 fan-out。每条浏览器 WS 连接持有一个 `mpsc::Sender<WireFrame>`，
/// 注册时把 Sender 存入 DashMap，断线时移除。
pub struct InProcessFanout {
    /// channel_id → 订阅该频道的所有连接的发送端
    channels: DashMap<Uuid, Vec<ConnSender>>,
    /// user_id → 该用户的所有连接的发送端
    users: DashMap<Uuid, Vec<ConnSender>>,
    /// conn_id → 背压关闭信号端（I6）。终态帧入队失败时触发，
    /// 让该连接的写循环以 4408 关闭，客户端转 REST 补齐。
    closers: DashMap<Uuid, mpsc::Sender<()>>,
    /// conn_id → user_id。用于把频道订阅（按 conn 记录）映射回在线用户，
    /// 供 presence 广播使用。
    conn_users: DashMap<Uuid, Uuid>,
    /// conn_id → 工作台在看焦点。某连接当前正在查看哪个 bot 的工作区（可含路径），
    /// 随 presence 快照下发，供 UI 显示「X 也在看 src/…」。断线自动清除（镜像 conn_users）。
    conn_focus: DashMap<Uuid, FocusEntry>,
}

/// 一个连接的工作台「在看焦点」。
#[derive(Clone)]
struct FocusEntry {
    channel_id: Uuid,
    bot_id: Uuid,
    path: Option<String>,
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
            closers: DashMap::new(),
            conn_users: DashMap::new(),
            conn_focus: DashMap::new(),
        })
    }

    /// 浏览器 WS 连接建立后，注册 user 级发送端及背压关闭信号端。
    pub fn register_user(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<()>,
    ) {
        self.closers.insert(conn_id, close_tx);
        self.conn_users.insert(conn_id, user_id);
        self.users
            .entry(user_id)
            .or_default()
            .push(ConnSender { conn_id, tx });
    }

    /// 频道当前在线的去重用户列表（按 conn 订阅映射回 user_id）。
    pub fn channel_online_users(&self, channel_id: Uuid) -> Vec<Uuid> {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        if let Some(senders) = self.channels.get(&channel_id) {
            for s in senders.value() {
                if let Some(uid) = self.conn_users.get(&s.conn_id) {
                    if seen.insert(*uid) {
                        out.push(*uid);
                    }
                }
            }
        }
        out
    }

    /// 向一组连接投递一帧。流式帧队列满时静默丢弃（靠 message_done 自愈）；
    /// 终态帧队列满时不丢，触发该连接的背压关闭信号（I6）。
    fn deliver(&self, senders: &[ConnSender], frame: &WireFrame) {
        let terminal = frame.is_terminal();
        for s in senders.iter() {
            if let Err(mpsc::error::TrySendError::Full(_)) = s.tx.try_send(frame.clone()) {
                if terminal {
                    if let Some(closer) = self.closers.get(&s.conn_id) {
                        let _ = closer.try_send(());
                    }
                }
            }
        }
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

    /// 浏览器断线时，移除该连接的所有注册（含关闭信号端）。
    pub fn deregister_user(&self, user_id: Uuid, conn_id: Uuid) {
        if let Some(mut senders) = self.users.get_mut(&user_id) {
            senders.retain(|s| s.conn_id != conn_id);
        }
        self.closers.remove(&conn_id);
        self.conn_users.remove(&conn_id);
        // 断线自动清焦点，镜像 conn_users 生命周期，避免遗留幽灵在看态。
        self.conn_focus.remove(&conn_id);
    }

    /// 记录/替换某连接的工作台在看焦点。
    pub fn set_focus(&self, conn_id: Uuid, channel_id: Uuid, bot_id: Uuid, path: Option<String>) {
        self.conn_focus.insert(
            conn_id,
            FocusEntry {
                channel_id,
                bot_id,
                path,
            },
        );
    }

    /// 清除某连接的在看焦点。
    pub fn clear_focus(&self, conn_id: Uuid) {
        self.conn_focus.remove(&conn_id);
    }

    /// 频道内所有在看焦点：`(user_id, bot_id, path)`。经 conn_users 映射回 user_id。
    /// 不去重（同一用户多连接可重复；前端去重）。
    pub fn channel_focus(&self, channel_id: Uuid) -> Vec<(Uuid, Uuid, Option<String>)> {
        let mut out = Vec::new();
        for entry in self.conn_focus.iter() {
            let focus = entry.value();
            if focus.channel_id != channel_id {
                continue;
            }
            if let Some(uid) = self.conn_users.get(entry.key()) {
                out.push((*uid, focus.bot_id, focus.path.clone()));
            }
        }
        out
    }
}

impl Default for InProcessFanout {
    fn default() -> Self {
        Self {
            channels: DashMap::new(),
            users: DashMap::new(),
            closers: DashMap::new(),
            conn_users: DashMap::new(),
            conn_focus: DashMap::new(),
        }
    }
}

#[async_trait]
impl Fanout for InProcessFanout {
    async fn broadcast_channel(&self, channel_id: Uuid, frame: WireFrame) {
        if let Some(senders) = self.channels.get(&channel_id) {
            self.deliver(senders.value(), &frame);
        }
    }

    async fn broadcast_channel_to_users(
        &self,
        channel_id: Uuid,
        frame: WireFrame,
        allowed_users: Vec<Uuid>,
    ) {
        use std::collections::HashSet;
        let allow: HashSet<Uuid> = allowed_users.into_iter().collect();
        if let Some(senders) = self.channels.get(&channel_id) {
            let filtered: Vec<ConnSender> = senders
                .value()
                .iter()
                .filter(|s| {
                    self.conn_users
                        .get(&s.conn_id)
                        .map(|u| allow.contains(&*u))
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            self.deliver(&filtered, &frame);
        }
    }

    async fn broadcast_user(&self, user_id: Uuid, frame: WireFrame) {
        if let Some(senders) = self.users.get(&user_id) {
            self.deliver(senders.value(), &frame);
        }
    }

    fn online_users(&self, channel_id: Uuid) -> Vec<Uuid> {
        self.channel_online_users(channel_id)
    }

    fn set_focus(&self, conn_id: Uuid, channel_id: Uuid, bot_id: Uuid, path: Option<String>) {
        InProcessFanout::set_focus(self, conn_id, channel_id, bot_id, path);
    }

    fn clear_focus(&self, conn_id: Uuid) {
        InProcessFanout::clear_focus(self, conn_id);
    }

    fn channel_focus(&self, channel_id: Uuid) -> Vec<(Uuid, Uuid, Option<String>)> {
        InProcessFanout::channel_focus(self, channel_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(frame_type: &str) -> WireFrame {
        WireFrame::channel(Uuid::new_v4(), frame_type, json!({}))
    }

    /// 注册一个永不被消费、容量 1 的连接队列，并返回其关闭信号接收端。
    fn full_conn(
        fanout: &InProcessFanout,
        user: Uuid,
    ) -> (mpsc::Receiver<WireFrame>, mpsc::Receiver<()>) {
        let conn = Uuid::new_v4();
        let (tx, rx) = mpsc::channel::<WireFrame>(1);
        let (close_tx, close_rx) = mpsc::channel::<()>(1);
        fanout.register_user(user, conn, tx, close_tx);
        (rx, close_rx)
    }

    /// I6 / R3：队列满时广播终态帧 → 触发该连接背压关闭信号（不静默丢弃）。
    #[tokio::test]
    async fn terminal_frame_on_full_queue_signals_close() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        // _rx 不消费——队列保持满。
        let (_rx, mut close_rx) = full_conn(&fanout, user);

        fanout.broadcast_user(user, frame("message")).await; // 占满容量 1 的槽
        fanout.broadcast_user(user, frame("message_done")).await; // 满 → 应触发关闭

        assert!(
            close_rx.try_recv().is_ok(),
            "终态帧入队失败必须触发背压关闭信号"
        );
    }

    /// 流式帧队列满时静默丢弃，不触发关闭（靠 message_done 自愈）。
    #[tokio::test]
    async fn streaming_frame_on_full_queue_does_not_close() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let (_rx, mut close_rx) = full_conn(&fanout, user);

        fanout.broadcast_user(user, frame("message_stream")).await; // 占满
        fanout.broadcast_user(user, frame("message_stream")).await; // 满 → 静默丢弃

        assert!(close_rx.try_recv().is_err(), "流式帧丢弃不应触发关闭");
    }

    /// 焦点生命周期：set_focus 后 channel_focus 映射回 user_id；断线自动清除。
    #[tokio::test]
    async fn focus_set_reported_and_cleared_on_deregister() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let conn = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let bot = Uuid::new_v4();
        let (tx, _rx) = mpsc::channel::<WireFrame>(1);
        let (close_tx, _close_rx) = mpsc::channel::<()>(1);
        fanout.register_user(user, conn, tx, close_tx);

        fanout.set_focus(conn, channel, bot, Some("src/lib.rs".into()));
        let focus = fanout.channel_focus(channel);
        assert_eq!(focus.len(), 1);
        assert_eq!(focus[0], (user, bot, Some("src/lib.rs".to_string())));
        // 另一个频道看不到该焦点。
        assert!(fanout.channel_focus(Uuid::new_v4()).is_empty());

        // 断线自动清焦点。
        fanout.deregister_user(user, conn);
        assert!(fanout.channel_focus(channel).is_empty());
    }

    /// clear_focus 显式清除某连接的在看态。
    #[tokio::test]
    async fn clear_focus_removes_entry() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let conn = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let (tx, _rx) = mpsc::channel::<WireFrame>(1);
        let (close_tx, _close_rx) = mpsc::channel::<()>(1);
        fanout.register_user(user, conn, tx, close_tx);
        fanout.set_focus(conn, channel, Uuid::new_v4(), None);
        assert_eq!(fanout.channel_focus(channel).len(), 1);
        fanout.clear_focus(conn);
        assert!(fanout.channel_focus(channel).is_empty());
    }

    /// 断线注销后清掉关闭信号端，不泄漏。
    #[tokio::test]
    async fn deregister_drops_closer() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let conn = Uuid::new_v4();
        let (tx, _rx) = mpsc::channel::<WireFrame>(1);
        let (close_tx, _close_rx) = mpsc::channel::<()>(1);
        fanout.register_user(user, conn, tx, close_tx);
        assert!(fanout.closers.contains_key(&conn));
        fanout.deregister_user(user, conn);
        assert!(!fanout.closers.contains_key(&conn));
    }
}
