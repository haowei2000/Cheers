//! Bot@Bot 任务链跟踪 + 取消（DECENTRALIZED_MESH §8）。
//!
//! 一条 chain = 一次 bot@bot 级联，根于「发起它的那条消息」（用户消息，或某个
//! bot 的主动 post_message）。级联派生的每一跳占位消息都带上同一个 `chain_id`
//! （写在 `messages.chain_id`），于是：
//! - 用户可以对任意一条 bot 消息点 ⏹，一次性取消整条链（而非单条）。
//! - **派发闸门**（[`is_active`]）在启动下一跳前查 chain 状态，非 active 直接丢弃
//!   （不建占位、不派发）——这是权威停止点，即使取消广播漏掉了离线 bot 也成立。
//!
//! chain 状态机：`active → cancelled`（或 `done`/`paused`，本期只用 active/cancelled）。
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// 开启一条新链，根于 `root_msg_id`（触发级联的那条消息）。返回 `chain_id`。
/// 只在这条消息确实会触发 bot（有下游派发）时调用，避免给纯人类对话留死行。
pub async fn start_chain(
    db: &PgPool,
    channel_id: Uuid,
    root_task_id: Uuid,
    root_msg_id: Uuid,
) -> Result<Uuid, sqlx::Error> {
    let chain_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO task_chains (chain_id, channel_id, root_task_id, root_msg_id, status)
         VALUES ($1, $2, $3, $4, 'active')",
    )
    .bind(chain_id.to_string())
    .bind(channel_id.to_string())
    .bind(root_task_id.to_string())
    .bind(root_msg_id.to_string())
    .execute(db)
    .await?;
    Ok(chain_id)
}

/// 权威派发闸门：只有 chain 处于 `active` 才允许启动下一跳。已 `cancelled`/其它
/// 终态的链会阻断一切后续派发。未知/无 chain（`None` 行）视为「非链跟踪派发」直接
/// 放行（如定向 session、无级联的单发）。查询出错 fail-open（与其它闸门一致）。
pub async fn is_active(db: &PgPool, chain_id: &str) -> bool {
    match sqlx::query_scalar::<_, String>("SELECT status FROM task_chains WHERE chain_id = $1")
        .bind(chain_id)
        .fetch_optional(db)
        .await
    {
        Ok(Some(status)) => status == "active",
        Ok(None) => true, // 无 chain 行 → 未跟踪 → 放行
        Err(_) => true,   // fail-open
    }
}

/// 解析某条消息所属的 chain（占位/回复消息带 `chain_id`）。用于把 ⏹ 落在某条
/// bot 消息上时反查它属于哪条链。
pub async fn chain_of_message(db: &PgPool, msg_id: Uuid) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT chain_id FROM messages WHERE msg_id = $1")
        .bind(msg_id.to_string())
        .fetch_optional(db)
        .await?;
    Ok(row.and_then(|r| r.try_get::<Option<String>, _>("chain_id").ok().flatten()))
}

/// 某个 bot 在某频道当前「进行中」任务所属的 chain：取该 bot 最新的未完成
/// （`is_partial=TRUE`）占位的 `chain_id`。用于主动 post_message/send 路径——那里
/// 拿不到当前任务上下文（与 depth-reset 同源），故用「进行中占位」做 best-effort
/// 归属，让多跳 post_message 级联共享同一条链而不是各起一条。
pub async fn chain_of_active_bot_task(
    db: &PgPool,
    channel_id: Uuid,
    bot_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT chain_id FROM messages
         WHERE channel_id = $1 AND sender_id = $2 AND sender_type = 'bot'
           AND is_partial = TRUE AND chain_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(bot_id.to_string())
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|r| r.try_get::<Option<String>, _>("chain_id").ok().flatten()))
}

/// 取消一条链：原子地把 `active → cancelled`，并返回链上仍在进行中的 bot 占位
/// `(placeholder_msg_id, bot_id)`，供上层对每个 bot 发既有的 per-msg cancel 帧。
/// 幂等：非 active（已取消/已完成/未知）返回空，调用方无副作用。
pub async fn cancel_chain(
    db: &PgPool,
    chain_id: &str,
    cancelled_by: Uuid,
) -> Result<Vec<(Uuid, Uuid)>, sqlx::Error> {
    let updated = sqlx::query(
        "UPDATE task_chains
         SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW()
         WHERE chain_id = $1 AND status = 'active'",
    )
    .bind(chain_id)
    .bind(cancelled_by.to_string())
    .execute(db)
    .await?;
    if updated.rows_affected() == 0 {
        return Ok(Vec::new()); // 已终态 / 未知 chain → 幂等空
    }

    let rows = sqlx::query(
        "SELECT msg_id, sender_id FROM messages
         WHERE chain_id = $1 AND sender_type = 'bot' AND is_partial = TRUE",
    )
    .bind(chain_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let msg_id = r.try_get::<String, _>("msg_id").ok()?.parse().ok()?;
            let bot_id = r.try_get::<String, _>("sender_id").ok()?.parse().ok()?;
            Some((msg_id, bot_id))
        })
        .collect())
}
