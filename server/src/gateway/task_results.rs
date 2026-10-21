//! Durable acknowledgements for results of already-granted executions.
//! A receipt only confirms the same committed result; it never grants execution
//! or recreates a reclaimed message. Receipts have the run's tombstone lifetime.

use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalOutcome {
    Committed,
    Replayed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalError {
    pub code: &'static str,
    pub detail: &'static str,
    pub retryable: bool,
}

impl std::fmt::Display for TerminalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.detail)
    }
}

impl TerminalError {
    pub(crate) fn rejected(code: &'static str, detail: &'static str) -> Self {
        Self {
            code,
            detail,
            retryable: false,
        }
    }

    pub(crate) fn busy() -> Self {
        Self {
            code: "TERMINAL_BUSY",
            detail: "terminal result is being committed",
            retryable: true,
        }
    }

    pub(crate) fn database(context: &'static str) -> impl FnOnce(sqlx::Error) -> Self {
        move |error| {
            tracing::error!(%error, context, "terminal result persistence failed");
            Self {
                code: "INTERNAL_ERROR",
                detail: "terminal result persistence failed",
                retryable: true,
            }
        }
    }
}

#[derive(Debug)]
pub(crate) struct Execution {
    pub(crate) task_id: Uuid,
    pub(crate) execution_id: Uuid,
    pub channel_id: Uuid,
    client_msg_id: String,
    fingerprint: String,
    kind: &'static str,
}

#[derive(Debug)]
pub(crate) struct TerminalRequest {
    pub msg_id: Uuid,
    pub execution: Execution,
}

fn uuid(value: Option<&Value>) -> Result<Uuid, TerminalError> {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| {
            TerminalError::rejected(
                "INVALID_FRAME",
                "terminal identity must contain valid UUIDs",
            )
        })
}

impl TerminalRequest {
    pub(crate) fn parse(frame: &Value) -> Result<Self, TerminalError> {
        let msg_id = uuid(frame.get("msg_id"))?;
        let execution = frame
            .get("execution")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                TerminalError::rejected("INVALID_FRAME", "task execution identity is required")
            })?;
        let kind = match frame.get("type").and_then(Value::as_str) {
            Some("done") => "done",
            Some("error") => "error",
            _ => {
                return Err(TerminalError::rejected(
                    "INVALID_FRAME",
                    "execution result must be done or error",
                ))
            }
        };
        let execution = Execution {
            task_id: uuid(execution.get("task_id"))?,
            execution_id: uuid(execution.get("execution_id"))?,
            channel_id: uuid(execution.get("channel_id"))?,
            client_msg_id: uuid(frame.get("client_msg_id"))?.to_string(),
            // Preserve every immutable unsigned field, including original
            // Done/Error kind and provider/session context. A retry may
            // only refresh its capability envelope, not its result.
            fingerprint: crate::infra::crypto::json_fingerprint(frame, &["acp_capability"]),
            kind,
        };
        Ok(Self { msg_id, execution })
    }
}

#[derive(sqlx::FromRow)]
pub(crate) struct Run {
    task_id: String,
    bot_id: String,
    channel_id: String,
    binding_type: String,
    status: String,
    execution_id: Option<String>,
    terminal_client_msg_id: Option<String>,
    terminal_fingerprint: Option<String>,
    terminal_committed_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl Run {
    pub(crate) fn validate(
        &self,
        bot_id: Uuid,
        request: &TerminalRequest,
    ) -> Result<Option<TerminalOutcome>, TerminalError> {
        let execution = &request.execution;
        if self.bot_id != bot_id.to_string()
            || self.task_id != execution.task_id.to_string()
            || self.channel_id != execution.channel_id.to_string()
            || self.execution_id.as_deref() != Some(execution.execution_id.to_string().as_str())
            || self.binding_type != "acp"
        {
            return Err(TerminalError::rejected(
                "TERMINAL_FORBIDDEN",
                "result does not belong to this granted execution",
            ));
        }
        match (
            &self.terminal_client_msg_id,
            &self.terminal_fingerprint,
            self.terminal_committed_at,
        ) {
            (Some(client_msg_id), Some(fingerprint), Some(_))
                if client_msg_id == &execution.client_msg_id
                    && fingerprint == &execution.fingerprint =>
            {
                Ok(Some(TerminalOutcome::Replayed))
            }
            (None, None, None) if self.status == "accepted" => Ok(None),
            _ => Err(TerminalError::rejected(
                "TERMINAL_CONFLICT",
                "a different or incomplete terminal result already owns this task",
            )),
        }
    }
}

/// Read-only exact replay check before active-session authorization. The bot is
/// already authenticated by its host WebSocket. Matching the accepted execution
/// plus the immutable receipt grants no new write and runs no completion effects.
pub async fn replay(
    db: &PgPool,
    bot_id: Uuid,
    frame: &Value,
) -> Result<Option<TerminalOutcome>, TerminalError> {
    let request = TerminalRequest::parse(frame)?;
    let run = sqlx::query_as!(
        Run,
        "SELECT task_id,bot_id,channel_id,binding_type,status,execution_id,
                terminal_client_msg_id,terminal_fingerprint,terminal_committed_at
         FROM bot_runs WHERE placeholder_msg_id=$1",
        request.msg_id.to_string(),
    )
    .fetch_optional(db)
    .await
    .map_err(TerminalError::database("read terminal receipt"))?
    .ok_or_else(|| TerminalError::rejected("TERMINAL_GONE", "task execution no longer exists"))?;
    run.validate(bot_id, &request)
}

pub(crate) async fn lock_run(
    tx: &mut Transaction<'_, Postgres>,
    request: &TerminalRequest,
) -> Result<Run, TerminalError> {
    sqlx::query_as!(
        Run,
        "SELECT task_id,bot_id,channel_id,binding_type,status,execution_id,
                terminal_client_msg_id,terminal_fingerprint,terminal_committed_at
         FROM bot_runs WHERE placeholder_msg_id=$1 FOR UPDATE",
        request.msg_id.to_string(),
    )
    .fetch_optional(&mut **tx)
    .await
    .map_err(TerminalError::database("lock terminal run"))?
    .ok_or_else(|| TerminalError::rejected("TERMINAL_GONE", "task execution no longer exists"))
}

pub(crate) async fn complete(
    tx: &mut Transaction<'_, Postgres>,
    request: &TerminalRequest,
) -> Result<(), TerminalError> {
    let execution = &request.execution;
    let result = sqlx::query!(
        "UPDATE bot_runs SET terminal_client_msg_id=$2,terminal_fingerprint=$3,
         terminal_committed_at=NOW(),status=$4,last_event_type=$5,updated_at=NOW()
         WHERE placeholder_msg_id=$1",
        request.msg_id.to_string(),
        execution.client_msg_id,
        execution.fingerprint,
        if execution.kind == "error" {
            "failed"
        } else {
            "completed"
        },
        execution.kind,
    )
    .execute(&mut **tx)
    .await
    .map_err(TerminalError::database("record terminal receipt"))?;
    if result.rows_affected() != 1 {
        return Err(TerminalError::rejected(
            "TERMINAL_CONFLICT",
            "task execution disappeared before its receipt was recorded",
        ));
    }
    Ok(())
}
