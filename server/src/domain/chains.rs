//! Bot@Bot 任务链跟踪与取消（DECENTRALIZED_MESH §8，mesh step 4-5）。
//!
//! 链的生命周期：
//!   用户触发 → root task → 创建 chain（status=active）
//!   bot 回复含 @mention → 派发门检查 chain.status → active 则 dispatch 下一跳
//!   用户点 ⏹ → cancel_chain → status=cancelled + 广播现有 per-msg_id cancel 帧
//!
//! 停止两部分：
//!   (a) 派发门（权威）：dispatch 前检查 status != active → drop
//!   (b) 取消广播（尽力）：对 in-flight bot_runs 发 cancel 帧
use sqlx::PgPool;
use uuid::Uuid;

/// 链状态（对应 task_chains.status）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainStatus {
    Active,
    Paused,
    Cancelled,
    Done,
}

impl ChainStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChainStatus::Active    => "active",
            ChainStatus::Paused    => "paused",
            ChainStatus::Cancelled => "cancelled",
            ChainStatus::Done      => "done",
        }
    }
}

/// 为一条用户触发的 root task 创建新链，返回 chain_id。
pub async fn create(
    db: &PgPool,
    channel_id: Uuid,
    root_task_id: Uuid,
    root_msg_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    todo!("mesh step 4: INSERT INTO task_chains (chain_id, channel_id, root_task_id, root_msg_id, status='active')")
}

/// dispatch 前的派发门：检查 chain 是否仍 active。
/// 返回 `false` 时调用方必须 drop，不能派发下一跳（这是取消的权威路径）。
pub async fn is_active(
    db: &PgPool,
    chain_id: Uuid,
) -> Result<bool, sqlx::Error> {
    todo!("mesh step 4: SELECT status FROM task_chains WHERE chain_id=$1")
}

/// 取消整条链（mesh step 5）。
///
/// 原子地将 `status` 改为 `cancelled`（idempotent）；
/// 返回需要广播 cancel 的 (placeholder_msg_id, bot_id) 列表（供调用方做尽力广播）。
pub async fn cancel(
    db: &PgPool,
    chain_id: Uuid,
    cancelled_by: Uuid,
) -> Result<Vec<(Uuid, Uuid)>, sqlx::Error> {
    todo!("mesh step 5: UPDATE task_chains SET status='cancelled' WHERE chain_id=$1 AND status='active'; then SELECT non-terminal bot_runs")
}

/// Bot@Bot 重入：bot 回复 finalize 后，解析回复中的 @mention，若链仍 active 则
/// dispatch 下一跳（继承 chain_id，递增 depth）。在 `stream::handle_done` 之后调用。
pub async fn on_bot_reply_finalized(
    db: &PgPool,
    chain_id: Uuid,
    reply_msg_id: Uuid,
    reply_content: &str,
    channel_id: Uuid,
) -> Result<(), sqlx::Error> {
    todo!("mesh step 4: parse @mentions in reply, check chain active, dispatch next hops with chain_id+parent_task_id+depth")
}
