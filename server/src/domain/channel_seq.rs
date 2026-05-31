//! 每频道单调事件时钟 `channel_seq`（DECENTRALIZED_MESH §3，mesh step 3）。
//!
//! 单频道、gap-free、连续序列，是排序与恢复的骨架。分配**必须**在消息的提交事务内、
//! 频道行锁下进行，保证 `seq order == commit order`。
//!
//! 两条分配路径（按消息来源）：
//! - 用户消息（born final，`is_partial=FALSE`）：在 INSERT 当场分配。
//! - bot 占位（born partial）：在 finalize（`is_partial` TRUE→FALSE）时分配，
//!   被遗弃的流式占位永不消费 seq → 无间隙。
use sqlx::Row;
use uuid::Uuid;

/// 在事务 `tx` 内、行锁下分配频道的下一个 `channel_seq`。
///
/// ```sql
/// UPDATE channels SET next_seq = next_seq + 1 WHERE channel_id = $1 RETURNING next_seq;
/// ```
/// `tx` 回滚会释放该自增 → 无间隙。全局 `BIGSERIAL` 是错的（值序可能 != 提交序）。
pub async fn allocate(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    channel_id: Uuid,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query(
        "UPDATE channels SET next_seq = next_seq + 1 WHERE channel_id = $1 RETURNING next_seq",
    )
    .bind(channel_id.to_string())
    .fetch_one(tx)
    .await?;

    row.try_get::<i64, _>("next_seq")
}
