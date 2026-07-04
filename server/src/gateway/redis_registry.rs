/// Redis pub/sub 实现的 BotLocator + BotRegistry。
///
/// BotLocator（派发侧）:
///   dispatch_task  → PUBLISH cheers:bot:{bot_id}:control {task}
///   send_data      → PUBLISH cheers:bot:{bot_id}:data {frame}
///
/// BotRegistry（连接绑定侧，WS handler 调用）:
///   bind_control   → SUBSCRIBE cheers:bot:{bot_id}:control，spawn 转发任务 + 在线标记续期
///   bind_data      → SUBSCRIBE cheers:bot:{bot_id}:data，spawn 转发任务 + 在线标记续期
///   unbind         → 取消转发任务，DEL Redis 在线标记
///
/// 在线标记（跨实例的 liveness 真相）: 每条 WS 一个 key
///   cheers:bot:{bot_id}:online:control / :online:data，SET 1 EX 30，
///   由持有连接的实例每 10s 续期（3 次续期窗口容忍瞬时抖动）。
///   is_online = 两个 key 同时存在（与单实例「control + data 均绑定」语义对齐）；
///   派发前只查 control key（task 走 control WS）。
///   续期循环退出时不主动 DEL（新连接 supersede 旧连接时，旧循环的迟到 DEL 会把
///   刚上线的 bot 误标下线）——显式下线路径（unbind/kick）才 DEL，其余靠 TTL 过期。
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use super::registry::{BotLocator, BotRegistry};

/// 在线标记 TTL 与续期间隔：TTL 内可容忍 2 次续期失败。
const ONLINE_TTL_SECS: u64 = 30;
const ONLINE_REFRESH_SECS: u64 = 10;

fn control_subject(bot_id: Uuid) -> String {
    format!("cheers:bot:{bot_id}:control")
}
fn data_subject(bot_id: Uuid) -> String {
    format!("cheers:bot:{bot_id}:data")
}
fn control_online_key(bot_id: Uuid) -> String {
    format!("cheers:bot:{bot_id}:online:control")
}
fn data_online_key(bot_id: Uuid) -> String {
    format!("cheers:bot:{bot_id}:online:data")
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
        // 先检查 control 在线标记（避免无效 PUBLISH）
        if !keys_exist(&self.publisher, &[control_online_key(bot_id)]).await {
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

    async fn is_online(&self, bot_id: Uuid) -> bool {
        // 与单实例语义一致：control + data 双 WS 均在线才算在线。
        keys_exist(
            &self.publisher,
            &[control_online_key(bot_id), data_online_key(bot_id)],
        )
        .await
    }
}

// ── RedisBotRegistry（连接绑定侧）───────────────────────────────────────────

struct BotCancelTokens {
    /// 当前 control 连接标识（unbind_if_connection 的防误删守卫）。
    control_conn_id: Option<Uuid>,
    /// Drop to cancel the control forward_loop.
    control_cancel: Option<oneshot::Sender<()>>,
    /// Drop to cancel the control online-marker refresh loop.
    control_online_cancel: Option<oneshot::Sender<()>>,
    /// 当前 data 连接标识（unbind_data 的防误删守卫）。
    data_conn_id: Option<Uuid>,
    /// Drop to cancel the data forward_loop.
    data_cancel: Option<oneshot::Sender<()>>,
    /// Drop to cancel the data online-marker refresh loop.
    data_online_cancel: Option<oneshot::Sender<()>>,
    /// Send to notify old handler that a new control connection superseded it.
    supersede_tx: Option<oneshot::Sender<()>>,
}

pub struct RedisBotRegistry {
    client: redis::Client,
    publisher: redis::aio::ConnectionManager,
    cancel_map: dashmap::DashMap<Uuid, BotCancelTokens>,
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
    fn bind_control(
        &self,
        bot_id: Uuid,
        conn_id: Uuid,
        task_tx: mpsc::Sender<Value>,
    ) -> oneshot::Receiver<()> {
        (**self).bind_control(bot_id, conn_id, task_tx)
    }
    fn bind_data(&self, bot_id: Uuid, conn_id: Uuid, data_tx: mpsc::Sender<Value>) {
        (**self).bind_data(bot_id, conn_id, data_tx)
    }
    fn unbind(&self, bot_id: Uuid) {
        (**self).unbind(bot_id)
    }
    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid) {
        (**self).unbind_if_connection(bot_id, conn_id)
    }
    fn unbind_data(&self, bot_id: Uuid, conn_id: Uuid) {
        (**self).unbind_data(bot_id, conn_id)
    }
    fn kick(&self, bot_id: Uuid) {
        (**self).kick(bot_id)
    }
}

impl BotRegistry for RedisBotRegistry {
    fn bind_control(
        &self,
        bot_id: Uuid,
        conn_id: Uuid,
        task_tx: mpsc::Sender<Value>,
    ) -> oneshot::Receiver<()> {
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let (online_cancel_tx, online_cancel_rx) = oneshot::channel::<()>();
        let client = self.client.clone();

        tokio::spawn(refresh_online_loop(
            self.publisher.clone(),
            control_online_key(bot_id),
            online_cancel_rx,
        ));

        let (supersede_tx, supersede_rx) = oneshot::channel::<()>();

        tokio::spawn(forward_loop(
            client,
            control_subject(bot_id),
            task_tx,
            cancel_rx,
        ));

        // Preserve data bindings if bind_data arrived first (race).
        // Also signal supersede on the old control handler.
        let (data_conn_id, data_cancel, data_online_cancel) = self
            .cancel_map
            .remove(&bot_id)
            .map(|(_, old)| {
                if let Some(tx) = old.supersede_tx {
                    let _ = tx.send(());
                }
                (old.data_conn_id, old.data_cancel, old.data_online_cancel)
            })
            .unwrap_or((None, None, None));

        self.cancel_map.insert(
            bot_id,
            BotCancelTokens {
                control_conn_id: Some(conn_id),
                control_cancel: Some(cancel_tx),
                control_online_cancel: Some(online_cancel_tx),
                data_conn_id,
                data_cancel,
                data_online_cancel,
                supersede_tx: Some(supersede_tx),
            },
        );

        supersede_rx
    }

    fn bind_data(&self, bot_id: Uuid, conn_id: Uuid, data_tx: mpsc::Sender<Value>) {
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let (online_cancel_tx, online_cancel_rx) = oneshot::channel::<()>();
        let client = self.client.clone();

        tokio::spawn(refresh_online_loop(
            self.publisher.clone(),
            data_online_key(bot_id),
            online_cancel_rx,
        ));

        tokio::spawn(forward_loop(
            client,
            data_subject(bot_id),
            data_tx,
            cancel_rx,
        ));

        // Store data bindings; preserve existing control bindings if bind_control was first.
        if let Some(mut entry) = self.cancel_map.get_mut(&bot_id) {
            entry.data_conn_id = Some(conn_id);
            entry.data_cancel = Some(cancel_tx);
            entry.data_online_cancel = Some(online_cancel_tx);
        } else {
            self.cancel_map.insert(
                bot_id,
                BotCancelTokens {
                    control_conn_id: None,
                    control_cancel: None,
                    control_online_cancel: None,
                    data_conn_id: Some(conn_id),
                    data_cancel: Some(cancel_tx),
                    data_online_cancel: Some(online_cancel_tx),
                    supersede_tx: None,
                },
            );
        }
    }

    fn unbind(&self, bot_id: Uuid) {
        // 取消令牌 drop 时，forward_loop / refresh 循环会退出
        self.cancel_map.remove(&bot_id);
        // 清除在线标记
        del_keys_bg(
            self.publisher.clone(),
            vec![control_online_key(bot_id), data_online_key(bot_id)],
        );
    }

    fn unbind_if_connection(&self, bot_id: Uuid, conn_id: Uuid) {
        // 防误删：重连后旧 control socket 的迟到 cleanup 不能把新绑定打下线。
        let matches = self
            .cancel_map
            .get(&bot_id)
            .map(|e| e.control_conn_id == Some(conn_id))
            .unwrap_or(false);
        if matches {
            self.unbind(bot_id);
        }
    }

    fn unbind_data(&self, bot_id: Uuid, conn_id: Uuid) {
        // 只清自己的绑定（同 in-process 的守卫语义），并显式清 data 在线标记。
        let mut cleared = false;
        if let Some(mut entry) = self.cancel_map.get_mut(&bot_id) {
            if entry.data_conn_id == Some(conn_id) {
                entry.data_conn_id = None;
                entry.data_cancel = None;
                entry.data_online_cancel = None;
                cleared = true;
            }
        }
        if cleared {
            del_keys_bg(self.publisher.clone(), vec![data_online_key(bot_id)]);
        }
    }

    fn kick(&self, bot_id: Uuid) {
        // Fire supersede (closes the live control WS), drop the cancel tokens so the
        // forward/refresh loops exit, then clear the online markers.
        if let Some((_, tokens)) = self.cancel_map.remove(&bot_id) {
            if let Some(tx) = tokens.supersede_tx {
                let _ = tx.send(());
            }
        }
        del_keys_bg(
            self.publisher.clone(),
            vec![control_online_key(bot_id), data_online_key(bot_id)],
        );
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

/// 持有连接期间每 ONLINE_REFRESH_SECS 续期一次在线标记；cancel（sender drop）后
/// 直接退出、不 DEL——显式下线由 unbind/kick 负责，supersede 场景靠新循环续命。
async fn refresh_online_loop(
    mut conn: redis::aio::ConnectionManager,
    key: String,
    mut cancel: oneshot::Receiver<()>,
) {
    loop {
        let set: redis::RedisResult<()> = redis::cmd("SET")
            .arg(&key)
            .arg(1)
            .arg("EX")
            .arg(ONLINE_TTL_SECS)
            .query_async(&mut conn)
            .await;
        if let Err(e) = set {
            tracing::warn!(key, err = %e, "online marker refresh failed");
        }
        tokio::select! {
            _ = &mut cancel => break,
            _ = tokio::time::sleep(Duration::from_secs(ONLINE_REFRESH_SECS)) => {}
        }
    }
}

fn del_keys_bg(mut publisher: redis::aio::ConnectionManager, keys: Vec<String>) {
    tokio::spawn(async move {
        let mut cmd = redis::cmd("DEL");
        for key in &keys {
            cmd.arg(key);
        }
        let _: redis::RedisResult<()> = cmd.query_async(&mut publisher).await;
    });
}

/// EXISTS 返回存在的 key 个数——要求全部存在。
async fn keys_exist(conn: &redis::aio::ConnectionManager, keys: &[String]) -> bool {
    let mut c = conn.clone();
    let mut cmd = redis::cmd("EXISTS");
    for key in keys {
        cmd.arg(key);
    }
    let exists: redis::RedisResult<i64> = cmd.query_async(&mut c).await;
    exists.unwrap_or(0) == keys.len() as i64
}
