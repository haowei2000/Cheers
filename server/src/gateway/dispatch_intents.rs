//! Recoverable dispatch offers, using the existing run ledger.
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

#[derive(Clone, Serialize, Deserialize)]
pub struct BotIntent {
    pub version: u32,
    pub author_bot_id: Uuid,
    pub parent_task_id: Uuid,
    pub parent_execution_id: Uuid,
    pub params: DispatchParams,
    pub trigger_message: Value,
    pub file_ids: Vec<String>,
}

/// A newly-created proactive bot message is its own committed source. It has no
/// parent execution identity and cannot stand in for an execution result.
#[derive(Clone, Serialize, Deserialize)]
pub struct BotMessageIntent {
    pub version: u32,
    pub author_bot_id: Uuid,
    pub params: DispatchParams,
    pub trigger_message: Value,
    pub file_ids: Vec<String>,
}

/// Human approval of one proactive task claim. Its secret trigger is not a
/// published chat message; the claim row is the authority for this source.
#[derive(Clone, Serialize, Deserialize)]
pub struct ClaimIntent {
    pub version: u32,
    pub claim_id: Uuid,
    pub requester_id: Uuid,
    pub params: DispatchParams,
    pub trigger_message: Value,
    pub file_ids: Vec<String>,
}

pub fn claim_trigger_id(claim_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("cheers:task-claim:{claim_id}").as_bytes(),
    )
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum IntentActor {
    Human {
        author_id: Uuid,
    },
    TaskClaim {
        claim_id: Uuid,
        requester_id: Uuid,
    },
    Bot {
        author_bot_id: Uuid,
        parent_task_id: Uuid,
        parent_execution_id: Uuid,
    },
    BotMessage {
        author_bot_id: Uuid,
    },
}

/// Version 2 makes the source actor explicit. Version 1 human rows remain part
/// of the persisted protocol and decode into this same normalized representation.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct DispatchInput {
    version: u32,
    actor: IntentActor,
    pub params: DispatchParams,
    trigger_message: Value,
    file_ids: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum IntentPolicyError {
    #[error("{0}")]
    Denied(AppError),
    #[error("{0}")]
    Retryable(AppError),
}

impl From<HumanIntentPolicyError> for IntentPolicyError {
    fn from(error: HumanIntentPolicyError) -> Self {
        match error {
            HumanIntentPolicyError::Denied(error) => Self::Denied(error),
            HumanIntentPolicyError::Retryable(error) => Self::Retryable(error),
        }
    }
}

impl DispatchInput {
    fn author(&self) -> (Uuid, &'static str) {
        match self.actor {
            IntentActor::Human { author_id }
            | IntentActor::TaskClaim {
                requester_id: author_id,
                ..
            } => (author_id, "user"),
            IntentActor::Bot { author_bot_id, .. } | IntentActor::BotMessage { author_bot_id } => {
                (author_bot_id, "bot")
            }
        }
    }

    fn validate(&self) -> Result<(), AppError> {
        let (author, _) = self.author();
        let valid_depth = match self.actor {
            IntentActor::Human { .. } => self.params.depth == 0,
            IntentActor::TaskClaim { claim_id, .. } => {
                self.params.depth == 0
                    && self.params.trigger_seq == 0
                    && self.params.trigger_msg_id == claim_trigger_id(claim_id)
                    && self.file_ids.is_empty()
            }
            IntentActor::Bot { .. } | IntentActor::BotMessage { .. } => {
                self.params.depth > 0
                    && self.params.depth <= crate::domain::chains::MAX_BOT_REPLY_DEPTH
                    && author != self.params.bot_id
            }
        };
        if self.version != 2
            || !valid_depth
            || self.params.session_id.is_none()
            || self.params.chain_id.is_none()
            || self.params.provider_session_key.trim().is_empty()
            || self.trigger_message.get("msg_id").and_then(Value::as_str)
                != Some(self.params.trigger_msg_id.to_string().as_str())
            || self.trigger_message.get("user").and_then(Value::as_str)
                != Some(author.to_string().as_str())
            || self
                .trigger_message
                .get("text")
                .and_then(Value::as_str)
                .is_none()
        {
            return Err(AppError::BadRequest(
                "invalid durable dispatch intent".into(),
            ));
        }
        Ok(())
    }

    fn decode(input: &Value) -> Result<Self, AppError> {
        if input.get("version").and_then(Value::as_u64) == Some(1) {
            let human: HumanIntent = serde_json::from_value(input.clone())
                .map_err(|error| AppError::BadRequest(error.to_string()))?;
            human.validate()?;
            Ok(Self::from(human))
        } else {
            let intent: Self = serde_json::from_value(input.clone())
                .map_err(|error| AppError::BadRequest(error.to_string()))?;
            intent.validate()?;
            Ok(intent)
        }
    }
}

impl From<HumanIntent> for DispatchInput {
    fn from(intent: HumanIntent) -> Self {
        Self {
            version: 2,
            actor: IntentActor::Human {
                author_id: intent.author_id,
            },
            params: intent.params,
            trigger_message: intent.trigger_message,
            file_ids: intent.file_ids,
        }
    }
}

/// Called in the human message's transaction. No network/media IO and no BUSY
/// transition occurs here. An existing tombstone always retains its identity.
pub async fn enqueue_human(
    tx: &mut Transaction<'_, Postgres>,
    intent: HumanIntent,
) -> Result<Uuid, AppError> {
    intent.validate()?;
    enqueue(tx, DispatchInput::from(intent)).await
}

pub async fn enqueue_bot(
    tx: &mut Transaction<'_, Postgres>,
    intent: BotIntent,
) -> Result<Uuid, AppError> {
    if intent.version != 2 {
        return Err(AppError::BadRequest(
            "invalid bot dispatch intent version".into(),
        ));
    }
    enqueue(
        tx,
        DispatchInput {
            version: 2,
            actor: IntentActor::Bot {
                author_bot_id: intent.author_bot_id,
                parent_task_id: intent.parent_task_id,
                parent_execution_id: intent.parent_execution_id,
            },
            params: intent.params,
            trigger_message: intent.trigger_message,
            file_ids: intent.file_ids,
        },
    )
    .await
}

pub async fn enqueue_bot_message(
    tx: &mut Transaction<'_, Postgres>,
    intent: BotMessageIntent,
) -> Result<Uuid, AppError> {
    if intent.version != 2 {
        return Err(AppError::BadRequest(
            "invalid bot message dispatch intent version".into(),
        ));
    }
    enqueue(
        tx,
        DispatchInput {
            version: 2,
            actor: IntentActor::BotMessage {
                author_bot_id: intent.author_bot_id,
            },
            params: intent.params,
            trigger_message: intent.trigger_message,
            file_ids: intent.file_ids,
        },
    )
    .await
}

pub async fn enqueue_claim(
    tx: &mut Transaction<'_, Postgres>,
    intent: ClaimIntent,
) -> Result<Uuid, AppError> {
    if intent.version != 2 {
        return Err(AppError::BadRequest("invalid claim intent version".into()));
    }
    enqueue(
        tx,
        DispatchInput {
            version: 2,
            actor: IntentActor::TaskClaim {
                claim_id: intent.claim_id,
                requester_id: intent.requester_id,
            },
            params: intent.params,
            trigger_message: intent.trigger_message,
            file_ids: intent.file_ids,
        },
    )
    .await
}

async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    intent: DispatchInput,
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
    let content_data = match intent.actor {
        IntentActor::TaskClaim { claim_id, .. } => Some(json!({
            "session_id": params.session_id,
            "task_claim_id": claim_id,
        })),
        _ => params.session_id.map(|sid| json!({"session_id":sid})),
    };
    sqlx::query!(
        "INSERT INTO messages
         (msg_id,task_id,channel_id,sender_type,sender_id,content,msg_type,is_partial,depth,chain_id,context_bundle,in_reply_to_msg_id,content_data)
         VALUES($1,$2,$3,'bot',$4,'','text',TRUE,$9,$5,$6,$7,$8)",
        placeholder_id.to_string(), task_id.to_string(), params.channel_id.to_string(),
        params.bot_id.to_string(), params.chain_id, params.context_bundle,
        params.trigger_msg_id.to_string(), content_data,
        params.depth,
    ).execute(&mut **tx).await?;
    Ok(task_id)
}

/// Full pool-based actor policy is evaluated before acquiring any run locks.
/// The fixed target is rechecked; routing and UI source versions are not rerun.
pub(crate) async fn preauthorize(
    db: &PgPool,
    input: &Value,
) -> Result<DispatchInput, IntentPolicyError> {
    use IntentPolicyError::{Denied, Retryable};
    let intent = DispatchInput::decode(input).map_err(Denied)?;
    match intent.actor {
        IntentActor::Human { author_id }
        | IntentActor::TaskClaim {
            requester_id: author_id,
            ..
        } => message_policy::reauthorize_human_intent(
            db,
            author_id,
            intent.params.channel_id,
            intent.params.bot_id,
        )
        .await
        .map_err(IntentPolicyError::from)?,
        IntentActor::Bot { author_bot_id, .. } | IntentActor::BotMessage { author_bot_id } => {
            let decision = crate::domain::bot_event_policy::resolve_dispatch_decision_checked(
                db,
                &intent.params.bot_id.to_string(),
                &intent.params.channel_id.to_string(),
                &author_bot_id.to_string(),
            )
            .await
            .map_err(|error| Retryable(AppError::Db(error)))?;
            if !decision.allow {
                return Err(Denied(AppError::Forbidden(
                    "bot dispatch policy was revoked".into(),
                )));
            }
        }
    }
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
    intent: &DispatchInput,
) -> Result<bool, sqlx::Error> {
    let params = &intent.params;
    let source = sqlx::query!(
        "SELECT sender_id,sender_type,is_deleted,is_partial,is_secret,msg_type,content_data,channel_seq,chain_id,depth,task_id FROM messages
         WHERE msg_id=$1 AND channel_id=$2 FOR SHARE",
        params.trigger_msg_id.to_string(),
        params.channel_id.to_string(),
    )
    .fetch_optional(&mut **tx)
    .await?;
    let (author_id, author_type) = intent.author();
    let Some(source) = source else {
        return Ok(false);
    };
    if source.sender_id != author_id.to_string()
        || source.sender_type != author_type
        || source.is_deleted
        || source.is_partial
    {
        return Ok(false);
    }
    if let IntentActor::TaskClaim {
        claim_id,
        requester_id,
    } = intent.actor
    {
        if !source.is_secret
            || source.msg_type != "task_claim"
            || source.channel_seq.is_some()
            || source.task_id.is_some()
            || source.chain_id.as_deref() != params.chain_id.as_deref()
            || source
                .content_data
                .as_ref()
                .and_then(|data| data.get("claim_id"))
                .and_then(Value::as_str)
                != Some(claim_id.to_string().as_str())
        {
            return Ok(false);
        }
        let claim = sqlx::query!(
            "SELECT requester_id,resolved_by FROM task_claim_requests WHERE claim_id=$1 FOR UPDATE",
            claim_id.to_string(),
        )
        .fetch_optional(&mut **tx)
        .await?;
        if !claim.is_some_and(|claim| {
            claim.requester_id.as_deref() == Some(requester_id.to_string().as_str())
                && claim.resolved_by.as_deref() == Some(requester_id.to_string().as_str())
        }) {
            return Ok(false);
        }
    } else if source.channel_seq != Some(params.trigger_seq) || source.is_secret {
        return Ok(false);
    }
    match intent.actor {
        IntentActor::Human { .. } | IntentActor::TaskClaim { .. } => {
            let author = sqlx::query!(
                "SELECT is_suspended,is_deleted FROM users WHERE user_id=$1 FOR SHARE",
                author_id.to_string()
            )
            .fetch_optional(&mut **tx)
            .await?;
            if !author.is_some_and(|author| !author.is_suspended && !author.is_deleted) {
                return Ok(false);
            }
        }
        IntentActor::Bot { .. } | IntentActor::BotMessage { .. } => {
            let decision = crate::domain::bot_event_policy::resolve_dispatch_decision_checked(
                &mut **tx,
                &params.bot_id.to_string(),
                &params.channel_id.to_string(),
                &author_id.to_string(),
            )
            .await?;
            if !decision.allow {
                return Ok(false);
            }
            if source.is_partial
                || source.channel_seq.is_none()
                || source.depth.saturating_add(1) != params.depth
                || source.chain_id.as_deref() != params.chain_id.as_deref()
            {
                return Ok(false);
            }
            let parent = sqlx::query!(
                "SELECT task_id,bot_id,channel_id,execution_id,status,last_event_type,terminal_client_msg_id,terminal_fingerprint,terminal_committed_at
                 FROM bot_runs WHERE placeholder_msg_id=$1 FOR SHARE",
                params.trigger_msg_id.to_string(),
            ).fetch_optional(&mut **tx).await?;
            if let IntentActor::Bot {
                parent_task_id,
                parent_execution_id,
                ..
            } = intent.actor
            {
                if source.task_id.as_deref() != Some(parent_task_id.to_string().as_str())
                    || !parent.is_some_and(|parent| {
                        parent.task_id == parent_task_id.to_string()
                            && parent.bot_id == author_id.to_string()
                            && parent.channel_id == params.channel_id.to_string()
                            && parent.execution_id.as_deref()
                                == Some(parent_execution_id.to_string().as_str())
                            && parent.status == "completed"
                            && parent.last_event_type.as_deref() == Some("done")
                            && parent.terminal_client_msg_id.is_some()
                            && parent.terminal_fingerprint.is_some()
                            && parent.terminal_committed_at.is_some()
                    })
                {
                    return Ok(false);
                }
            } else if source.task_id.is_some() || parent.is_some() {
                // An execution result cannot downgrade its receipt proof merely
                // by choosing the proactive actor variant, including old rows
                // whose task_id was absent but whose durable run still exists.
                return Ok(false);
            }
            let author = sqlx::query!(
                "SELECT is_disabled FROM bot_accounts WHERE bot_id=$1 FOR SHARE",
                author_id.to_string()
            )
            .fetch_optional(&mut **tx)
            .await?;
            if !author.is_some_and(|author| !author.is_disabled) {
                return Ok(false);
            }
        }
    }
    let member = sqlx::query!(
        "SELECT role FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type=$3 FOR SHARE",
        params.channel_id.to_string(), author_id.to_string(),author_type,
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
         WHERE file_id=ANY($1) AND channel_id=$2 AND ($4::boolean OR uploader_id=$3) FOR SHARE",
        &intent.file_ids,
        params.channel_id.to_string(),
        author_id.to_string(),
        author_type == "bot",
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
    if !super::task_acceptance::may_execute(
        tx,
        params.bot_id,
        params.channel_id,
        params.chain_id.as_deref(),
    )
    .await?
    {
        return Ok(false);
    }
    // All source/session/policy locks are held now. Expiry remains clock-based,
    // so check it after those waits using the same claim gate as grants/results.
    if let IntentActor::TaskClaim { claim_id, .. } = intent.actor {
        let placeholder = dispatcher::derive_placeholder_id(params.trigger_msg_id, params.bot_id);
        return match crate::domain::task_claims::lock_execution_claim(
            tx,
            Some(claim_id),
            placeholder,
            params.bot_id,
            params.channel_id,
        )
        .await
        {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(AppError::Db(error)) => Err(error),
            Err(AppError::Internal(detail)) => Err(sqlx::Error::Protocol(detail)),
            Err(_) => Ok(false),
        };
    }
    Ok(true)
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
    let failed_claims = sqlx::query!(
        "UPDATE task_claim_requests SET status='failed',
             resolution_note=COALESCE(resolution_note,$4),updated_at=NOW()
         WHERE execution_msg_id=$1 AND bot_id=$2 AND channel_id=$3 AND status='executing'
         RETURNING claim_id",
        run.placeholder_msg_id,
        canceled.bot_id,
        canceled.channel_id,
        reason,
    )
    .fetch_all(&mut *tx)
    .await?;
    if let Ok(intent) = DispatchInput::decode(&run.dispatch_input) {
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
        for claim in failed_claims {
            fanout
                .broadcast_channel(
                    channel,
                    WireFrame::channel(
                        channel,
                        "task_claim_updated",
                        json!({"claim_id":claim.claim_id,"status":"failed","execution_msg_id":msg}),
                    ),
                )
                .await;
        }
    }
    Ok(())
}

fn valid_frame(frame: &Value, intent: &DispatchInput, task: Uuid, placeholder: Uuid) -> bool {
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
        Err(IntentPolicyError::Denied(error)) => {
            cancel(db, fanout, registry, run, lease, &error.to_string()).await?;
            return Ok(false);
        }
        Err(IntentPolicyError::Retryable(error)) => return Err(error),
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
            dispatcher::prepare_task_from_snapshot(
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
        Err(IntentPolicyError::Denied(error)) => {
            cancel(db, fanout, registry, run, lease, &error.to_string()).await?;
            return Ok(false);
        }
        Err(IntentPolicyError::Retryable(error)) => return Err(error),
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
    let outcomes = stream::iter(runs)
        .map(|run| {
            let cache = &cache;
            async move {
                let result = tokio::time::timeout(
                    Duration::from_secs(30),
                    attempt(db, fanout, registry, locator, &run, lease, cache),
                )
                .await;
                let queued = matches!(result, Ok(Ok(true)));
                match result {
                    Ok(Err(error)) => {
                        tracing::warn!(task_id=run.task_id, %error, "dispatch retained for retry")
                    }
                    Err(_) => tracing::warn!(
                        task_id = run.task_id,
                        "dispatch attempt timed out; retained for retry"
                    ),
                    _ => {}
                }
                match tokio::time::timeout(Duration::from_secs(5), release(db, &run, lease)).await {
                    Ok(Ok(())) => {}
                    _ => tracing::warn!(
                        task_id = run.task_id,
                        "dispatch lease release failed; expiry permits recovery"
                    ),
                }
                queued
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
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
                tracing::error!(%error, "dispatch recovery scan failed");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}
