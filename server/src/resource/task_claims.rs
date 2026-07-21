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
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{authorize_channel_read, internal_err, Principal, ResourceResult};

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
    let rows = sqlx::query(
        r#"SELECT r.claim_id, r.evaluation_id, r.channel_id, r.bot_id,
                  COALESCE(NULLIF(b.display_name, ''), b.username) AS bot_name,
                  r.summary, r.proposed_action, r.confidence::float8 AS confidence,
                  r.impact, r.status, r.resolved_by, r.resolution_note,
                  r.execution_msg_id, r.created_at, r.resolved_at
           FROM task_claim_requests r
           JOIN bot_accounts b ON b.bot_id = r.bot_id
           WHERE r.channel_id = $1 AND ($2::text IS NULL OR r.status = $2)
           ORDER BY r.created_at DESC LIMIT $3"#,
    )
    .bind(channel_id.to_string())
    .bind(status)
    .bind(limit)
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
                "claim_id": row.try_get::<String, _>("claim_id").unwrap_or_default(),
                "evaluation_id": row.try_get::<String, _>("evaluation_id").unwrap_or_default(),
                "channel_id": row.try_get::<String, _>("channel_id").unwrap_or_default(),
                "bot_id": row.try_get::<String, _>("bot_id").unwrap_or_default(),
                "bot_name": row.try_get::<String, _>("bot_name").unwrap_or_default(),
                "summary": row.try_get::<String, _>("summary").unwrap_or_default(),
                "proposed_action": row.try_get::<String, _>("proposed_action").unwrap_or_default(),
                "confidence": row.try_get::<f64, _>("confidence").unwrap_or_default(),
                "impact": row.try_get::<String, _>("impact").unwrap_or_default(),
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "resolved_by": row.try_get::<Option<String>, _>("resolved_by").ok().flatten(),
                "resolution_note": row.try_get::<Option<String>, _>("resolution_note").ok().flatten(),
                "execution_msg_id": row.try_get::<Option<String>, _>("execution_msg_id").ok().flatten(),
                "created_at": row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok().map(|d| d.to_rfc3339()),
                "resolved_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("resolved_at").ok().flatten().map(|d| d.to_rfc3339()),
            })
        })
        .collect();
    Ok(json!({ "claims": claims }))
}
