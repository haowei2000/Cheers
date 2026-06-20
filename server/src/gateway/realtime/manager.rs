use std::{sync::Arc, time::Duration};

use lru::LruCache;
use sqlx::PgPool;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use super::fanout::WireFrame;

// ── 连接注册接口（让 ConnectionManager 不直接依赖 InProcessFanout）────────────

/// 本地连接注册的抽象接口。
/// InProcessFanout 和 RedisFanout 都实现这个接口。
pub trait LocalRegistry: Send + Sync {
    fn register_user(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<()>,
    );
    fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>);
    fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid);
    fn deregister_user(&self, user_id: Uuid, conn_id: Uuid);
}

// ── InProcessFanout 实现 LocalRegistry ───────────────────────────────────────

use super::fanout::InProcessFanout;

impl LocalRegistry for InProcessFanout {
    fn register_user(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<()>,
    ) {
        InProcessFanout::register_user(self, user_id, conn_id, tx, close_tx);
    }
    fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        InProcessFanout::subscribe_channel(self, channel_id, conn_id, tx);
    }
    fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid) {
        InProcessFanout::unsubscribe_channel(self, channel_id, conn_id);
    }
    fn deregister_user(&self, user_id: Uuid, conn_id: Uuid) {
        InProcessFanout::deregister_user(self, user_id, conn_id);
    }
}

// ── 成员资格缓存 ──────────────────────────────────────────────────────────────

struct MembershipCache {
    inner: Mutex<LruCache<(Uuid, Uuid), (bool, tokio::time::Instant)>>,
    ttl: Duration,
}

impl MembershipCache {
    fn new(ttl_secs: u64) -> Self {
        Self {
            inner: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(4096).unwrap())),
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

    pub async fn evict(&self, user_id: Uuid, channel_id: Uuid) {
        let mut cache = self.inner.lock().await;
        cache.pop(&(user_id, channel_id));
    }
}

// ── ConnectionManager ─────────────────────────────────────────────────────────

pub struct ConnectionManager {
    registry: Arc<dyn LocalRegistry>,
    membership_cache: MembershipCache,
    db: PgPool,
}

impl ConnectionManager {
    /// 单实例：直接用 InProcessFanout。
    pub fn new(fanout: Arc<InProcessFanout>, db: PgPool) -> Arc<Self> {
        Arc::new(Self {
            registry: fanout,
            membership_cache: MembershipCache::new(45),
            db,
        })
    }

    /// 多实例：用 RedisFanout（它实现了 LocalRegistry 委托给内部 local）。
    /// 当前单实例未装配（roadmap R1-B / M4 才启用）。
    #[allow(dead_code)]
    pub fn new_with_redis(
        fanout: Arc<crate::gateway::realtime::redis_fanout::RedisFanout>,
        db: PgPool,
    ) -> Arc<Self> {
        Arc::new(Self {
            registry: fanout,
            membership_cache: MembershipCache::new(45),
            db,
        })
    }

    pub fn on_connect(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<()>,
    ) {
        self.registry.register_user(user_id, conn_id, tx, close_tx);
    }

    pub fn on_disconnect(&self, user_id: Uuid, conn_id: Uuid, subscribed: &[Uuid]) {
        for &channel_id in subscribed {
            self.registry.unsubscribe_channel(channel_id, conn_id);
        }
        self.registry.deregister_user(user_id, conn_id);
    }

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

        self.registry.subscribe_channel(channel_id, conn_id, tx);
        Ok(())
    }

    pub fn unsubscribe(&self, conn_id: Uuid, channel_id: Uuid) {
        self.registry.unsubscribe_channel(channel_id, conn_id);
    }

    pub async fn evict_membership(&self, user_id: Uuid, channel_id: Uuid) {
        self.membership_cache.evict(user_id, channel_id).await;
    }

    async fn check_membership(&self, user_id: Uuid, channel_id: Uuid) -> Result<bool, sqlx::Error> {
        if let Some(cached) = self.membership_cache.get((user_id, channel_id)).await {
            return Ok(cached);
        }
        use sqlx::Row;
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

        let is_member: bool = row.try_get("is_member").unwrap_or(false);
        self.membership_cache
            .set((user_id, channel_id), is_member)
            .await;
        Ok(is_member)
    }
}
