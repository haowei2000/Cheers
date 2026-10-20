//! Durable execution grants for negotiated Agent Bridge tasks.
//!
//! This grants one execution identity; it does not prove that execution began,
//! and grants are never released or automatically replayed after a disconnect.

use cheers_bridge_protocol::TaskAcceptanceStatus;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub struct Decision {
    pub status: TaskAcceptanceStatus,
    pub error: Option<String>,
}

impl Decision {
    fn granted() -> Self {
        Self {
            status: TaskAcceptanceStatus::Granted,
            error: None,
        }
    }

    fn rejected(message: &str) -> Self {
        Self {
            status: TaskAcceptanceStatus::Rejected,
            error: Some(message.into()),
        }
    }

    fn owned() -> Self {
        Self {
            status: TaskAcceptanceStatus::Owned,
            error: Some("task is already owned by another execution or connection".into()),
        }
    }
}

async fn may_execute(
    tx: &mut Transaction<'_, Postgres>,
    bot_id: Uuid,
    channel_id: Uuid,
    chain_id: Option<&str>,
) -> Result<bool, sqlx::Error> {
    // Hold the same state that authorizes the grant until commit: a concurrent
    // disable, role change, removal or chain cancellation must serialize with it.
    let bot = sqlx::query!(
        "SELECT is_disabled FROM bot_accounts WHERE bot_id = $1 FOR SHARE",
        bot_id.to_string(),
    )
    .fetch_optional(&mut **tx)
    .await?;
    if !bot.is_some_and(|bot| !bot.is_disabled) {
        return Ok(false);
    }
    let member = sqlx::query!(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'bot' FOR SHARE",
        channel_id.to_string(),
        bot_id.to_string(),
    )
    .fetch_optional(&mut **tx)
    .await?;
    if !member.is_some_and(|member| crate::resource::role_can_write(&member.role)) {
        return Ok(false);
    }
    if let Some(chain_id) = chain_id {
        let chain = sqlx::query!(
            "SELECT status FROM task_chains WHERE chain_id = $1 AND channel_id = $2 FOR SHARE",
            chain_id,
            channel_id.to_string(),
        )
        .fetch_optional(&mut **tx)
        .await?;
        if !chain.is_some_and(|chain| chain.status == "active") {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Grant only the first execution on the authenticated control connection.
/// Lock message before run, matching terminal finalization's lock order. The
/// response may be sent only after this transaction successfully commits.
pub async fn claim(
    db: &PgPool,
    bot_id: Uuid,
    connection_id: Uuid,
    task_id: Uuid,
    placeholder_msg_id: Uuid,
    channel_id: Uuid,
    execution_id: Uuid,
) -> Result<Decision, sqlx::Error> {
    let mut tx = db.begin().await?;
    let message = sqlx::query!(
        "SELECT channel_id, sender_id, sender_type, is_partial, is_deleted, channel_seq, chain_id
         FROM messages WHERE msg_id = $1 FOR UPDATE",
        placeholder_msg_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await?;
    let run = sqlx::query!(
        "SELECT task_id, bot_id, channel_id, status, binding_type,
                execution_id, execution_connection_id
         FROM bot_runs WHERE placeholder_msg_id = $1 FOR UPDATE",
        placeholder_msg_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await?;

    let decision = match (message, run) {
        (Some(message), Some(run))
            if message.channel_id == channel_id.to_string()
                && message.sender_id == bot_id.to_string()
                && message.sender_type == "bot"
                && message.is_partial
                && !message.is_deleted
                && message.channel_seq.is_none()
                && run.task_id == task_id.to_string()
                && run.bot_id == bot_id.to_string()
                && run.channel_id == channel_id.to_string()
                && run.binding_type == "acp"
                && matches!(run.status.as_str(), "prepared" | "accepted") =>
        {
            if !may_execute(&mut tx, bot_id, channel_id, message.chain_id.as_deref()).await? {
                Decision::rejected("bot may no longer execute this task")
            } else {
                match (run.execution_id, run.execution_connection_id) {
                    (None, None) if run.status == "prepared" => {
                        let granted = sqlx::query!(
                            "UPDATE bot_runs
                         SET execution_id = $2, execution_connection_id = $3,
                             accepted_at = NOW(), status = 'accepted',
                             last_event_type = 'task_accept', updated_at = NOW()
                         WHERE placeholder_msg_id = $1 AND execution_id IS NULL
                           AND execution_connection_id IS NULL",
                            placeholder_msg_id.to_string(),
                            execution_id.to_string(),
                            connection_id.to_string(),
                        )
                        .execute(&mut *tx)
                        .await?;
                        if granted.rows_affected() == 1 {
                            Decision::granted()
                        } else {
                            Decision::owned()
                        }
                    }
                    (Some(execution), Some(connection))
                        if execution == execution_id.to_string()
                            && connection == connection_id.to_string()
                            && run.status == "accepted" =>
                    {
                        Decision::granted()
                    }
                    (Some(_), Some(_)) => Decision::owned(),
                    _ => Decision::rejected("task execution claim is inconsistent"),
                }
            }
        }
        _ => Decision::rejected("task is not an active placeholder owned by this bot"),
    };
    tx.commit().await?;
    Ok(decision)
}
