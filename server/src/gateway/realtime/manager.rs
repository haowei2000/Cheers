use std::{
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::Duration,
};

use lru::LruCache;
use sqlx::PgPool;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use super::fanout::{CloseReason, WireFrame};

// ── 连接注册接口（让 ConnectionManager 不直接依赖 InProcessFanout）────────────

/// 本地连接注册的抽象接口。
/// InProcessFanout 和 RedisFanout 都实现这个接口。
pub trait LocalRegistry: Send + Sync {
    fn register_user(
        &self,
        user_id: Uuid,
        conn_id: Uuid,
        tx: mpsc::Sender<WireFrame>,
        close_tx: mpsc::Sender<CloseReason>,
    );
    fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>);
    fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid);
    /// 成员资格被服务器撤销：移除该用户在该频道的所有连接订阅（subscribe 的反向边）。
    fn unsubscribe_user_channel(&self, channel_id: Uuid, user_id: Uuid);
    /// 频道被删除：丢弃该频道的整张订阅表。
    fn drop_channel(&self, channel_id: Uuid);
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
        close_tx: mpsc::Sender<CloseReason>,
    ) {
        InProcessFanout::register_user(self, user_id, conn_id, tx, close_tx);
    }
    fn subscribe_channel(&self, channel_id: Uuid, conn_id: Uuid, tx: mpsc::Sender<WireFrame>) {
        InProcessFanout::subscribe_channel(self, channel_id, conn_id, tx);
    }
    fn unsubscribe_channel(&self, channel_id: Uuid, conn_id: Uuid) {
        InProcessFanout::unsubscribe_channel(self, channel_id, conn_id);
    }
    fn unsubscribe_user_channel(&self, channel_id: Uuid, user_id: Uuid) {
        InProcessFanout::unsubscribe_user_channel(self, channel_id, user_id);
    }
    fn drop_channel(&self, channel_id: Uuid) {
        InProcessFanout::drop_channel(self, channel_id);
    }
    fn deregister_user(&self, user_id: Uuid, conn_id: Uuid) {
        InProcessFanout::deregister_user(self, user_id, conn_id);
    }
}

// ── 成员资格缓存 ──────────────────────────────────────────────────────────────

struct MembershipCache {
    inner: Mutex<LruCache<(Uuid, Uuid), (bool, tokio::time::Instant)>>,
    ttl: Duration,
    /// Eviction epoch. A membership verdict is fetched from the DB *outside*
    /// the cache lock, so a revocation can evict between the SELECT and the
    /// write-back — the stale `true` would then re-poison the key for a full
    /// TTL. Every evict bumps this; `set_if_current` refuses to write a verdict
    /// snapshotted under an older generation. Global (not per-key) on purpose:
    /// revocations are rare, and the only cost of a collision is one skipped
    /// cache fill.
    generation: AtomicU64,
}

impl MembershipCache {
    fn new(ttl_secs: u64) -> Self {
        Self {
            inner: Mutex::new(LruCache::new(std::num::NonZeroUsize::new(4096).unwrap())),
            ttl: Duration::from_secs(ttl_secs),
            generation: AtomicU64::new(0),
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

    /// Snapshot the eviction epoch BEFORE querying the DB; pass it back to
    /// `set_if_current` so a concurrent eviction invalidates the write-back.
    fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Write a verdict only if no eviction happened since `gen` was
    /// snapshotted. Generation check and put share the cache lock, and `evict`
    /// bumps under the same lock, so bump+pop vs check+put cannot interleave.
    async fn set_if_current(&self, key: (Uuid, Uuid), is_member: bool, gen: u64) {
        let mut cache = self.inner.lock().await;
        if self.generation.load(Ordering::Acquire) != gen {
            return;
        }
        cache.put(key, (is_member, tokio::time::Instant::now() + self.ttl));
    }

    pub async fn evict(&self, user_id: Uuid, channel_id: Uuid) {
        let mut cache = self.inner.lock().await;
        self.generation.fetch_add(1, Ordering::AcqRel);
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
        close_tx: mpsc::Sender<CloseReason>,
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
        // Pre-check (cache-assisted): keeps obvious non-members from ever
        // entering the fan-out list. NOT authoritative — see below.
        let is_member = self
            .check_membership(user_id, channel_id)
            .await
            .map_err(|_| "internal error")?;

        if !is_member {
            return Err("not a channel member");
        }

        self.registry.subscribe_channel(channel_id, conn_id, tx);

        // Authoritative post-insert re-check (uncached), closing the TOCTOU
        // against revoke_channel_subscriptions(): if the membership row was
        // deleted after the pre-check, either (a) this SELECT sees the delete
        // and we remove the subscription ourselves, or (b) the delete commits
        // after this SELECT, in which case the revoke that follows every delete
        // runs after our insert and removes it. Residual window: a just-removed
        // member can receive frames between the insert above and this SELECT
        // completing — one DB roundtrip, after which one of the two paths has
        // removed the subscription. DB failure fails closed.
        let confirmed = self.query_membership(user_id, channel_id).await;
        if !matches!(confirmed, Ok(true)) {
            self.registry.unsubscribe_user_channel(channel_id, user_id);
            return Err(match confirmed {
                Ok(_) => "not a channel member",
                Err(_) => "internal error",
            });
        }
        Ok(())
    }

    pub fn unsubscribe(&self, conn_id: Uuid, channel_id: Uuid) {
        self.registry.unsubscribe_channel(channel_id, conn_id);
    }

    /// Reverse edge of `subscribe` (membership is only checked at subscribe
    /// time): when a member is removed or leaves, cut their live subscriptions
    /// so new frames stop immediately, and evict the membership cache so a
    /// concurrent resubscribe can't ride the 45s cached "member" verdict. The
    /// evict also bumps the cache generation, so an in-flight pre-revocation
    /// DB verdict can't be written back after us; a racing subscribe is caught
    /// by its own post-insert re-check (see `subscribe`).
    pub async fn revoke_channel_subscriptions(&self, user_id: Uuid, channel_id: Uuid) {
        self.membership_cache.evict(user_id, channel_id).await;
        self.registry.unsubscribe_user_channel(channel_id, user_id);
    }

    /// Channel deleted: drop every live subscription to it.
    pub fn drop_channel(&self, channel_id: Uuid) {
        self.registry.drop_channel(channel_id);
    }

    async fn check_membership(&self, user_id: Uuid, channel_id: Uuid) -> Result<bool, sqlx::Error> {
        if let Some(cached) = self.membership_cache.get((user_id, channel_id)).await {
            return Ok(cached);
        }
        // Snapshot the eviction epoch BEFORE the query: if a revocation evicts
        // this key while the SELECT is in flight, the (possibly stale) verdict
        // must not be written back (TOCTOU re-poisoning).
        let gen = self.membership_cache.current_generation();
        let is_member = self.query_membership(user_id, channel_id).await?;
        self.membership_cache
            .set_if_current((user_id, channel_id), is_member, gen)
            .await;
        Ok(is_member)
    }

    /// Raw, uncached membership lookup.
    async fn query_membership(&self, user_id: Uuid, channel_id: Uuid) -> Result<bool, sqlx::Error> {
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
        Ok(row.try_get("is_member").unwrap_or(false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TOCTOU guard: a verdict snapshotted BEFORE an eviction must not be
    /// written back AFTER it — otherwise a removal would be re-poisoned with a
    /// stale "member=true" for a full TTL. (The full subscribe race needs a
    /// live DB; this pins the cache primitive the fix relies on.)
    #[tokio::test]
    async fn stale_verdict_is_not_written_after_evict() {
        let cache = MembershipCache::new(45);
        let key = (Uuid::new_v4(), Uuid::new_v4());

        // Subscribe path snapshots the epoch, then "queries the DB" (true)…
        let gen = cache.current_generation();
        // …meanwhile a revocation evicts the key (bumping the epoch)…
        cache.evict(key.0, key.1).await;
        // …and the stale write-back must be refused.
        cache.set_if_current(key, true, gen).await;
        assert_eq!(cache.get(key).await, None, "stale verdict must be dropped");
    }

    /// The happy path still fills the cache when no eviction intervened.
    #[tokio::test]
    async fn fresh_verdict_is_cached() {
        let cache = MembershipCache::new(45);
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let gen = cache.current_generation();
        cache.set_if_current(key, true, gen).await;
        assert_eq!(cache.get(key).await, Some(true));
    }

    /// evict removes an existing entry (and later fills with a NEW epoch work).
    #[tokio::test]
    async fn evict_removes_and_new_epoch_allows_refill() {
        let cache = MembershipCache::new(45);
        let key = (Uuid::new_v4(), Uuid::new_v4());
        cache
            .set_if_current(key, true, cache.current_generation())
            .await;
        cache.evict(key.0, key.1).await;
        assert_eq!(cache.get(key).await, None);
        // A verdict fetched AFTER the eviction (new epoch) may be cached.
        let gen = cache.current_generation();
        cache.set_if_current(key, false, gen).await;
        assert_eq!(cache.get(key).await, Some(false));
    }
}
