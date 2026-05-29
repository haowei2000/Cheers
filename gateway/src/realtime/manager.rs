use std::{sync::Arc, time::Duration};

use dashmap::DashMap;
use lru::LruCache;
use sqlx::PgPool;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use super::fanout::{InProcessFanout, WireFrame};

// ── 成员资格缓存 ──────────────────────────────────────────────────────────────

/// 进程内短 TTL 缓存，避免每次 subscribe 帧都查 PG。
/// key = (user_id, channel_id)，value = (is_member, expires_at)
struct MembershipCache {
    inner: Mutex<LruCache<(Uuid, Uuid), (bool, tokio::time::Instant)>>,
    ttl: Duration,
}

impl MembershipCache {
    fn new(ttl_secs: u64) -> Self {
        Self {
            inner: Mutex::new(LruCache::new(
                std::num::NonZeroUsize::new(4096).unwrap(),
            )),
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    async fn get(&self, key: (Uuid, Uuid)) -> Option<bool> {
        let mut cache = self.inner.lock().await;
        if let Some((is_member, expires_at)) = cache.get(&key) {
            if tokio::time::Instant::now() < *expires_at {
                return Some(*is_member);
            }
            cache.pop(&key);
        }
        None
    }

    async fn set(&self, key: (Uuid, Uuid), is_member: bool) {
        let mut cache = self.inner.lock().await;
        cache.put(key, (is_member, tokio::time::Instant::now() + self.ttl));
    }

    /// 成员变更时主动失效（踢人/退群即时生效）。
    pub async fn evict(&self, user_id: Uuid, channel_id: Uuid) {
        let mut cache = self.inner.lock().await;
        cache.pop(&(user_id, channel_id));
    }
}

// ── ConnectionManager ─────────────────────────────────────────────────────────

/// 浏览器 WS 连接管理器。
///
/// 职责：
/// - 维护 conn_id → 发送队列
/// - 处理 subscribe/unsubscribe，含成员资格缓存
/// - 成员变更时主动失效缓存（同进程内调用）
pub struct ConnectionManager {
    fanout: Arc<InProcessFanout>,
    membership_cache: MembershipCache,
    db: PgPool,
}

impl ConnectionManager {
    pub fn new(fanout: Arc<InProcessFanout>, db: PgPool) -> Arc<Self> {
        Arc::new(Self {
            fanout,
            membership_cache: MembershipCache::new(45), // TTL 45s
            db,
        })
    }

    /// 浏览器连接建立：注册 user 级发送端。
    pub fn on_connect(&self, user_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        self.fanout.register_user(user_id, conn_id, tx);
    }

    /// 浏览器断线：清理所有订阅 + user 注册。
    pub fn on_disconnect(&self, user_id: Uuid, conn_id: Uuid, subscribed: &[Uuid]) {
        for &channel_id in subscribed {
            self.fanout.unsubscribe_channel(channel_id, conn_id);
        }
        self.fanout.deregister_user(user_id, conn_id);
    }

    /// 处理 subscribe 帧：验成员资格（缓存 + PG），注册 channel 订阅。
    ///
    /// 返回 Ok(()) 表示订阅成功，Err 含关闭原因。
    pub async fn subscribe(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        channel_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
    ) -> Result<(), &'static str> {
        let is_member = self
            .check_membership(user_id, channel_id)
            .await
            .map_err(|_| "internal error")?;

        if !is_member {
            return Err("not a channel member");
        }

        self.fanout.subscribe_channel(channel_id, conn_id, tx);
        Ok(())
    }

    /// 处理 unsubscribe 帧。
    pub fn unsubscribe(&self, conn_id: Uuid, channel_id: Uuid) {
        self.fanout.unsubscribe_channel(channel_id, conn_id);
    }

    /// 成员被踢出频道时主动失效缓存（由 domain 层调用）。
    pub async fn evict_membership(&self, user_id: Uuid, channel_id: Uuid) {
        self.membership_cache.evict(user_id, channel_id).await;
    }

    // ── 私有：成员资格检查 ────────────────────────────────────────────────────

    async fn check_membership(
        &self,
        user_id: Uuid,
        channel_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        // 1. 缓存命中
        if let Some(cached) = self.membership_cache.get((user_id, channel_id)).await {
            return Ok(cached);
        }

        // 2. 查 PG
        let row = sqlx::query(
            "SELECT EXISTS(
                SELECT 1 FROM channel_memberships
                WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
            ) AS is_member",
        )
        .bind(channel_id.to_string())
        .bind(user_id.to_string())
        .fetch_one(&self.db)
        .await?;

        use sqlx::Row;
        let is_member: bool = row.try_get("is_member").unwrap_or(false);

        // 3. 写缓存
        self.membership_cache.set((user_id, channel_id), is_member).await;

        Ok(is_member)
    }
}
