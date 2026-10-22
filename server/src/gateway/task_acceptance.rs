//! Durable execution grants for negotiated Agent Bridge tasks.
//!
//! This grants one execution identity; it does not prove that execution began,
//! and grants are never released or automatically replayed after a disconnect.

use cheers_bridge_protocol::TaskAcceptanceStatus;
use serde_json::Value;
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

pub(crate) async fn may_execute(
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
    // Shared intent policy uses PgPool. Finish it before retaining a
    // transaction connection/locks; the immutable input is compared again under
    // the run lock, and mutable source/session authority is fenced below.
    let dispatch_input = sqlx::query_scalar!(
        "SELECT dispatch_input FROM bot_runs WHERE placeholder_msg_id=$1",
        placeholder_msg_id.to_string(),
    )
    .fetch_optional(db)
    .await?
    .flatten();
    let intent = match dispatch_input.as_ref() {
        Some(input) => match super::dispatch_intents::preauthorize(db, input).await {
            Ok(intent) => Some(intent),
            Err(super::dispatch_intents::IntentPolicyError::Denied(_)) => {
                return Ok(Decision::rejected("dispatch authority was revoked"));
            }
            Err(super::dispatch_intents::IntentPolicyError::Retryable(error)) => {
                return Err(match error {
                    crate::errors::AppError::Db(error) => error,
                    other => sqlx::Error::Protocol(other.to_string()),
                });
            }
        },
        None => None,
    };
    let mut tx = db.begin().await?;
    let message = sqlx::query!(
        "SELECT channel_id, sender_id, sender_type, is_partial, is_deleted, channel_seq, chain_id,content_data
         FROM messages WHERE msg_id = $1 FOR UPDATE",
        placeholder_msg_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await?;
    let run = sqlx::query!(
        "SELECT task_id, bot_id, channel_id, status, binding_type,
                execution_id, execution_connection_id, dispatch_input,task_frame
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
            let expected_claim = match message
                .content_data
                .as_ref()
                .and_then(|data| data.get("task_claim_id"))
            {
                None => None,
                Some(Value::String(id)) => match id.parse::<Uuid>() {
                    Ok(id) => Some(id),
                    Err(_) => return Ok(Decision::rejected("task claim identity is invalid")),
                },
                Some(_) => return Ok(Decision::rejected("task claim identity is invalid")),
            };
            if !may_execute(&mut tx, bot_id, channel_id, message.chain_id.as_deref()).await? {
                Decision::rejected("bot may no longer execute this task")
            } else {
                match (run.execution_id, run.execution_connection_id) {
                    (None, None) if run.status == "prepared" => {
                        if let Some(current_input) = run.dispatch_input.as_ref() {
                            let Some(intent) = intent.as_ref() else {
                                return Ok(Decision::rejected("dispatch input changed"));
                            };
                            if dispatch_input.as_ref() != Some(current_input)
                                || run.task_frame.is_none()
                                || intent.params.bot_id != bot_id
                                || intent.params.channel_id != channel_id
                                || super::dispatcher::derive_placeholder_id(
                                    intent.params.trigger_msg_id,
                                    bot_id,
                                ) != placeholder_msg_id
                                || intent.params.chain_id.as_deref() != message.chain_id.as_deref()
                                || !super::dispatch_intents::authorize_locked(&mut tx, intent)
                                    .await?
                            {
                                return Ok(Decision::rejected(
                                    "dispatch authority is no longer active",
                                ));
                            }
                        } else if dispatch_input.is_some() {
                            return Ok(Decision::rejected("dispatch input changed"));
                        }
                        if !claim_is_executable(
                            &mut tx,
                            expected_claim,
                            placeholder_msg_id,
                            bot_id,
                            channel_id,
                        )
                        .await?
                        {
                            return Ok(Decision::rejected("task claim is no longer executable"));
                        }
                        let granted = sqlx::query!(
                            "UPDATE bot_runs
                         SET execution_id = $2, execution_connection_id = $3,
                             accepted_at = NOW(), status = 'accepted',
                             last_event_type = 'task_accept', updated_at = NOW(),
                             dispatch_input=NULL,task_frame=NULL,next_offer_at=NULL,
                             dispatch_lease_id=NULL,dispatch_lease_until=NULL
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
                        if claim_is_executable(
                            &mut tx,
                            expected_claim,
                            placeholder_msg_id,
                            bot_id,
                            channel_id,
                        )
                        .await?
                        {
                            Decision::granted()
                        } else {
                            Decision::rejected("task claim is no longer executable")
                        }
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

/// Recheck the approval after any session/policy lock waits and before issuing
/// either a first grant or its same-owner replay. This adds no execution owner.
async fn claim_is_executable(
    tx: &mut Transaction<'_, Postgres>,
    expected_claim: Option<Uuid>,
    placeholder_msg_id: Uuid,
    bot_id: Uuid,
    channel_id: Uuid,
) -> Result<bool, sqlx::Error> {
    match crate::domain::task_claims::lock_execution_claim(
        tx,
        expected_claim,
        placeholder_msg_id,
        bot_id,
        channel_id,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(crate::errors::AppError::Db(error)) => Err(error),
        Err(crate::errors::AppError::Internal(detail)) => Err(sqlx::Error::Protocol(detail)),
        Err(_) => Ok(false),
    }
}
