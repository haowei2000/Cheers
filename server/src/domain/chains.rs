//! Bot@Bot 触发与取消。
//!
//! bot 回复 finalize 后，若回复中含 @bot mention 且 depth < MAX_BOT_REPLY_DEPTH，
//! 则直接 dispatch 下一跳（和用户消息触发 bot 完全一致，无链跟踪）。
//! 取消接口（cancel / resolve_chain_id_for_message）保留供已有 cancel-chain API 使用。
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

/// bot@bot 触发的最大深度，超出后静默停止。
pub const MAX_BOT_REPLY_DEPTH: i32 = 5;

/// 取消整条链。
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

/// bot 回复 finalize 后触发回复中 @bot mention，depth+1 后 dispatch。
/// 超过 MAX_BOT_REPLY_DEPTH 时静默停止，防止无限循环。
pub async fn trigger_bot_replies(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    stream_registry: &StreamRegistry,
    bot_locator: &Arc<dyn BotLocator>,
    channel_id: Uuid,
    reply_msg_id: Uuid,
    reply_seq: i64,
    current_depth: i32,
    mentions: &[Mention],
) -> Result<(), sqlx::Error> {
    let bots = mentioned_bots(mentions);
    if bots.is_empty() {
        return Ok(());
    }

    let next_depth = current_depth.saturating_add(1);
    let workspace_id = resolve_channel_workspace_id(db, channel_id).await?;

    for bot_id in bots {
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
                bot_id = %bot_id,
                channel_id = %channel_id,
                err = %e,
                "session acquire failed for bot reply trigger"
            );
        }

        if let dispatcher::DispatchResult::DbError(e) = dispatcher::dispatch(
            db,
            fanout,
            stream_registry,
            bot_locator,
            DispatchParams {
                trigger_msg_id: reply_msg_id,
                trigger_seq: reply_seq,
                bot_id,
                channel_id,
                depth: next_depth,
                provider_session_key,
                session_id: session.ok().map(|s| s.session_id),
            },
        )
        .await
        {
            tracing::warn!(bot_id = %bot_id, err = e, "bot reply dispatch failed");
        }
    }

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
