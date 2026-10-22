//! Approval commits the claim, its private source and its dispatch intent together.
//! Cancellation projects the same claim authority into its confirmation;
//! delivery, grants and completion consult it before committing further work.

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    domain::{context_bundle, message_policy, sessions, task_chains},
    errors::AppError,
    gateway::{
        dispatch_intents::{self, ClaimIntent},
        dispatcher::{self, DispatchParams},
        registry::BotLocator,
        task_acceptance,
    },
    resource::Principal,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimDecision {
    Accept,
    Reject,
}

pub struct ResolveClaimParams {
    pub channel_id: Uuid,
    pub claim_id: Uuid,
    pub requester_id: Uuid,
    pub decision: ClaimDecision,
    pub note: Option<String>,
}

#[derive(Debug)]
pub struct ResolveClaimOutcome {
    pub claim_id: Uuid,
    pub status: String,
    pub execution_msg_id: Option<Uuid>,
    pub trigger_msg_id: Option<Uuid>,
    /// Only a committed state change has publication effects.
    pub update: Option<ClaimUpdate>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConfirmationMessageUpdate {
    pub msg_id: Uuid,
    pub content_data: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClaimUpdate {
    pub claim_id: Uuid,
    pub channel_id: Uuid,
    pub status: String,
    pub execution_msg_id: Option<Uuid>,
    pub confirmation_message: Option<ConfirmationMessageUpdate>,
}

/// Project a locked claim into its real confirmation, in the caller's transaction.
/// Never lock an arbitrary message before checking its role and ownership: run
/// finalization locks execution messages before claims. Invalid historical links
/// must not invert that order or prevent cancellation from fencing execution.
pub(crate) async fn project_update_tx(
    tx: &mut Transaction<'_, Postgres>,
    claim_id: Uuid,
) -> Result<ClaimUpdate, sqlx::Error> {
    let claim = sqlx::query!(
        "SELECT channel_id,bot_id,status,execution_msg_id,confirmation_message_id,resolved_by,resolution_note
         FROM task_claim_requests WHERE claim_id=$1 FOR UPDATE",
        claim_id.to_string(),
    ).fetch_one(&mut **tx).await?;
    let confirmation = sqlx::query!(
        "SELECT msg_id,content_data FROM messages
         WHERE msg_id=$1 AND channel_id=$2 AND sender_id=$3 AND sender_type='bot'
           AND msg_type='task_claim_confirmation' AND NOT is_partial AND NOT is_deleted AND NOT is_secret
           AND content_data->>'claim_id'=$4 FOR UPDATE",
        claim.confirmation_message_id, claim.channel_id, claim.bot_id, claim_id.to_string(),
    ).fetch_optional(&mut **tx).await?;
    let confirmation_message = if let Some(message) = confirmation {
        let mut data = message.content_data.unwrap_or_default();
        let revision = data
            .get("claim_revision")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| sqlx::Error::Protocol("claim revision overflow".into()))?;
        // The scoped JSON claim-id predicate above only admits object metadata.
        let fields = data
            .as_object_mut()
            .ok_or_else(|| sqlx::Error::Protocol("invalid claim confirmation metadata".into()))?;
        fields.insert("resolved".into(), json!(claim.status != "pending"));
        fields.insert("claim_status".into(), json!(claim.status));
        fields.insert("claim_revision".into(), json!(revision));
        fields.insert("resolved_by".into(), json!(claim.resolved_by));
        fields.insert("resolution_note".into(), json!(claim.resolution_note));
        let decision = match claim.status.as_str() {
            "accepted" | "executing" | "completed" => Some("accept"),
            "rejected" => Some("reject"),
            "cancelled" => Some("cancel"),
            "failed" if claim.resolution_note.as_deref() == Some("expired") => Some("expire"),
            _ => None,
        };
        if let Some(decision) = decision {
            fields.insert("decision".into(), json!(decision));
        }
        sqlx::query!(
            "UPDATE messages SET content_data=$2 WHERE msg_id=$1",
            message.msg_id,
            &data
        )
        .execute(&mut **tx)
        .await?;
        Some(ConfirmationMessageUpdate {
            msg_id: message
                .msg_id
                .parse()
                .map_err(|_| sqlx::Error::Protocol("invalid confirmation id".into()))?,
            content_data: data,
        })
    } else {
        None
    };
    Ok(ClaimUpdate {
        claim_id,
        channel_id: claim
            .channel_id
            .parse()
            .map_err(|_| sqlx::Error::Protocol("invalid claim channel id".into()))?,
        status: claim.status,
        execution_msg_id: claim
            .execution_msg_id
            .map(|id| id.parse())
            .transpose()
            .map_err(|_| sqlx::Error::Protocol("invalid claim execution id".into()))?,
        confirmation_message,
    })
}

pub enum EvaluationDecision {
    Claim { confidence: f64 },
    Ignore,
    Failed { reason: String },
}

pub struct CompleteEvaluationParams {
    pub bot_id: Uuid,
    pub evaluation_id: Uuid,
    pub channel_id: Option<Uuid>,
    pub decision: EvaluationDecision,
}

pub struct CompleteEvaluationOutcome {
    pub data: serde_json::Value,
    pub newly_decided: bool,
}

/// MCP and connector results consume the same scoped evaluation exactly once.
/// The row lock precedes interpretation of a late decision: an empty diagnostic
/// after a successful MCP submission cannot overwrite its committed result.
pub async fn complete_evaluation(
    db: &PgPool,
    params: CompleteEvaluationParams,
) -> Result<CompleteEvaluationOutcome, AppError> {
    // Identify only the authenticated reservation, then retain monitoring before
    // evaluation, matching reservation/recovery maintenance. An already consumed
    // evaluation still reaches its harmless duplicate response before any gate.
    let channel_id = sqlx::query_scalar!(
        "SELECT channel_id FROM task_claim_evaluations
         WHERE evaluation_id=$1 AND bot_id=$2 AND ($3::text IS NULL OR channel_id=$3)",
        params.evaluation_id.to_string(),
        params.bot_id.to_string(),
        params.channel_id.map(|id| id.to_string()),
    )
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)?;
    let channel_id = channel_id
        .parse::<Uuid>()
        .map_err(|_| AppError::Internal("invalid evaluation channel id".into()))?;
    let mut tx = db.begin().await?;
    // Follow parent-before-child FK cascade order. Cache authority here, but do
    // not reject it until after the consumed-evaluation duplicate short circuit.
    let may_claim = task_acceptance::may_execute(&mut tx, params.bot_id, channel_id, None).await?;
    let monitoring = sqlx::query!(
        "SELECT mode,confidence_threshold::float8 AS \"threshold!\" FROM channel_bot_monitoring
         WHERE channel_id=$1 AND bot_id=$2 FOR SHARE",
        channel_id.to_string(),
        params.bot_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await?;
    let evaluation = sqlx::query!(
        "SELECT channel_id,source_seq_to,status FROM task_claim_evaluations
         WHERE evaluation_id=$1 AND bot_id=$2 AND channel_id=$3 FOR UPDATE",
        params.evaluation_id.to_string(),
        params.bot_id.to_string(),
        channel_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    let channel_id = evaluation
        .channel_id
        .parse::<Uuid>()
        .map_err(|_| AppError::Internal("invalid evaluation channel id".into()))?;
    let base = |status: &str| json!({"evaluation_id":params.evaluation_id,"channel_id":channel_id,"status":status});
    if evaluation.status != "dispatched" {
        return Ok(CompleteEvaluationOutcome {
            data: json!({"evaluation_id":params.evaluation_id,"channel_id":channel_id,"duplicate":true}),
            newly_decided: false,
        });
    }
    let confidence = match params.decision {
        EvaluationDecision::Failed { reason } => {
            finish_evaluation(&mut tx, params.evaluation_id, "failed", Some(&reason)).await?;
            tx.commit().await?;
            return Ok(CompleteEvaluationOutcome {
                data: base("failed"),
                newly_decided: true,
            });
        }
        EvaluationDecision::Ignore => {
            finish_evaluation(&mut tx, params.evaluation_id, "ignored", None).await?;
            tx.commit().await?;
            return Ok(CompleteEvaluationOutcome {
                data: base("ignored"),
                newly_decided: true,
            });
        }
        EvaluationDecision::Claim { confidence } => {
            if !confidence.is_finite() {
                return reject_evaluation(
                    tx,
                    params.evaluation_id,
                    AppError::BadRequest("claim confidence must be finite".into()),
                )
                .await;
            }
            confidence.clamp(0.0, 1.0)
        }
    };
    let Some(monitoring) = monitoring else {
        return reject_evaluation(
            tx,
            params.evaluation_id,
            AppError::Conflict("task-claim monitoring is no longer configured".into()),
        )
        .await;
    };
    if monitoring.mode == "off" {
        return reject_evaluation(
            tx,
            params.evaluation_id,
            AppError::Conflict("task-claim monitoring is off".into()),
        )
        .await;
    }
    if confidence < monitoring.threshold {
        finish_evaluation(
            &mut tx,
            params.evaluation_id,
            "ignored",
            Some("below confidence threshold"),
        )
        .await?;
        tx.commit().await?;
        return Ok(CompleteEvaluationOutcome {
            data: base("ignored"),
            newly_decided: true,
        });
    }
    let source = sqlx::query!(
        "SELECT m.msg_id,m.sender_id,m.content,u.username FROM messages m
         JOIN users u ON u.user_id=m.sender_id
         WHERE m.channel_id=$1 AND m.channel_seq=$2 AND m.sender_type='user'
           AND m.is_partial=FALSE AND m.is_deleted=FALSE AND m.is_secret=FALSE
         FOR SHARE OF m,u",
        channel_id.to_string(),
        evaluation.source_seq_to,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(source) = source else {
        return reject_evaluation(
            tx,
            params.evaluation_id,
            AppError::BadRequest("claim evaluation source is not an available user message".into()),
        )
        .await;
    };
    let summary: String = source.content.trim().chars().take(1000).collect();
    if summary.is_empty() {
        return reject_evaluation(
            tx,
            params.evaluation_id,
            AppError::BadRequest("claim source message is empty".into()),
        )
        .await;
    }
    if !may_claim {
        return reject_evaluation(
            tx,
            params.evaluation_id,
            AppError::Forbidden("bot may no longer create task claims here".into()),
        )
        .await;
    }
    // The requester is the real source author. Use the same policy command as
    // scheduler admission and ordinary human dispatch, after source/bot locks.
    let requester = source
        .sender_id
        .parse::<Uuid>()
        .map_err(|_| AppError::Internal("invalid evaluation requester id".into()))?;
    match message_policy::reauthorize_human_intent_tx(&mut tx, requester, channel_id, params.bot_id)
        .await
    {
        Ok(()) => {}
        Err(message_policy::HumanIntentPolicyError::Denied(error)) => {
            return reject_evaluation(tx, params.evaluation_id, error).await;
        }
        Err(message_policy::HumanIntentPolicyError::Retryable(error)) => return Err(error),
    }
    let bot_name = sqlx::query_scalar!(
        "SELECT COALESCE(NULLIF(display_name,''),username) AS \"name!\" FROM bot_accounts WHERE bot_id=$1",
        params.bot_id.to_string(),
    )
    .fetch_one(&mut *tx)
    .await?;
    let claim_id = Uuid::new_v4();
    let confirmation_id = Uuid::new_v4();
    let action = "Start the requested work and report the result in this channel.";
    let impact = "medium";
    finish_evaluation(&mut tx, params.evaluation_id, "completed", None).await?;
    sqlx::query!(
        "INSERT INTO task_claim_requests(claim_id,evaluation_id,channel_id,bot_id,summary,proposed_action,confidence,impact,requester_id,source_message_id,confirmation_message_id)
         VALUES($1,$2,$3,$4,$5,$6,$7::float8,$8,$9,$10,$11)",
        claim_id.to_string(), params.evaluation_id.to_string(), channel_id.to_string(),
        params.bot_id.to_string(), &summary, action, confidence, impact,
        &source.sender_id, &source.msg_id, confirmation_id.to_string(),
    ).execute(&mut *tx).await?;
    let seq = super::channel_seq::allocate(&mut tx, channel_id).await?;
    let content = format!(
        "@{} {bot_name} 想认领这个任务：{summary}\n\n{action}",
        source.username,
    );
    let data = json!({"claim_id":claim_id,"requester_id":source.sender_id,
        "summary":summary,"proposed_action":action,"confidence":confidence,
        "impact":impact,"resolved":false,"claim_status":"pending","claim_revision":1});
    let confirmation = sqlx::query!(
        "INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_partial,is_deleted,in_reply_to_msg_id,created_at,channel_seq,content_data)
         VALUES($1,$2,$3,'bot',$4,'task_claim_confirmation',FALSE,FALSE,$5,NOW(),$6,$7)
         RETURNING created_at",
        confirmation_id.to_string(), channel_id.to_string(), params.bot_id.to_string(),
        &content, &source.msg_id, seq, &data,
    ).fetch_one(&mut *tx).await?;
    sqlx::query!(
        "INSERT INTO message_mentions(msg_id,member_id,member_type) VALUES($1,$2,'user')",
        confirmation_id.to_string(),
        &source.sender_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(CompleteEvaluationOutcome {
        data: json!({"claim_id":claim_id,"evaluation_id":params.evaluation_id,
            "channel_id":channel_id,"bot_id":params.bot_id,"summary":summary,
            "proposed_action":action,"confidence":confidence,"impact":impact,"status":"pending",
            "confirmation_message":{"msg_id":confirmation_id,"channel_id":channel_id,
                "channel_seq":seq,"sender_type":"bot","sender_id":params.bot_id,
                "sender_name":bot_name,"content":content,"msg_type":"task_claim_confirmation",
                "is_partial":false,"created_at":confirmation.created_at.to_rfc3339(),
                "reply_to_msg_id":source.msg_id,"mentions":[{"member_id":source.sender_id,"member_type":"user"}],
                "content_data":data}}),
        newly_decided: true,
    })
}

/// An authenticated evaluation's deterministic refusal is itself a decision.
/// Persist it before returning the adapter error; DB/commit failures instead
/// leave the reservation dispatched so the same owned request can retry.
async fn reject_evaluation(
    mut tx: Transaction<'_, Postgres>,
    evaluation_id: Uuid,
    error: AppError,
) -> Result<CompleteEvaluationOutcome, AppError> {
    finish_evaluation(&mut tx, evaluation_id, "failed", Some(&error.to_string())).await?;
    tx.commit().await?;
    Err(error)
}

async fn finish_evaluation(
    tx: &mut Transaction<'_, Postgres>,
    evaluation_id: Uuid,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    let changed = sqlx::query!(
        "UPDATE task_claim_evaluations SET status=$2,error=$3,completed_at=NOW()
         WHERE evaluation_id=$1 AND status='dispatched'",
        evaluation_id.to_string(),
        status,
        error,
    )
    .execute(&mut **tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "task-claim evaluation was already decided".into(),
        ));
    }
    Ok(())
}

/// Admission performs pool-based policy/readiness checks before retaining a
/// transaction connection. Network/media preparation belongs to the worker.
pub async fn resolve(
    db: &PgPool,
    locator: &dyn BotLocator,
    params: ResolveClaimParams,
) -> Result<ResolveClaimOutcome, AppError> {
    let preflight = sqlx::query!(
        "SELECT bot_id,requester_id,status FROM task_claim_requests WHERE claim_id=$1 AND channel_id=$2",
        params.claim_id.to_string(), params.channel_id.to_string(),
    ).fetch_optional(db).await?.ok_or(AppError::NotFound)?;
    if preflight.requester_id.as_deref() != Some(params.requester_id.to_string().as_str()) {
        return Err(AppError::Forbidden(
            "only the mentioned task requester can resolve this claim".into(),
        ));
    }
    if preflight.status != "pending" {
        return Err(AppError::Conflict("claim is no longer pending".into()));
    }
    let bot_id: Uuid = preflight
        .bot_id
        .parse()
        .map_err(|_| AppError::Internal("invalid claim bot id".into()))?;
    let selected_session = if params.decision == ClaimDecision::Accept {
        message_policy::reauthorize_human_intent(
            db,
            params.requester_id,
            params.channel_id,
            bot_id,
        )
        .await
        .map_err(|error| match error {
            message_policy::HumanIntentPolicyError::Denied(error)
            | message_policy::HumanIntentPolicyError::Retryable(error) => error,
        })?;
        if !locator.is_online(bot_id).await {
            return Err(AppError::Conflict(
                "the mentioned bot is currently offline".into(),
            ));
        }
        if !locator.supports_task_acceptance(bot_id).await {
            return Err(AppError::Conflict(
                "the mentioned bot is not ready to accept tasks; reconnect or upgrade its connector"
                    .into(),
            ));
        }
        Some(
            sessions::resolve_primary_session(db, bot_id, &params.channel_id.to_string())
                .await?
                .ok_or_else(|| AppError::Conflict("bot has no primary channel session".into()))?,
        )
    } else {
        None
    };

    let mut tx = db.begin().await?;
    let claim = sqlx::query!(
        "SELECT bot_id,requester_id,status,summary,proposed_action,source_message_id,confirmation_message_id,
                superseded_at,expires_at
         FROM task_claim_requests WHERE claim_id=$1 AND channel_id=$2 FOR UPDATE",
        params.claim_id.to_string(), params.channel_id.to_string(),
    ).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
    if claim.requester_id.as_deref() != Some(params.requester_id.to_string().as_str())
        || claim.bot_id != bot_id.to_string()
    {
        return Err(AppError::Forbidden("claim requester or bot changed".into()));
    }
    let now = sqlx::query_scalar!("SELECT clock_timestamp() AS \"now!\"")
        .fetch_one(&mut *tx)
        .await?;
    if claim.status != "pending"
        || claim.expires_at.is_some_and(|expiry| expiry <= now)
        || claim.superseded_at.is_some()
    {
        return Err(AppError::Conflict("claim is no longer pending".into()));
    }
    let author = sqlx::query!(
        "SELECT is_suspended,is_deleted,username,display_name FROM users WHERE user_id=$1 FOR SHARE",
        params.requester_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await?;
    let member = sqlx::query!(
        "SELECT role FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='user' FOR SHARE",
        params.channel_id.to_string(), params.requester_id.to_string(),
    ).fetch_optional(&mut *tx).await?;
    if !author
        .as_ref()
        .is_some_and(|author| !author.is_suspended && !author.is_deleted)
        || !member.is_some_and(|member| {
            params.decision == ClaimDecision::Reject
                || crate::resource::role_can_write(&member.role)
        })
    {
        return Err(AppError::Forbidden(
            "claim requester may no longer act here".into(),
        ));
    }

    let sender_name = author.map(|author| {
        author
            .display_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(author.username)
    });
    let mut execution_msg_id = None;
    let mut trigger_msg_id = None;
    let status = if params.decision == ClaimDecision::Accept {
        let source_id = claim
            .source_message_id
            .as_deref()
            .ok_or_else(|| AppError::Conflict("claim has no source message".into()))?;
        let confirmation_id = claim
            .confirmation_message_id
            .as_deref()
            .ok_or_else(|| AppError::Conflict("claim has no confirmation message".into()))?;
        let source = sqlx::query!(
            "SELECT sender_id,sender_type,is_deleted,is_partial,is_secret,channel_seq FROM messages
             WHERE msg_id=$1 AND channel_id=$2 FOR SHARE",
            source_id,
            params.channel_id.to_string(),
        )
        .fetch_optional(&mut *tx)
        .await?;
        if !source.is_some_and(|source| {
            source.sender_id == params.requester_id.to_string()
                && source.sender_type == "user"
                && !source.is_deleted
                && !source.is_partial
                && !source.is_secret
                && source.channel_seq.is_some()
        }) {
            return Err(AppError::Conflict(
                "claim source message is no longer available".into(),
            ));
        }
        let confirmation = sqlx::query!(
            "SELECT sender_id,sender_type,msg_type,is_deleted,is_partial,content_data FROM messages
             WHERE msg_id=$1 AND channel_id=$2 FOR SHARE",
            confirmation_id,
            params.channel_id.to_string(),
        )
        .fetch_optional(&mut *tx)
        .await?;
        if !confirmation.is_some_and(|message| {
            message.sender_id == bot_id.to_string()
                && message.sender_type == "bot"
                && message.msg_type == "task_claim_confirmation"
                && !message.is_deleted
                && !message.is_partial
                && message
                    .content_data
                    .as_ref()
                    .and_then(|data| data.get("claim_id"))
                    .and_then(serde_json::Value::as_str)
                    == Some(params.claim_id.to_string().as_str())
        }) {
            return Err(AppError::Conflict(
                "claim confirmation is no longer available".into(),
            ));
        }
        if !task_acceptance::may_execute(&mut tx, bot_id, params.channel_id, None).await? {
            return Err(AppError::Forbidden(
                "bot may no longer execute this claim".into(),
            ));
        }
        let session =
            sessions::resolve_primary_session_tx(&mut tx, bot_id, &params.channel_id.to_string())
                .await?
                .ok_or_else(|| AppError::Conflict("bot has no primary channel session".into()))?;
        if selected_session.as_ref().is_none_or(|(id, key)| {
            *id != session.session_id || key != &session.provider_session_key
        }) {
            return Err(AppError::Conflict("bot primary session changed".into()));
        }
        let trigger_id = dispatch_intents::claim_trigger_id(params.claim_id);
        let placeholder_id = dispatcher::derive_placeholder_id(trigger_id, bot_id);
        let chain_id =
            task_chains::start_chain_tx(&mut tx, params.channel_id, trigger_id, trigger_id).await?;
        let bundle = context_bundle::finalize_bundle_for_target_tx(
            &mut tx,
            &json!({"kind":"task_claim","claim_id":params.claim_id,
                "summary":claim.summary,"proposed_action":claim.proposed_action,"items":[]}),
            Principal::bot(bot_id),
            params.channel_id,
        )
        .await?;
        let content = format!(
            "Approved proactive task claim.\nSummary: {}\nRequested action: {}\nComplete the requested work and report the result in this channel.",
            claim.summary, claim.proposed_action,
        );
        let trigger = sqlx::query!(
            "INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_secret,is_partial,chain_id,content_data,context_bundle)
             VALUES($1,$2,$3,'user',$4,'task_claim',TRUE,FALSE,$5,$6,$7) RETURNING created_at",
            trigger_id.to_string(), params.channel_id.to_string(),params.requester_id.to_string(),
            content,chain_id.to_string(),json!({"claim_id":params.claim_id}),bundle,
        ).fetch_one(&mut *tx).await?;
        dispatch_intents::enqueue_claim(
            &mut tx,
            ClaimIntent {
                version: 2,
                claim_id: params.claim_id,
                requester_id: params.requester_id,
                params: DispatchParams {
                    trigger_msg_id: trigger_id,
                    trigger_seq: 0,
                    bot_id,
                    channel_id: params.channel_id,
                    depth: 0,
                    provider_session_key: session.provider_session_key,
                    session_id: Some(session.session_id),
                    chain_id: Some(chain_id.to_string()),
                    context_bundle: Some(bundle),
                },
                trigger_message: json!({"msg_id":trigger_id,"user":params.requester_id,"sender_name":sender_name,
                    "text":content,"timestamp":trigger.created_at.to_rfc3339(),
                    "msg_type":"task_claim","in_reply_to_msg_id":null}),
                file_ids: vec![],
            },
        )
        .await?;
        execution_msg_id = Some(placeholder_id);
        trigger_msg_id = Some(trigger_id);
        "executing"
    } else {
        "rejected"
    };
    let changed = sqlx::query!(
        "UPDATE task_claim_requests SET status=$2,resolved_by=$3,resolution_note=$4,
             resolved_at=NOW(),updated_at=NOW(),execution_msg_id=$5
         WHERE claim_id=$1 AND status='pending' AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at>clock_timestamp())",
        params.claim_id.to_string(),
        status,
        params.requester_id.to_string(),
        params.note,
        execution_msg_id.map(|id| id.to_string()),
    )
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::Conflict("claim is no longer pending".into()));
    }
    let update = project_update_tx(&mut tx, params.claim_id).await?;
    tx.commit().await?;
    Ok(ResolveClaimOutcome {
        claim_id: params.claim_id,
        status: status.into(),
        execution_msg_id,
        trigger_msg_id,
        update: Some(update),
    })
}

/// The transport authorizes channel administration before invoking cancellation.
/// Do not lock a run or chain after the claim: grant/finalization lock those first.
pub async fn cancel(
    db: &PgPool,
    channel_id: Uuid,
    claim_id: Uuid,
    actor_id: Uuid,
    note: Option<&str>,
) -> Result<ResolveClaimOutcome, AppError> {
    let mut tx = db.begin().await?;
    let changed = sqlx::query!(
        "UPDATE task_claim_requests SET status='cancelled',resolved_by=$3,resolution_note=$4,
             resolved_at=NOW(),updated_at=NOW()
         WHERE claim_id=$1 AND channel_id=$2 AND status IN ('pending','executing') RETURNING claim_id",
        claim_id.to_string(),channel_id.to_string(),actor_id.to_string(),note,
    ).fetch_optional(&mut *tx).await?;
    if changed.is_none() {
        let claim = sqlx::query!(
            "SELECT status,execution_msg_id FROM task_claim_requests WHERE claim_id=$1 AND channel_id=$2",
            claim_id.to_string(), channel_id.to_string(),
        ).fetch_optional(&mut *tx).await?.ok_or(AppError::NotFound)?;
        if claim.status != "cancelled" {
            return Err(AppError::Conflict("claim is no longer pending".into()));
        }
        tx.commit().await?;
        return Ok(ResolveClaimOutcome {
            claim_id,
            status: claim.status,
            execution_msg_id: claim
                .execution_msg_id
                .map(|id| id.parse())
                .transpose()
                .map_err(|_| AppError::Internal("invalid claim execution id".into()))?,
            trigger_msg_id: None,
            update: None,
        });
    }
    let update = project_update_tx(&mut tx, claim_id).await?;
    tx.commit().await?;
    Ok(ResolveClaimOutcome {
        claim_id,
        status: update.status.clone(),
        execution_msg_id: update.execution_msg_id,
        trigger_msg_id: None,
        update: Some(update),
    })
}

/// Finite deadlines remain opt-in data. The sweep updates the same projection
/// as interactive actions and skips a claim whose decision is still committing.
pub async fn expire(db: &PgPool) -> Result<Vec<ClaimUpdate>, AppError> {
    let mut tx = db.begin().await?;
    let claims = sqlx::query!(
        "SELECT claim_id FROM task_claim_requests
         WHERE status IN ('pending','executing') AND expires_at IS NOT NULL AND expires_at<=clock_timestamp()
         ORDER BY claim_id LIMIT 100 FOR UPDATE SKIP LOCKED",
    ).fetch_all(&mut *tx).await?;
    let mut updates = Vec::with_capacity(claims.len());
    for claim in claims {
        sqlx::query!(
            "UPDATE task_claim_requests SET status='failed',resolution_note='expired',
                 resolved_at=COALESCE(resolved_at,NOW()),updated_at=NOW()
             WHERE claim_id=$1",
            claim.claim_id,
        )
        .execute(&mut *tx)
        .await?;
        let id = claim
            .claim_id
            .parse()
            .map_err(|_| AppError::Internal("invalid claim id".into()))?;
        updates.push(project_update_tx(&mut tx, id).await?);
    }
    tx.commit().await?;
    Ok(updates)
}

/// Failed delivery and abandoned executions share the persisted execution link.
/// Recovery validates identity without requiring permission to keep executing.
pub(crate) async fn fail_execution_tx(
    tx: &mut Transaction<'_, Postgres>,
    expected_claim: Option<Uuid>,
    msg_id: Uuid,
    bot_id: Uuid,
    channel_id: Uuid,
    reason: &str,
) -> Result<Option<ClaimUpdate>, sqlx::Error> {
    fail_execution_with_policy_tx(
        tx,
        expected_claim,
        msg_id,
        bot_id,
        channel_id,
        reason,
        MissingClaimPolicy::Reject,
    )
    .await
}

/// The reclaimer has already proven the abandoned message/run tuple. A broken
/// claim reference must not strand that execution, or authorize changing a
/// different claim. Ordinary delivery cancellation keeps the strict entrypoint.
pub(crate) async fn fail_orphaned_execution_tx(
    tx: &mut Transaction<'_, Postgres>,
    expected_claim: Option<Uuid>,
    msg_id: Uuid,
    bot_id: Uuid,
    channel_id: Uuid,
    reason: &str,
) -> Result<Option<ClaimUpdate>, sqlx::Error> {
    fail_execution_with_policy_tx(
        tx,
        expected_claim,
        msg_id,
        bot_id,
        channel_id,
        reason,
        MissingClaimPolicy::ReclaimOrphan,
    )
    .await
}

#[derive(Clone, Copy)]
enum MissingClaimPolicy {
    Reject,
    ReclaimOrphan,
}

async fn fail_execution_with_policy_tx(
    tx: &mut Transaction<'_, Postgres>,
    expected_claim: Option<Uuid>,
    msg_id: Uuid,
    bot_id: Uuid,
    channel_id: Uuid,
    reason: &str,
    policy: MissingClaimPolicy,
) -> Result<Option<ClaimUpdate>, sqlx::Error> {
    let claims = sqlx::query!(
        "SELECT claim_id,bot_id,channel_id,status FROM task_claim_requests
         WHERE execution_msg_id=$1 ORDER BY claim_id FOR UPDATE",
        msg_id.to_string(),
    )
    .fetch_all(&mut **tx)
    .await?;
    let Some(claim) = claims.first() else {
        return if expected_claim.is_some() && matches!(policy, MissingClaimPolicy::Reject) {
            Err(sqlx::Error::Protocol(
                "task claim execution link is missing".into(),
            ))
        } else {
            Ok(None)
        };
    };
    if claims.len() != 1
        || expected_claim.is_some_and(|id| claim.claim_id != id.to_string())
        || claim.bot_id != bot_id.to_string()
        || claim.channel_id != channel_id.to_string()
    {
        if matches!(policy, MissingClaimPolicy::ReclaimOrphan) {
            tracing::warn!(%msg_id, %bot_id, %channel_id, ?expected_claim,
                "reclaiming abandoned execution without changing inconsistent task claims");
            return Ok(None);
        }
        return Err(sqlx::Error::Protocol(
            "inconsistent task claim execution link".into(),
        ));
    }
    if claim.status != "executing" {
        return Ok(None);
    }
    let id = claim
        .claim_id
        .parse()
        .map_err(|_| sqlx::Error::Protocol("invalid claim id".into()))?;
    sqlx::query!(
        "UPDATE task_claim_requests SET status='failed',
             resolution_note=COALESCE(resolution_note,$2),updated_at=NOW()
         WHERE claim_id=$1",
        claim.claim_id,
        reason,
    )
    .execute(&mut **tx)
    .await?;
    Ok(Some(project_update_tx(tx, id).await?))
}

/// Shared claim fence for delivery/grant/result commits. Legacy accepted claims
/// can be found by their real execution link even without a placeholder marker.
pub(crate) async fn lock_execution_claim(
    tx: &mut Transaction<'_, Postgres>,
    expected_claim: Option<Uuid>,
    msg_id: Uuid,
    bot_id: Uuid,
    channel_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    let claims = sqlx::query!(
        "SELECT claim_id,bot_id,channel_id,execution_msg_id,status,superseded_at,expires_at
         FROM task_claim_requests WHERE execution_msg_id=$1 OR claim_id=$2 ORDER BY claim_id FOR UPDATE",
        msg_id.to_string(),expected_claim.map(|id| id.to_string()),
    ).fetch_all(&mut **tx).await?;
    let Some(claim) = claims.first() else {
        return if expected_claim.is_some() {
            Err(AppError::NotFound)
        } else {
            Ok(None)
        };
    };
    // PostgreSQL evaluates projection expressions before a row-lock wait. Read
    // wall time after every selected claim is locked, so expiry during that wait
    // cannot authorize a new grant or terminal result.
    let now = sqlx::query_scalar!("SELECT clock_timestamp() AS \"now!\"")
        .fetch_one(&mut **tx)
        .await?;
    if claims.len() != 1
        || expected_claim.is_some_and(|expected| claim.claim_id != expected.to_string())
        || claim.execution_msg_id.as_deref() != Some(msg_id.to_string().as_str())
        || claim.status != "executing"
        || claim.expires_at.is_some_and(|expiry| expiry <= now)
        || claim.superseded_at.is_some()
    {
        return Err(AppError::Conflict(
            "task claim is no longer executable".into(),
        ));
    }
    if claim.bot_id != bot_id.to_string() || claim.channel_id != channel_id.to_string() {
        return Err(AppError::Forbidden(
            "task claim belongs to another bot or channel".into(),
        ));
    }
    Ok(Some(claim.claim_id.parse().map_err(|_| {
        AppError::Internal("invalid persisted claim id".into())
    })?))
}
