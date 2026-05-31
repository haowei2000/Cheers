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
use std::sync::Arc;

use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    domain::{
        mentions::{MemberType, Mention},
        sessions,
    },
    gateway::{
        dispatcher::{self, DispatchParams},
        realtime::fanout::Fanout,
        registry::BotLocator,
        stream::StreamRegistry,
    },
};

#[derive(Debug, Clone)]
pub struct ChainCancelResult {
    pub status_changed: bool,
    pub targets: Vec<(Uuid, Uuid)>,
}

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
            ChainStatus::Active => "active",
            ChainStatus::Paused => "paused",
            ChainStatus::Cancelled => "cancelled",
            ChainStatus::Done => "done",
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
    let mut tx = db.begin().await?;
    let chain_id = create_in_tx(&mut tx, channel_id, root_task_id, root_msg_id).await?;
    tx.commit().await?;
    Ok(chain_id)
}

pub async fn create_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
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
    .execute(&mut **tx)
    .await?;

    Ok(chain_id)
}

/// dispatch 前的派发门：检查 chain 是否仍 active。
/// 返回 `false` 时调用方必须 drop，不能派发下一跳（这是取消的权威路径）。
pub async fn is_active(db: &PgPool, chain_id: Uuid) -> Result<bool, sqlx::Error> {
    let status = sqlx::query("SELECT status FROM task_chains WHERE chain_id = $1")
        .bind(chain_id.to_string())
        .fetch_optional(db)
        .await?
        .and_then(|row| row.try_get::<String, _>("status").ok());

    Ok(matches!(status.as_deref(), Some("active")))
}

pub async fn is_active_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    chain_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let status = sqlx::query("SELECT status FROM task_chains WHERE chain_id = $1")
        .bind(chain_id.to_string())
        .fetch_optional(&mut **tx)
        .await?
        .and_then(|row| row.try_get::<String, _>("status").ok());

    Ok(matches!(status.as_deref(), Some("active")))
}

/// 取消整条链（mesh step 5）。
///
/// 原子地将 `status` 改为 `cancelled`（idempotent）；
/// 返回需要广播 cancel 的 (placeholder_msg_id, bot_id) 列表（供调用方做尽力广播）。
pub async fn cancel(
    db: &PgPool,
    chain_id: Uuid,
    cancelled_by: Uuid,
) -> Result<ChainCancelResult, sqlx::Error> {
    let mut tx = db.begin().await?;
    let status_changed = sqlx::query(
        "UPDATE task_chains
         SET status = 'cancelled',
             cancelled_by = $2,
             cancelled_at = NOW()
         WHERE chain_id = $1 AND status = 'active'",
    )
    .bind(chain_id.to_string())
    .bind(cancelled_by.to_string())
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;

    let target_rows = sqlx::query(
        "SELECT placeholder_msg_id, bot_id
         FROM bot_runs
         WHERE chain_id = $1
           AND status NOT IN ('done', 'failed', 'cancelled')",
    )
    .bind(chain_id.to_string())
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE bot_runs
         SET last_event_type = 'cancel',
             updated_at = NOW()
         WHERE chain_id = $1
           AND status NOT IN ('done', 'failed', 'cancelled')",
    )
    .bind(chain_id.to_string())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let targets = target_rows
        .into_iter()
        .filter_map(|row| {
            let placeholder_msg_id = row
                .try_get::<String, _>("placeholder_msg_id")
                .ok()
                .and_then(|raw| Uuid::parse_str(&raw).ok())?;
            let bot_id = row
                .try_get::<String, _>("bot_id")
                .ok()
                .and_then(|raw| Uuid::parse_str(&raw).ok())?;
            Some((placeholder_msg_id, bot_id))
        })
        .collect();

    Ok(ChainCancelResult {
        status_changed,
        targets,
    })
}

pub async fn resolve_chain_id_for_message(
    db: &PgPool,
    channel_id: Uuid,
    msg_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    let raw = sqlx::query(
        "SELECT chain_id
         FROM bot_runs
         WHERE channel_id = $1
           AND placeholder_msg_id = $2
           AND chain_id IS NOT NULL
         UNION
         SELECT chain_id
         FROM agent_tasks
         WHERE channel_id = $1
           AND response_msg_id = $2
           AND chain_id IS NOT NULL
         LIMIT 1",
    )
    .bind(channel_id.to_string())
    .bind(msg_id.to_string())
    .fetch_optional(db)
    .await?
    .and_then(|row| row.try_get::<String, _>("chain_id").ok())
    .and_then(|raw| Uuid::parse_str(&raw).ok());

    Ok(raw)
}

/// Bot@Bot 重入：bot 回复 finalize 后，解析回复中的 @mention，若链仍 active 则
/// dispatch 下一跳（继承 chain_id，递增 depth）。在 `stream::handle_done` 之后调用。
pub async fn on_bot_reply_finalized(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    stream_registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    chain_id: Uuid,
    parent_task_id: Uuid,
    parent_depth: i32,
    reply_msg_id: Uuid,
    reply_seq: i64,
    channel_id: Uuid,
    mentions: &[Mention],
) -> Result<(), sqlx::Error> {
    let bots = mentioned_bots(mentions);
    if bots.is_empty() || !is_active(db, chain_id).await? {
        return Ok(());
    }

    let workspace_id = resolve_channel_workspace_id(db, channel_id).await?;
    let depth = parent_depth.saturating_add(1);

    for bot_id in bots {
        if !is_active(db, chain_id).await? {
            tracing::info!(
                chain_id = %chain_id,
                bot_id = %bot_id,
                "chain dispatch gate blocked bot mention"
            );
            break;
        }

        let provider_session_key = provider_session_key_for_bot_workspace(workspace_id, bot_id);
        let provider_account_id = resolve_provider_account_id_for_bot(db, bot_id)
            .await?
            .unwrap_or_else(|| bot_id.to_string());
        let session = sessions::acquire_scope_session(
            db,
            bot_id,
            &provider_account_id,
            &provider_session_key,
            sessions::SESSION_SCOPE_WORKSPACE,
            &workspace_id.to_string(),
            None,
            "primary",
        )
        .await;

        if let Err(e) = &session {
            tracing::warn!(
                chain_id = %chain_id,
                bot_id = %bot_id,
                channel_id = %channel_id,
                err = %e,
                "session acquire failed, fallback to unbound chain dispatch"
            );
        }

        let result = dispatcher::dispatch(
            db,
            fanout,
            stream_registry,
            bot_locator,
            DispatchParams {
                trigger_msg_id: reply_msg_id,
                trigger_seq: reply_seq,
                bot_id,
                channel_id,
                chain_id: Some(chain_id),
                parent_task_id: Some(parent_task_id),
                depth,
                provider_session_key,
                session_id: session.ok().map(|session| session.session_id),
            },
        )
        .await;

        match result {
            dispatcher::DispatchResult::DbError(e) => {
                tracing::warn!(chain_id = %chain_id, bot_id = %bot_id, err = e, "chain dispatch failed");
            }
            dispatcher::DispatchResult::ChainBlocked => {
                tracing::info!(chain_id = %chain_id, bot_id = %bot_id, "chain dispatch blocked");
            }
            _ => {}
        }
    }

    Ok(())
}

pub struct ReplyChainContext {
    pub chain_id: Uuid,
    pub parent_task_id: Uuid,
    pub parent_depth: i32,
}

pub async fn mark_reply_finalized(
    db: &PgPool,
    placeholder_msg_id: Uuid,
) -> Result<Option<ReplyChainContext>, sqlx::Error> {
    let mut tx = db.begin().await?;
    let Some(row) = sqlx::query(
        "UPDATE bot_runs
         SET status = 'done',
             last_event_type = 'done',
             updated_at = NOW()
         WHERE placeholder_msg_id = $1
         RETURNING task_id, chain_id",
    )
    .bind(placeholder_msg_id.to_string())
    .fetch_optional(&mut *tx)
    .await?
    else {
        tx.commit().await?;
        return Ok(None);
    };

    let task_id = row.try_get::<String, _>("task_id")?;
    let Some(chain_id) = row.try_get::<Option<String>, _>("chain_id")? else {
        tx.commit().await?;
        return Ok(None);
    };

    let Some(task_row) = sqlx::query(
        "UPDATE agent_tasks
         SET response_msg_id = $2
         WHERE task_id = $1
         RETURNING depth",
    )
    .bind(&task_id)
    .bind(placeholder_msg_id.to_string())
    .fetch_optional(&mut *tx)
    .await?
    else {
        tx.commit().await?;
        return Ok(None);
    };

    let Ok(chain_id) = Uuid::parse_str(&chain_id) else {
        tx.commit().await?;
        return Ok(None);
    };
    let Ok(parent_task_id) = Uuid::parse_str(&task_id) else {
        tx.commit().await?;
        return Ok(None);
    };
    let parent_depth = task_row.try_get::<Option<i32>, _>("depth")?.unwrap_or(0);

    tx.commit().await?;

    Ok(Some(ReplyChainContext {
        chain_id,
        parent_task_id,
        parent_depth,
    }))
}

pub async fn mark_run_failed(
    db: &PgPool,
    placeholder_msg_id: Uuid,
    error_message: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE bot_runs
         SET status = 'failed',
             last_event_type = 'error',
             error_message = $2,
             updated_at = NOW()
         WHERE placeholder_msg_id = $1",
    )
    .bind(placeholder_msg_id.to_string())
    .bind(error_message)
    .execute(db)
    .await?;

    Ok(())
}

fn mentioned_bots(mentions: &[Mention]) -> Vec<Uuid> {
    mentions
        .iter()
        .filter(|mention| mention.member_type == MemberType::Bot)
        .map(|mention| mention.member_id)
        .collect()
}

fn provider_session_key_for_bot_workspace(workspace_id: Uuid, bot_id: Uuid) -> String {
    format!("agentnexus:workspace:{workspace_id}:bot:{bot_id}")
}

async fn resolve_channel_workspace_id(db: &PgPool, channel_id: Uuid) -> Result<Uuid, sqlx::Error> {
    let row = sqlx::query("SELECT workspace_id FROM channels WHERE channel_id = $1")
        .bind(channel_id.to_string())
        .fetch_one(db)
        .await?;
    let raw = row.try_get::<String, _>("workspace_id")?;

    Uuid::parse_str(&raw).map_err(|_| sqlx::Error::RowNotFound)
}

async fn resolve_provider_account_id_for_bot(
    db: &PgPool,
    bot_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let Some(row) = sqlx::query("SELECT binding_config FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id.to_string())
        .fetch_optional(db)
        .await?
    else {
        return Ok(None);
    };

    let binding_config = row
        .try_get::<Option<serde_json::Value>, _>("binding_config")?
        .unwrap_or(serde_json::Value::Null);

    Ok(resolve_provider_account_id_from_binding_config(
        &binding_config,
    ))
}

fn resolve_provider_account_id_from_binding_config(
    binding_config: &serde_json::Value,
) -> Option<String> {
    fn trim_or_none(value: &serde_json::Value) -> Option<String> {
        let value = value.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
        Some(value.to_string())
    }

    if let Some(acp) = binding_config
        .get("acp")
        .and_then(serde_json::Value::as_object)
    {
        for key in [
            "provider_account_id",
            "provider_account",
            "account_id",
            "account",
            "agent_id",
            "id",
        ] {
            if let Some(v) = acp.get(key).and_then(trim_or_none) {
                return Some(v);
            }
        }
    }

    for key in [
        "provider_account_id",
        "provider_account",
        "account_id",
        "account",
        "agent_id",
        "id",
    ] {
        if let Some(v) = binding_config.get(key).and_then(trim_or_none) {
            return Some(v);
        }
    }

    None
}
