//! Recoverable offers for human-message targets, using the existing run ledger.
//! Only explicitly marked, unaccepted runs are recoverable. Acceptance remains
//! the durable execution fence; a queued offer never proves delivery/execution.

use std::{sync::Arc, time::Duration};

use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    domain::{
        message_policy::{self, HumanIntentPolicyError},
        sessions,
    },
    errors::AppError,
    gateway::{
        dispatcher::{self, DispatchParams, MediaCache},
        realtime::{fanout::Fanout, frame::WireFrame},
        registry::BotLocator,
        stream::{StreamEntry, StreamRegistry},
    },
};

#[derive(Clone, Serialize, Deserialize)]
pub struct HumanIntent {
    pub version: u32,
    pub author_id: Uuid,
    pub params: DispatchParams,
    pub trigger_message: Value,
    pub file_ids: Vec<String>,
}

impl HumanIntent {
    fn validate(&self) -> Result<(), AppError> {
        if self.version != 1
            || self.params.depth != 0
            || self.params.session_id.is_none()
            || self.params.chain_id.is_none()
            || self.params.provider_session_key.trim().is_empty()
            || self.trigger_message.get("msg_id").and_then(Value::as_str)
                != Some(self.params.trigger_msg_id.to_string().as_str())
            || self.trigger_message.get("user").and_then(Value::as_str)
                != Some(self.author_id.to_string().as_str())
            || self
                .trigger_message
                .get("text")
                .and_then(Value::as_str)
                .is_none()
        {
            return Err(AppError::BadRequest(
                "invalid durable human dispatch intent".into(),
            ));
        }
        Ok(())
    }
}

/// Called in the human message's transaction. No network/media IO and no BUSY
/// transition occurs here. An existing tombstone always retains its identity.
pub async fn enqueue_human(
    tx: &mut Transaction<'_, Postgres>,
    intent: HumanIntent,
) -> Result<Uuid, AppError> {
    intent.validate()?;
    let params = &intent.params;
    let task_id = Uuid::new_v4();
    let placeholder_id = dispatcher::derive_placeholder_id(params.trigger_msg_id, params.bot_id);
    let input =
        serde_json::to_value(&intent).map_err(|error| AppError::Internal(error.to_string()))?;
    let inserted = sqlx::query!(
        "INSERT INTO bot_runs
         (bot_run_id,task_id,channel_id,trigger_msg_id,bot_id,placeholder_msg_id,binding_type,status,chain_id,dispatch_input,next_offer_at)
         VALUES($1,$1,$2,$3,$4,$5,'acp','pending',$6,$7,NOW())
         ON CONFLICT(placeholder_msg_id) DO NOTHING",
        task_id.to_string(), params.channel_id.to_string(), params.trigger_msg_id.to_string(),
        params.bot_id.to_string(), placeholder_id.to_string(), params.chain_id, input,
    ).execute(&mut **tx).await?;
    if inserted.rows_affected() == 0 {
        let original = sqlx::query_scalar!(
            "SELECT task_id FROM bot_runs WHERE placeholder_msg_id=$1",
            placeholder_id.to_string()
        )
        .fetch_one(&mut **tx)
        .await?;
        return original
            .parse()
            .map_err(|_| AppError::Internal("invalid durable task identity".into()));
    }
    sqlx::query!(
        "INSERT INTO messages
         (msg_id,task_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,depth,chain_id,context_bundle,in_reply_to_msg_id,content_data)
         VALUES($1,$2,$3,'bot',$4,'','text',TRUE,0,$5,$6,$7,$8)",
        placeholder_id.to_string(), task_id.to_string(), params.channel_id.to_string(),
        params.bot_id.to_string(), params.chain_id, params.context_bundle,
        params.trigger_msg_id.to_string(), params.session_id.map(|sid| json!({"session_id":sid})),
    ).execute(&mut **tx).await?;
    Ok(task_id)
}

/// Full pool-based human policy is evaluated before acquiring any run locks.
/// The fixed target is rechecked; routing and UI source versions are not rerun.
pub(crate) async fn preauthorize(
    db: &PgPool,
    input: &Value,
) -> Result<HumanIntent, HumanIntentPolicyError> {
    use HumanIntentPolicyError::{Denied, Retryable};
    let intent: HumanIntent = serde_json::from_value(input.clone())
        .map_err(|error| Denied(AppError::BadRequest(error.to_string())))?;
    intent.validate().map_err(Denied)?;
    message_policy::reauthorize_human_intent(
        db,
        intent.author_id,
        intent.params.channel_id,
        intent.params.bot_id,
    )
    .await?;
    if let Some(bundle) = &intent.params.context_bundle {
        let principal = crate::resource::Principal::bot(intent.params.bot_id);
        for item in crate::domain::context_bundle::bundle_items(bundle) {
            let channel = item
                .get("params")
                .and_then(|params| params.get("channel_id"))
                .and_then(Value::as_str)
                .and_then(|id| id.parse().ok())
                .unwrap_or(intent.params.channel_id);
            if let Err((code, detail)) =
                crate::resource::authorize_channel_read(db, &principal, channel).await
            {
                return Err(if code == "INTERNAL_ERROR" {
                    Retryable(AppError::Internal(detail))
                } else {
                    Denied(AppError::Forbidden(detail))
                });
            }
        }
        let current = crate::domain::context_bundle::finalize_bundle_for_target(
            db,
            bundle,
            principal,
            intent.params.channel_id,
        )
        .await;
        if &current != bundle {
            // Every reference was authorized above. The shared best-effort
            // finalizer can drop an item after a transient second read fails;
            // never turn that DB fault into permanent cancellation/data loss.
            return Err(Retryable(AppError::Internal(
                "dispatch context could not be reproduced consistently".into(),
            )));
        }
    }
    Ok(intent)
}

/// Held through offer preparation / execution grant commit. The pool-based
/// policy above must already have succeeded; this fences mutable row authority
/// without requesting a second pool connection while holding locks.
pub(crate) async fn authorize_locked(
    tx: &mut Transaction<'_, Postgres>,
    intent: &HumanIntent,
) -> Result<bool, sqlx::Error> {
    let params = &intent.params;
    let source = sqlx::query!(
        "SELECT sender_id,sender_type,is_deleted FROM messages
         WHERE msg_id=$1 AND channel_id=$2 FOR SHARE",
        params.trigger_msg_id.to_string(),
        params.channel_id.to_string(),
    )
    .fetch_optional(&mut **tx)
    .await?;
    if !source.is_some_and(|source| {
        source.sender_id == intent.author_id.to_string()
            && source.sender_type == "user"
            && !source.is_deleted
    }) {
        return Ok(false);
    }
    let author = sqlx::query!(
        "SELECT is_suspended,is_deleted FROM users WHERE user_id=$1 FOR SHARE",
        intent.author_id.to_string()
    )
    .fetch_optional(&mut **tx)
    .await?;
    if !author.is_some_and(|author| !author.is_suspended && !author.is_deleted) {
        return Ok(false);
    }
    let member = sqlx::query!(
        "SELECT role FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='user' FOR SHARE",
        params.channel_id.to_string(), intent.author_id.to_string(),
    ).fetch_optional(&mut **tx).await?;
    if !member.is_some_and(|member| crate::resource::role_can_write(&member.role)) {
        return Ok(false);
    }
    let Some(session_id) = params.session_id else {
        return Ok(false);
    };
    let session = sqlx::query!(
        "SELECT provider_session_key,status FROM cheers_sessions WHERE session_id=$1 AND bot_id=$2 FOR UPDATE",
        session_id.to_string(), params.bot_id.to_string(),
    ).fetch_optional(&mut **tx).await?;
    if !session.is_some_and(|session| {
        session.provider_session_key == params.provider_session_key
            && !matches!(
                session.status.as_str(),
                "terminated" | "revoked" | "expired"
            )
    }) {
        return Ok(false);
    }
    let bound = sqlx::query!(
        "SELECT binding_id FROM cheers_session_bindings
         WHERE session_id=$1 AND bot_id=$2 AND scope_type='channel' AND scope_id=$3 FOR SHARE",
        session_id.to_string(),
        params.bot_id.to_string(),
        params.channel_id.to_string(),
    )
    .fetch_optional(&mut **tx)
    .await?;
    if bound.is_none() || params.chain_id.is_none() {
        return Ok(false);
    }
    let files = sqlx::query!(
        "SELECT file_id,status,expires_at FROM file_records
         WHERE file_id=ANY($1) AND channel_id=$2 AND uploader_id=$3 FOR SHARE",
        &intent.file_ids,
        params.channel_id.to_string(),
        intent.author_id.to_string(),
    )
    .fetch_all(&mut **tx)
    .await?;
    if intent.file_ids.iter().any(|id| {
        !files.iter().any(|file| {
            &file.file_id == id
                && file.status == "uploaded"
                && file
                    .expires_at
                    .is_none_or(|expiry| expiry > chrono::Utc::now())
        })
    }) {
        return Ok(false);
    }
    super::task_acceptance::may_execute(
        tx,
        params.bot_id,
        params.channel_id,
        params.chain_id.as_deref(),
    )
    .await
}

#[derive(sqlx::FromRow)]
struct Claimed {
    bot_run_id: String,
    task_id: String,
    placeholder_msg_id: String,
    dispatch_input: Value,
    task_frame: Option<Value>,
}

async fn claim_due(
    db: &PgPool,
    trigger: Option<Uuid>,
    lease: Uuid,
) -> Result<Vec<Claimed>, sqlx::Error> {
    sqlx::query_as!(Claimed,
        r#"WITH due AS (
             SELECT bot_run_id FROM bot_runs
             WHERE dispatch_input IS NOT NULL AND status IN ('pending','prepared')
               AND execution_id IS NULL AND accepted_at IS NULL
               AND next_offer_at <= NOW()
               AND (dispatch_lease_until IS NULL OR dispatch_lease_until < NOW())
               AND ($1::text IS NULL OR trigger_msg_id=$1)
             ORDER BY next_offer_at,created_at,bot_run_id LIMIT 4 FOR UPDATE SKIP LOCKED
           )
           UPDATE bot_runs r SET dispatch_lease_id=$2,dispatch_lease_until=NOW()+INTERVAL '60 seconds'
           FROM due WHERE r.bot_run_id=due.bot_run_id
           RETURNING r.bot_run_id,r.task_id,r.placeholder_msg_id,
                     r.dispatch_input AS "dispatch_input!",r.task_frame"#,
        trigger.map(|id| id.to_string()), lease.to_string(),
    ).fetch_all(db).await
}

async fn release(db: &PgPool, run: &Claimed, lease: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "UPDATE bot_runs SET dispatch_lease_id=NULL,dispatch_lease_until=NULL,next_offer_at=NOW()+INTERVAL '5 seconds'
         WHERE bot_run_id=$1 AND dispatch_lease_id=$2 AND status IN ('pending','prepared')
           AND execution_id IS NULL AND accepted_at IS NULL",
        run.bot_run_id, lease.to_string(),
    ).execute(db).await?;
    Ok(())
}

async fn cancel(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &StreamRegistry,
    run: &Claimed,
    lease: Uuid,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query!(
        "SELECT msg_id FROM messages WHERE msg_id=$1 FOR UPDATE",
        run.placeholder_msg_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let canceled = sqlx::query!(
        "UPDATE bot_runs SET status='cancelled',error_message=$3,dispatch_input=NULL,task_frame=NULL,
         next_offer_at=NULL,dispatch_lease_id=NULL,dispatch_lease_until=NULL,updated_at=NOW()
         WHERE bot_run_id=$1 AND dispatch_lease_id=$2 AND status IN ('pending','prepared')
           AND execution_id IS NULL AND accepted_at IS NULL RETURNING channel_id,bot_id",
        run.bot_run_id, lease.to_string(), reason,
    ).fetch_optional(&mut *tx).await?;
    let Some(canceled) = canceled else {
        return Ok(());
    };
    sqlx::query!(
        "DELETE FROM messages WHERE msg_id=$1 AND is_partial=TRUE AND channel_seq IS NULL",
        run.placeholder_msg_id
    )
    .execute(&mut *tx)
    .await?;
    if let Ok(intent) = serde_json::from_value::<HumanIntent>(run.dispatch_input.clone()) {
        if let Some(session) = intent.params.session_id {
            sessions::finalize_session_without_active_turns_tx(&mut tx, session)
                .await
                .map_err(|error| match error {
                    AppError::Db(error) => error,
                    other => sqlx::Error::Protocol(other.to_string()),
                })?;
        }
    }
    tx.commit().await?;
    if let (Ok(msg), Ok(task), Ok(channel), Ok(bot)) = (
        run.placeholder_msg_id.parse(),
        run.task_id.parse(),
        canceled.channel_id.parse(),
        canceled.bot_id.parse(),
    ) {
        registry.remove_task(msg, task);
        fanout
            .broadcast_channel(
                channel,
                dispatcher::bot_unavailable_frame(channel, msg, bot),
            )
            .await;
    }
    Ok(())
}

fn valid_frame(frame: &Value, intent: &HumanIntent, task: Uuid, placeholder: Uuid) -> bool {
    matches!(serde_json::from_value::<cheers_bridge_protocol::ControlInbound>(frame.clone()),
        Ok(cheers_bridge_protocol::ControlInbound::Task {
            task_id,channel_id,trigger_msg_id,placeholder_msg_id,provider_session_key,session_id,acceptance_required:true,..
        }) if task_id == task.to_string() && channel_id == intent.params.channel_id.to_string()
            && trigger_msg_id == intent.params.trigger_msg_id.to_string() && placeholder_msg_id == placeholder.to_string()
            && provider_session_key == intent.params.provider_session_key && session_id == intent.params.session_id.map(|id|id.to_string()))
}

async fn attempt(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &StreamRegistry,
    locator: &Arc<dyn BotLocator>,
    run: &Claimed,
    lease: Uuid,
    cache: &MediaCache,
) -> Result<bool, AppError> {
    let intent = match preauthorize(db, &run.dispatch_input).await {
        Ok(intent) => intent,
        Err(HumanIntentPolicyError::Denied(error)) => {
            cancel(db, fanout, registry, run, lease, &error.to_string()).await?;
            return Ok(false);
        }
        Err(HumanIntentPolicyError::Retryable(error)) => return Err(error),
    };
    let task: Uuid = run
        .task_id
        .parse()
        .map_err(|_| AppError::Internal("invalid task identity".into()))?;
    let placeholder: Uuid = run
        .placeholder_msg_id
        .parse()
        .map_err(|_| AppError::Internal("invalid placeholder identity".into()))?;
    if placeholder
        != dispatcher::derive_placeholder_id(intent.params.trigger_msg_id, intent.params.bot_id)
    {
        cancel(
            db,
            fanout,
            registry,
            run,
            lease,
            "intent identity does not match the run",
        )
        .await?;
        return Ok(false);
    }
    // Fence source/session/files before any slow media preparation, then again
    // at publication so a permission change cannot publish a stale new offer.
    let mut validation = db.begin().await?;
    if !authorize_locked(&mut validation, &intent).await? {
        drop(validation);
        cancel(
            db,
            fanout,
            registry,
            run,
            lease,
            "dispatch authority was revoked",
        )
        .await?;
        return Ok(false);
    }
    validation.commit().await?;
    if !locator.is_online(intent.params.bot_id).await
        || !locator.supports_task_acceptance(intent.params.bot_id).await
    {
        return Ok(false);
    }
    let frame = match &run.task_frame {
        Some(frame) => frame.clone(),
        None => {
            dispatcher::prepare_human_task(
                db,
                task,
                &intent.params,
                intent.trigger_message.clone(),
                &intent.file_ids,
                cache,
            )
            .await?
        }
    };
    if !valid_frame(&frame, &intent, task, placeholder) {
        cancel(
            db,
            fanout,
            registry,
            run,
            lease,
            "frozen task frame does not match the run",
        )
        .await?;
        return Ok(false);
    }
    // Repeat pool policy before acquiring locks; never perform pool/media calls
    // while retaining the transaction's connection or mutable run authority.
    match preauthorize(db, &run.dispatch_input).await {
        Ok(_) => {}
        Err(HumanIntentPolicyError::Denied(error)) => {
            cancel(db, fanout, registry, run, lease, &error.to_string()).await?;
            return Ok(false);
        }
        Err(HumanIntentPolicyError::Retryable(error)) => return Err(error),
    }
    let mut tx = db.begin().await?;
    let message = sqlx::query!(
        "SELECT channel_id,sender_id,sender_type,is_partial,is_deleted,channel_seq FROM messages WHERE msg_id=$1 FOR UPDATE",
        run.placeholder_msg_id,
    ).fetch_optional(&mut *tx).await?;
    let current = sqlx::query!(
        "SELECT status,execution_id,accepted_at,dispatch_input,dispatch_lease_id,dispatch_lease_until,task_frame
         FROM bot_runs WHERE bot_run_id=$1 FOR UPDATE", run.bot_run_id,
    ).fetch_optional(&mut *tx).await?;
    let Some(current) = current else {
        return Ok(false);
    };
    if !matches!(current.status.as_str(), "pending" | "prepared")
        || current.execution_id.is_some()
        || current.accepted_at.is_some()
        || current.dispatch_input.as_ref() != Some(&run.dispatch_input)
        || current.dispatch_lease_id.as_deref() != Some(lease.to_string().as_str())
        || current
            .dispatch_lease_until
            .is_none_or(|until| until <= chrono::Utc::now())
    {
        return Ok(false);
    }
    let valid_message = message.is_some_and(|message| {
        message.channel_id == intent.params.channel_id.to_string()
            && message.sender_id == intent.params.bot_id.to_string()
            && message.sender_type == "bot"
            && message.is_partial
            && !message.is_deleted
            && message.channel_seq.is_none()
    });
    if !valid_message || !authorize_locked(&mut tx, &intent).await? {
        drop(tx);
        cancel(
            db,
            fanout,
            registry,
            run,
            lease,
            "dispatch placeholder or authority is no longer active",
        )
        .await?;
        return Ok(false);
    }
    let frame = current.task_frame.unwrap_or(frame);
    if !valid_frame(&frame, &intent, task, placeholder) {
        drop(tx);
        cancel(
            db,
            fanout,
            registry,
            run,
            lease,
            "frozen task frame is inconsistent",
        )
        .await?;
        return Ok(false);
    }
    sqlx::query!(
        "UPDATE bot_runs SET status='prepared',task_frame=$3,updated_at=NOW()
         WHERE bot_run_id=$1 AND dispatch_lease_id=$2",
        run.bot_run_id,
        lease.to_string(),
        frame,
    )
    .execute(&mut *tx)
    .await?;
    if let Some(session) = intent.params.session_id {
        sessions::touch_session_tx(&mut tx, session).await?;
    }
    let registered = registry
        .register_if_absent(StreamEntry {
            msg_id: placeholder,
            bot_id: intent.params.bot_id,
            channel_id: intent.params.channel_id,
            task_id: task,
            trigger_msg_id: intent.params.trigger_msg_id,
            session_id: intent.params.session_id,
            finalized: false,
            last_touched_ms: Default::default(),
        })
        .map_err(|detail| AppError::Conflict(detail.into()))?;
    tx.commit().await?;
    if registered {
        fanout
            .broadcast_channel(
                intent.params.channel_id,
                dispatcher::placeholder_frame(&intent.params, placeholder),
            )
            .await;
    }
    let queued = locator.dispatch_task(intent.params.bot_id, frame).await;
    if queued {
        fanout
            .broadcast_channel(
                intent.params.channel_id,
                WireFrame::channel(
                    intent.params.channel_id,
                    "bot_processing",
                    json!({"bot_id":intent.params.bot_id,"channel_id":intent.params.channel_id}),
                ),
            )
            .await;
    }
    Ok(queued)
}

async fn deliver(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &StreamRegistry,
    locator: &Arc<dyn BotLocator>,
    trigger: Option<Uuid>,
) -> Result<usize, sqlx::Error> {
    let lease = Uuid::new_v4();
    let runs = claim_due(db, trigger, lease).await?;
    let cache = MediaCache::default();
    let outcomes = stream::iter(runs).map(|run| {
        let cache = &cache;
        async move {
            let result = tokio::time::timeout(Duration::from_secs(30), attempt(db, fanout, registry, locator, &run, lease, cache)).await;
            let queued = matches!(result, Ok(Ok(true)));
            match result {
                Ok(Err(error)) => tracing::warn!(task_id=run.task_id, %error, "human dispatch retained for retry"),
                Err(_) => tracing::warn!(task_id=run.task_id, "human dispatch attempt timed out; retained for retry"),
                _ => {}
            }
            match tokio::time::timeout(Duration::from_secs(5), release(db, &run, lease)).await {
                Ok(Ok(())) => {}
                _ => tracing::warn!(task_id=run.task_id, "dispatch lease release failed; expiry permits recovery"),
            }
            queued
        }
    }).buffer_unordered(4).collect::<Vec<_>>().await;
    Ok(outcomes.into_iter().filter(|queued| *queued).count())
}

pub async fn deliver_trigger(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &StreamRegistry,
    locator: &Arc<dyn BotLocator>,
    trigger_id: Uuid,
) -> Result<usize, sqlx::Error> {
    deliver(db, fanout, registry, locator, Some(trigger_id)).await
}

pub async fn recover_once(
    db: &PgPool,
    fanout: &Arc<dyn Fanout>,
    registry: &StreamRegistry,
    locator: &Arc<dyn BotLocator>,
) -> Result<usize, sqlx::Error> {
    deliver(db, fanout, registry, locator, None).await
}

pub fn spawn(
    db: PgPool,
    registry: Arc<StreamRegistry>,
    fanout: Arc<dyn Fanout>,
    locator: Arc<dyn BotLocator>,
) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = recover_once(&db, &fanout, &registry, &locator).await {
                tracing::error!(%error, "human dispatch recovery scan failed");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}
