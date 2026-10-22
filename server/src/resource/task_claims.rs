//! Resource verbs for proactive task claims (design PROACTIVE_TASK_CLAIMS.md).
//!
//! Agents reach these through MCP tools (packages/cheers-mcp-server) which map
//! 1:1 onto a resource verb. Verbs:
//!   channel.task_claims.list     — list claims (status filter, pagination).
//!   channel.task_claims.evaluate — decide a bot-scoped scheduler reservation.
//!
//! Status-changing actions (cancel / accept / reject) intentionally live on the
//! REST path (POST /cancel, POST /resolve) where the full AppState — fanout,
//! dispatcher, audit writer — is available. Evaluation may propose a claim,
//! but a bot never forges a human approval. Monitoring settings verbs live on
//! the REST `PUT/GET .../bots/:bot_id/monitoring` endpoints for the same reason.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    authorize_channel_read, internal_err, permission_denied, Principal, PrincipalType,
    ResourceResult,
};

/// `channel.task_claims.evaluate` — the only bot-writable claim decision.
/// The evaluation id is a single-use capability scoped to the bot/channel by
/// the scheduler; task text and requester are derived server-side.
pub async fn handle_evaluate(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    if principal.principal_type != PrincipalType::Bot {
        return Err(permission_denied(
            "only bots can respond to task-claim evaluations",
        ));
    }
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;
    let evaluation_id: Uuid = params
        .get("evaluation_id")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "evaluation_id required"))?;
    let decision = params
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "decision required"))?;
    if !matches!(decision, "claim" | "ignore") {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "decision must be claim or ignore",
        ));
    }
    let confidence = params
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    let outcome = crate::domain::task_claims::complete_evaluation(
        db,
        crate::domain::task_claims::CompleteEvaluationParams {
            bot_id: principal.principal_id,
            evaluation_id,
            channel_id: Some(channel_id),
            decision: if decision == "claim" {
                crate::domain::task_claims::EvaluationDecision::Claim { confidence }
            } else {
                crate::domain::task_claims::EvaluationDecision::Ignore
            },
        },
    )
    .await
    .map_err(|error| match error {
        crate::errors::AppError::NotFound => {
            super::resource_error("NOT_FOUND", "task-claim evaluation not found")
        }
        crate::errors::AppError::BadRequest(message) => {
            super::resource_error("INVALID_STATE", message)
        }
        crate::errors::AppError::Forbidden(message) => permission_denied(&message),
        crate::errors::AppError::Conflict(message) => super::resource_error("CONFLICT", message),
        other => internal_err("TASK_CLAIM_DB", "db error", "complete claim evaluation")(other),
    })?;
    if !outcome.newly_decided {
        return Err(super::resource_error(
            "CONFLICT",
            "task-claim evaluation has already been decided",
        ));
    }
    Ok(outcome.data)
}

/// `channel.task_claims.list` — list claims in a channel (read-only).
pub async fn handle_list(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;
    authorize_channel_read(db, principal, channel_id).await?;
    let status = params.get("status").and_then(Value::as_str);
    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50)
        .clamp(1, 100);
    let rows = sqlx::query!(
        r#"SELECT r.claim_id, r.evaluation_id, r.channel_id, r.bot_id,
                  COALESCE(NULLIF(b.display_name, ''), b.username) AS bot_name,
                  r.summary, r.proposed_action, r.confidence::float8 AS confidence,
                  r.impact, r.status, r.resolved_by, r.resolution_note,
                  r.execution_msg_id, r.created_at, r.resolved_at
           FROM task_claim_requests r
           JOIN bot_accounts b ON b.bot_id = r.bot_id
           WHERE r.channel_id = $1 AND ($2::text IS NULL OR r.status = $2)
           ORDER BY r.created_at DESC LIMIT $3"#,
        channel_id.to_string(),
        status,
        limit,
    )
    .fetch_all(db)
    .await
    .map_err(internal_err(
        "TASK_CLAIMS_LIST_DB",
        "db error",
        "list claims",
    ))?;
    let claims: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "claim_id": row.claim_id.clone(),
                "evaluation_id": row.evaluation_id.clone(),
                "channel_id": row.channel_id.clone(),
                "bot_id": row.bot_id.clone(),
                "bot_name": row.bot_name.clone().unwrap_or_default(),
                "summary": row.summary.clone(),
                "proposed_action": row.proposed_action.clone(),
                "confidence": row.confidence.clone().unwrap_or_default(),
                "impact": row.impact.clone(),
                "status": row.status.clone(),
                "resolved_by": row.resolved_by.clone(),
                "resolution_note": row.resolution_note.clone(),
                "execution_msg_id": row.execution_msg_id.clone(),
                "created_at": Some(row.created_at.clone()).map(|d| d.to_rfc3339()),
                "resolved_at": row.resolved_at.clone().map(|d| d.to_rfc3339()),
            })
        })
        .collect();
    Ok(json!({ "claims": claims }))
}
