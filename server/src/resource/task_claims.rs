//! Resource verbs for proactive task claims (design PROACTIVE_TASK_CLAIMS.md).
//!
//! Agents reach these through MCP tools (packages/cheers-mcp-server) which map
//! 1:1 onto a resource verb. Verbs:
//!   channel.task_claims.list     — list claims (status filter, pagination).
//!
//! Status-changing actions (cancel / accept / reject) intentionally live on the
//! REST path (POST /cancel, POST /resolve) where the full AppState — fanout,
//! dispatcher, audit writer — is available; the resource path is read-only by
//! design, so a bot never forges an approval. Monitoring settings verbs live on
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
    let mut tx = db.begin().await.map_err(internal_err(
        "TASK_CLAIM_DB",
        "db error",
        "claim evaluation begin",
    ))?;
    let eval = sqlx::query!(
        "SELECT source_seq_to,status FROM task_claim_evaluations WHERE evaluation_id=$1 AND channel_id=$2 AND bot_id=$3 FOR UPDATE",
        evaluation_id.to_string(),
        channel_id.to_string(),
        principal.principal_id.to_string(),
    ).fetch_optional(&mut *tx).await.map_err(internal_err("TASK_CLAIM_DB", "db error", "claim evaluation lookup"))?
        .ok_or_else(|| super::resource_error("NOT_FOUND", "task-claim evaluation not found"))?;
    let status: String = eval.status.clone();
    if status != "dispatched" {
        return Err(super::resource_error(
            "CONFLICT",
            "task-claim evaluation has already been decided",
        ));
    }
    if decision == "ignore" {
        sqlx::query!(
            "UPDATE task_claim_evaluations SET status='ignored',completed_at=NOW() WHERE evaluation_id=$1",
            evaluation_id.to_string(),
        )
        .execute(&mut *tx)
        .await
        .map_err(internal_err(
            "TASK_CLAIM_DB",
            "db error",
            "record ignored claim",
        ))?;
        tx.commit().await.map_err(internal_err(
            "TASK_CLAIM_DB",
            "db error",
            "commit ignored claim",
        ))?;
        return Ok(
            json!({"evaluation_id":evaluation_id,"channel_id":channel_id,"status":"ignored"}),
        );
    }
    let threshold: f64 = sqlx::query_scalar!(
        r#"SELECT confidence_threshold::float8 AS "value!" FROM channel_bot_monitoring WHERE channel_id=$1 AND bot_id=$2"#,
        channel_id.to_string(),
        principal.principal_id.to_string(),
    ).fetch_one(&mut *tx).await
        .map_err(internal_err("TASK_CLAIM_DB", "db error", "claim confidence threshold"))?;
    if confidence < threshold {
        sqlx::query!(
            "UPDATE task_claim_evaluations SET status='ignored',error='below confidence threshold',completed_at=NOW() WHERE evaluation_id=$1",
            evaluation_id.to_string(),
        ).execute(&mut *tx).await.map_err(internal_err("TASK_CLAIM_DB", "db error", "record low-confidence claim"))?;
        tx.commit().await.map_err(internal_err(
            "TASK_CLAIM_DB",
            "db error",
            "commit low-confidence claim",
        ))?;
        return Ok(
            json!({"evaluation_id":evaluation_id,"channel_id":channel_id,"status":"ignored"}),
        );
    }
    let source_seq: i64 = eval.source_seq_to.clone();
    let source = sqlx::query!(
        "SELECT msg_id,sender_id,content FROM messages WHERE channel_id=$1 AND channel_seq=$2 AND sender_type='user' LIMIT 1",
        channel_id.to_string(),
        source_seq,
    ).fetch_optional(&mut *tx).await
        .map_err(internal_err("TASK_CLAIM_DB", "db error", "claim source message"))?
        .ok_or_else(|| super::resource_error("INVALID_STATE", "claim evaluation source is not a user message"))?;
    let source_message_id: String = source.msg_id.clone();
    let requester_id: String = source.sender_id.clone();
    let summary: String = source.content.clone().trim().chars().take(1000).collect();
    if summary.is_empty() {
        return Err(super::resource_error(
            "INVALID_STATE",
            "claim source message is empty",
        ));
    }
    let requester_name =
        sqlx::query_scalar!("SELECT username FROM users WHERE user_id=$1", &requester_id,)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal_err(
                "TASK_CLAIM_DB",
                "db error",
                "claim requester name",
            ))?
            .unwrap_or_else(|| "there".to_string());
    let claim_id = Uuid::new_v4();
    let confirmation_id = Uuid::new_v4();
    let action = "Start the requested work and report the result in this channel.";
    let impact = "medium";
    sqlx::query!(
        "UPDATE task_claim_evaluations SET status='completed',completed_at=NOW() WHERE evaluation_id=$1",
        evaluation_id.to_string(),
    )
    .execute(&mut *tx)
    .await
    .map_err(internal_err(
        "TASK_CLAIM_DB",
        "db error",
        "complete claim evaluation",
    ))?;
    sqlx::query!(
        "INSERT INTO task_claim_requests(claim_id,evaluation_id,channel_id,bot_id,summary,proposed_action,confidence,impact,requester_id,source_message_id,confirmation_message_id) VALUES($1,$2,$3,$4,$5,$6,$7::float8,$8,$9,$10,$11)",
        claim_id.to_string(),
        evaluation_id.to_string(),
        channel_id.to_string(),
        principal.principal_id.to_string(),
        &summary,
        action,
        confidence,
        impact,
        &requester_id,
        &source_message_id,
        confirmation_id.to_string(),
    ).execute(&mut *tx).await.map_err(internal_err("TASK_CLAIM_DB", "db error", "create task claim"))?;
    let seq = crate::domain::channel_seq::allocate(&mut tx, channel_id)
        .await
        .map_err(internal_err(
            "TASK_CLAIM_DB",
            "db error",
            "allocate confirmation sequence",
        ))?;
    let content = format!("@{requester_name} OpenCode 想认领这个任务：{summary}\n\n{action}");
    let data = json!({"claim_id":claim_id,"requester_id":requester_id,"summary":summary,"proposed_action":action,"confidence":confidence,"impact":impact,"resolved":false});
    sqlx::query!(
        "INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_partial,is_deleted,in_reply_to_msg_id,created_at,channel_seq,content_data) VALUES($1,$2,$3,'bot',$4,'task_claim_confirmation',FALSE,FALSE,$5,NOW(),$6,$7)",
        confirmation_id.to_string(),
        channel_id.to_string(),
        principal.principal_id.to_string(),
        &content,
        &source_message_id,
        seq,
        &data,
    ).execute(&mut *tx).await.map_err(internal_err("TASK_CLAIM_DB", "db error", "create confirmation message"))?;
    sqlx::query!(
        "INSERT INTO message_mentions(msg_id,member_id,member_type) VALUES($1,$2,'user')",
        confirmation_id.to_string(),
        &requester_id,
    )
    .execute(&mut *tx)
    .await
    .map_err(internal_err(
        "TASK_CLAIM_DB",
        "db error",
        "mention claim requester",
    ))?;
    tx.commit().await.map_err(internal_err(
        "TASK_CLAIM_DB",
        "db error",
        "commit task claim",
    ))?;
    Ok(
        json!({"claim_id":claim_id,"evaluation_id":evaluation_id,"channel_id":channel_id,"bot_id":principal.principal_id,"summary":summary,"proposed_action":action,"confidence":confidence,"impact":impact,"status":"pending","confirmation_message":{"msg_id":confirmation_id,"channel_id":channel_id,"channel_seq":seq,"sender_type":"bot","sender_id":principal.principal_id,"content":content,"msg_type":"task_claim_confirmation","is_partial":false,"reply_to_msg_id":source_message_id,"mentions":[{"member_id":requester_id,"member_type":"user"}],"content_data":data}}),
    )
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
