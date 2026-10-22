use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use tokio::sync::mpsc;
use uuid::Uuid;

pub use super::frame::WireFrame;

/// Why the server is closing a browser connection out-of-band (via the per-conn
/// close signal registered in `register_user`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// A terminal frame couldn't be enqueued (I6) — close so the client falls
    /// back to REST instead of silently missing a final state.
    Backpressure,
    /// The user's sessions were revoked (logout / password change / suspend /
    /// delete) — close so the stale-token socket dies now, not at disconnect.
    Revoked,
}

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

    /// Close every live browser WS connection belonging to `user_id` (session
    /// revocation: logout / password change / suspend / delete). Default no-op
    /// so a kick-unaware transport degrades to "revoked at next re-auth" rather
    /// than erroring; both real impls override — InProcessFanout closes the
    /// user's connections, RedisFanout kicks its LOCAL connections only
    /// (cross-instance propagation over pub/sub is pending the R1-B/M4 HA
    /// work; the Redis path is not wired in main.rs today).
    fn kick_user(&self, _user_id: Uuid) {}

    /// Close only this exact authenticated session's browser connections. Real
    /// browser transports override this; event-only fanouts own no connections.
    fn kick_session(&self, _user_id: Uuid, _session_id: &str) {}

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
    /// conn_id → 服务端主动关闭信号端。背压（I6，终态帧入队失败 → 4408）与
    /// 会话吊销（kick_user → 4401）都走这里，reason 决定关闭码。
    closers: DashMap<Uuid, mpsc::Sender<CloseReason>>,
    /// conn_id → user_id。用于把频道订阅（按 conn 记录）映射回在线用户，
    /// 供 presence 广播使用。
    conn_users: DashMap<Uuid, ConnIdentity>,
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

struct ConnIdentity {
    user_id: Uuid,
    session_id: String,
    closing: bool,
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

    /// 浏览器 WS 连接建立后，注册 user 级发送端及服务端关闭信号端。
    pub fn register_user(
        &self,
        user_id: Uuid,
        session_id: &str,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<CloseReason>,
    ) {
        self.closers.insert(conn_id, close_tx);
        self.conn_users.insert(
            conn_id,
            ConnIdentity {
                user_id,
                session_id: session_id.to_owned(),
                closing: false,
            },
        );
        self.users
            .entry(user_id)
            .or_default()
            .push(ConnSender { conn_id, tx });
    }

    /// A same-user re-auth may move this connection to another live session.
    /// Rebind and kick share the identity entry guard: an earlier kick wins,
    /// while a later kick of the old session cannot close the new binding.
    pub fn rebind_session(&self, user_id: Uuid, conn_id: Uuid, session_id: &str) -> bool {
        let Some(mut identity) = self.conn_users.get_mut(&conn_id) else {
            return false;
        };
        if identity.user_id != user_id || identity.closing {
            return false;
        }
        identity.session_id = session_id.to_owned();
        true
    }

    /// 频道当前在线的去重用户列表（按 conn 订阅映射回 user_id）。
    pub fn channel_online_users(&self, channel_id: Uuid) -> Vec<Uuid> {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        if let Some(senders) = self.channels.get(&channel_id) {
            for s in senders.value() {
                if let Some(identity) = self.conn_users.get(&s.conn_id) {
                    if !identity.closing && seen.insert(identity.user_id) {
                        out.push(identity.user_id);
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
            let Some(identity) = self.conn_users.get(&s.conn_id) else {
                continue;
            };
            if identity.closing {
                continue;
            }
            // Do not upgrade the entry guard while the read guard is retained.
            let full = matches!(
                s.tx.try_send(frame.clone()),
                Err(mpsc::error::TrySendError::Full(_))
            );
            drop(identity);
            if full && terminal {
                if let Some(mut identity) = self.conn_users.get_mut(&s.conn_id) {
                    identity.closing = true;
                    if let Some(closer) = self.closers.get(&s.conn_id) {
                        let _ = closer.try_send(CloseReason::Backpressure);
                    }
                }
            }
        }
    }

    /// 会话吊销：给该用户所有在线连接发关闭信号（写循环以 4401 收尾）。
    /// 见 `Fanout::kick_user`。
    pub fn kick_user(&self, user_id: Uuid) {
        self.kick_matching(user_id, None);
    }

    pub fn kick_session(&self, user_id: Uuid, session_id: &str) {
        self.kick_matching(user_id, Some(session_id));
    }

    fn kick_matching(&self, user_id: Uuid, session_id: Option<&str>) {
        if let Some(senders) = self.users.get(&user_id) {
            for s in senders.iter() {
                if let Some(mut identity) = self.conn_users.get_mut(&s.conn_id) {
                    if identity.user_id == user_id
                        && session_id.is_none_or(|sid| identity.session_id == sid)
                    {
                        identity.closing = true;
                        if let Some(closer) = self.closers.get(&s.conn_id) {
                            let _ = closer.try_send(CloseReason::Revoked);
                        }
                    }
                }
            }
        }
    }

    /// 浏览器订阅某频道后，注册 channel 级发送端。
    pub fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        let mut senders = self.channels.entry(channel_id).or_default();
        senders.retain(|sender| sender.conn_id != conn_id);
        senders.push(ConnSender { conn_id, tx });
    }

    /// 浏览器退订某频道或断线时，移除对应发送端。
    pub fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid) {
        if let Some(mut senders) = self.channels.get_mut(&channel_id) {
            senders.retain(|s| s.conn_id != conn_id);
        }
        self.conn_focus
            .remove_if(&conn_id, |_, focus| focus.channel_id == channel_id);
    }

    /// 成员资格被撤销（管理员移除 / 自己退出）：把该用户的**所有**连接从该频道
    /// 的订阅表移除，新消息立即停止投递。订阅时查成员资格（subscribe），这是它
    /// 的反向边。
    pub fn unsubscribe_user_channel(&self, channel_id: Uuid, user_id: Uuid) {
        if let Some(mut senders) = self.channels.get_mut(&channel_id) {
            senders.retain(|s| {
                self.conn_users
                    .get(&s.conn_id)
                    .map(|identity| identity.user_id != user_id)
                    .unwrap_or(true)
            });
        }
        self.conn_focus.retain(|conn_id, focus| {
            focus.channel_id != channel_id
                || self
                    .conn_users
                    .get(conn_id)
                    .map(|identity| identity.user_id != user_id)
                    .unwrap_or(true)
        });
    }

    /// 频道被删除：丢弃整张订阅表（否则残留到各连接断线为止）。
    pub fn drop_channel(&self, channel_id: Uuid) {
        self.channels.remove(&channel_id);
        self.conn_focus
            .retain(|_, focus| focus.channel_id != channel_id);
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

    /// 频道内已订阅连接的在看焦点：`(user_id, bot_id, path)`。经 conn_users 映射回 user_id。
    /// 不去重（同一用户多连接可重复；前端去重）。
    pub fn channel_focus(&self, channel_id: Uuid) -> Vec<(Uuid, Uuid, Option<String>)> {
        let Some(subscribers) = self.channels.get(&channel_id) else {
            return Vec::new();
        };
        let subscribed: std::collections::HashSet<Uuid> =
            subscribers.iter().map(|sender| sender.conn_id).collect();
        drop(subscribers);
        let mut out = Vec::new();
        for entry in self.conn_focus.iter() {
            let focus = entry.value();
            if focus.channel_id != channel_id || !subscribed.contains(entry.key()) {
                continue;
            }
            if let Some(identity) = self.conn_users.get(entry.key()) {
                if !identity.closing {
                    out.push((identity.user_id, focus.bot_id, focus.path.clone()));
                }
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
                        .map(|identity| !identity.closing && allow.contains(&identity.user_id))
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

    fn kick_user(&self, user_id: Uuid) {
        InProcessFanout::kick_user(self, user_id);
    }

    fn kick_session(&self, user_id: Uuid, session_id: &str) {
        InProcessFanout::kick_session(self, user_id, session_id);
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
    ) -> (mpsc::Receiver<WireFrame>, mpsc::Receiver<CloseReason>) {
        let conn = Uuid::new_v4();
        let (tx, rx) = mpsc::channel::<WireFrame>(1);
        let (close_tx, close_rx) = mpsc::channel::<CloseReason>(1);
        fanout.register_user(user, &Uuid::new_v4().to_string(), conn, tx, close_tx);
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

    /// 会话吊销：kick_user 给该用户的每条连接发 Revoked 关闭信号，且不波及他人。
    #[tokio::test]
    async fn kick_user_signals_all_of_that_users_conns_only() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let other = Uuid::new_v4();
        let (_rx1, mut close_rx1) = full_conn(&fanout, user);
        let (_rx2, mut close_rx2) = full_conn(&fanout, user);
        let (_rx3, mut close_rx3) = full_conn(&fanout, other);

        fanout.kick_user(user);

        assert_eq!(close_rx1.try_recv(), Ok(CloseReason::Revoked));
        assert_eq!(close_rx2.try_recv(), Ok(CloseReason::Revoked));
        assert!(close_rx3.try_recv().is_err(), "其他用户的连接不受影响");
    }

    #[tokio::test]
    async fn session_kick_matches_both_user_and_session_without_stopping_other_delivery() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let other = Uuid::new_v4();
        let session = Uuid::new_v4().to_string();
        let other_session = Uuid::new_v4().to_string();
        let mut receivers = Vec::new();
        for (owner, sid) in [(user, &session), (user, &other_session), (other, &session)] {
            let conn = Uuid::new_v4();
            let (tx, rx) = mpsc::channel(2);
            let (close_tx, close_rx) = mpsc::channel(1);
            fanout.register_user(owner, sid, conn, tx, close_tx);
            receivers.push((rx, close_rx));
        }
        fanout.kick_session(user, &session);
        assert_eq!(receivers[0].1.try_recv(), Ok(CloseReason::Revoked));
        assert!(receivers[1].1.try_recv().is_err());
        assert!(receivers[2].1.try_recv().is_err());
        fanout.broadcast_user(user, frame("message")).await;
        assert!(receivers[0].0.try_recv().is_err());
        assert!(receivers[1].0.try_recv().is_ok());
    }

    #[tokio::test]
    async fn rebind_before_old_session_kick_preserves_the_new_binding() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let conn = Uuid::new_v4();
        let old_session = Uuid::new_v4().to_string();
        let new_session = Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::channel(2);
        let (close_tx, mut close_rx) = mpsc::channel(1);
        fanout.register_user(user, &old_session, conn, tx, close_tx);
        assert!(!fanout.rebind_session(Uuid::new_v4(), conn, &new_session));
        assert!(fanout.rebind_session(user, conn, &new_session));
        fanout.kick_session(user, &old_session);
        assert!(close_rx.try_recv().is_err());
        fanout.broadcast_user(user, frame("message")).await;
        assert!(rx.try_recv().is_ok());
        fanout.kick_session(user, &new_session);
        assert_eq!(close_rx.try_recv(), Ok(CloseReason::Revoked));
    }

    #[tokio::test]
    async fn session_kick_before_rebind_cannot_be_undone_by_late_authentication() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let conn = Uuid::new_v4();
        let old_session = Uuid::new_v4().to_string();
        let (tx, _rx) = mpsc::channel(1);
        let (close_tx, mut close_rx) = mpsc::channel(1);
        fanout.register_user(user, &old_session, conn, tx, close_tx);
        fanout.kick_session(user, &old_session);
        assert!(!fanout.rebind_session(user, conn, &Uuid::new_v4().to_string()));
        assert_eq!(close_rx.try_recv(), Ok(CloseReason::Revoked));
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
        let (close_tx, _close_rx) = mpsc::channel::<CloseReason>(1);
        fanout.register_user(
            user,
            &Uuid::new_v4().to_string(),
            conn,
            tx.clone(),
            close_tx,
        );
        fanout.subscribe_channel(channel, conn, tx);

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
        let (close_tx, _close_rx) = mpsc::channel::<CloseReason>(1);
        fanout.register_user(
            user,
            &Uuid::new_v4().to_string(),
            conn,
            tx.clone(),
            close_tx,
        );
        fanout.subscribe_channel(channel, conn, tx);
        fanout.set_focus(conn, channel, Uuid::new_v4(), None);
        assert_eq!(fanout.channel_focus(channel).len(), 1);
        fanout.clear_focus(conn);
        assert!(fanout.channel_focus(channel).is_empty());
    }

    #[tokio::test]
    async fn focus_requires_a_live_subscription_and_keeps_other_channels_independent() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let conn = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let other = Uuid::new_v4();
        let (tx, _rx) = mpsc::channel::<WireFrame>(1);
        let (close_tx, _close_rx) = mpsc::channel::<CloseReason>(1);
        fanout.register_user(
            user,
            &Uuid::new_v4().to_string(),
            conn,
            tx.clone(),
            close_tx,
        );
        fanout.set_focus(conn, channel, Uuid::new_v4(), None);
        assert!(fanout.channel_focus(channel).is_empty());

        fanout.subscribe_channel(channel, conn, tx.clone());
        fanout.subscribe_channel(other, conn, tx.clone());
        assert_eq!(fanout.channel_focus(channel).len(), 1);
        fanout.subscribe_channel(channel, conn, tx.clone());
        assert_eq!(fanout.channel_focus(channel).len(), 1);
        fanout.unsubscribe_channel(other, conn);
        assert_eq!(fanout.channel_focus(channel).len(), 1);
        fanout.unsubscribe_channel(channel, conn);
        assert!(fanout.channel_focus(channel).is_empty());

        fanout.subscribe_channel(channel, conn, tx.clone());
        assert!(fanout.channel_focus(channel).is_empty());
        fanout.set_focus(conn, channel, Uuid::new_v4(), None);
        fanout.unsubscribe_user_channel(channel, user);
        assert!(fanout.channel_focus(channel).is_empty());
        fanout.subscribe_channel(channel, conn, tx.clone());
        assert!(fanout.channel_focus(channel).is_empty());
        fanout.set_focus(conn, channel, Uuid::new_v4(), None);
        fanout.drop_channel(channel);
        assert!(fanout.channel_focus(channel).is_empty());
        fanout.subscribe_channel(channel, conn, tx);
        assert!(fanout.channel_focus(channel).is_empty());
    }

    /// 断线注销后清掉关闭信号端，不泄漏。
    #[tokio::test]
    async fn deregister_drops_closer() {
        let fanout = InProcessFanout::new();
        let user = Uuid::new_v4();
        let conn = Uuid::new_v4();
        let (tx, _rx) = mpsc::channel::<WireFrame>(1);
        let (close_tx, _close_rx) = mpsc::channel::<CloseReason>(1);
        fanout.register_user(user, &Uuid::new_v4().to_string(), conn, tx, close_tx);
        assert!(fanout.closers.contains_key(&conn));
        fanout.deregister_user(user, conn);
        assert!(!fanout.closers.contains_key(&conn));
    }
}
