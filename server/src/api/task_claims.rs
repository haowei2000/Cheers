use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    errors::AppError,
    gateway::{
        dispatcher::{self, DispatchParams, MediaCache},
        realtime::frame::WireFrame,
    },
};

#[derive(Debug, Deserialize)]
pub struct MonitoringInput {
    pub mode: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default = "default_debounce")]
    pub debounce_seconds: i32,
    #[serde(default = "default_interval")]
    pub min_interval_seconds: i32,
    #[serde(default = "default_hourly")]
    pub max_evaluations_per_hour: i32,
    #[serde(default = "default_batch")]
    pub batch_size: i32,
    #[serde(default = "default_confidence")]
    pub confidence_threshold: f64,
    /// Runtime policy: `immediate_triggers` (keywords bypass debounce) and
    /// `quiet_hours` (`{"start":"22:00","end":"07:00"}` pauses evaluation).
    #[serde(default)]
    pub policy: serde_json::Value,
}
fn default_debounce() -> i32 {
    15
}
fn default_interval() -> i32 {
    60
}
fn default_hourly() -> i32 {
    20
}
fn default_batch() -> i32 {
    8
}
fn default_confidence() -> f64 {
    0.75
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MonitoringDto {
    pub channel_id: String,
    pub bot_id: String,
    pub mode: String,
    pub scope: String,
    pub debounce_seconds: i32,
    pub min_interval_seconds: i32,
    pub max_evaluations_per_hour: i32,
    pub batch_size: i32,
    pub confidence_threshold: f64,
    #[serde(default)]
    pub policy: serde_json::Value,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ClaimDto {
    pub claim_id: String,
    pub evaluation_id: String,
    pub channel_id: String,
    pub bot_id: String,
    pub bot_name: String,
    pub summary: String,
    pub proposed_action: String,
    pub confidence: f64,
    pub impact: String,
    pub status: String,
    pub resolved_by: Option<String>,
    pub resolution_note: Option<String>,
    pub execution_msg_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub resolved_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ResolveInput {
    pub decision: String,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CancelInput {
    pub note: Option<String>,
}

async fn actor(
    state: &AppState,
    channel_id: Uuid,
    claims: &Claims,
    admin: bool,
) -> Result<Uuid, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(user_id);
    }
    let roles: Vec<&str> = if admin {
        vec!["owner", "admin"]
    } else {
        vec!["owner", "admin", "member", "readonly"]
    };
    let role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='user'"
    ).bind(channel_id.to_string()).bind(user_id.to_string()).fetch_optional(&state.db).await?;
    if role.as_deref().is_some_and(|r| roles.contains(&r)) {
        Ok(user_id)
    } else {
        Err(AppError::Forbidden(if admin {
            "channel admin required".into()
        } else {
            "not a channel member".into()
        }))
    }
}

fn validate(input: &MonitoringInput) -> Result<(), AppError> {
    if !matches!(
        input.mode.as_str(),
        "off" | "text" | "text_and_transcript" | "all_activity"
    ) {
        return Err(AppError::BadRequest("invalid monitoring mode".into()));
    }
    if !(1..=3600).contains(&input.debounce_seconds)
        || !(1..=86400).contains(&input.min_interval_seconds)
        || !(1..=1000).contains(&input.max_evaluations_per_hour)
        || !(1..=100).contains(&input.batch_size)
        || !(0.0..=1.0).contains(&input.confidence_threshold)
    {
        return Err(AppError::BadRequest(
            "monitoring limits are out of range".into(),
        ));
    }
    if input.scope.chars().count() > 2000 {
        return Err(AppError::BadRequest("scope is too long".into()));
    }
    // Policy is free-form JSON but constrain its known keys so a bad write can't
    // silently break the scheduler's quiet-hours / immediate-trigger parsing.
    if let Some(triggers) = input.policy.get("immediate_triggers") {
        if !triggers.is_array() || triggers.as_array().unwrap().iter().any(|v| !v.is_string()) {
            return Err(AppError::BadRequest(
                "immediate_triggers must be an array of strings".into(),
            ));
        }
    }
    if let Some(qh) = input.policy.get("quiet_hours") {
        if qh.get("start").and_then(|v| v.as_str()).is_none()
            || qh.get("end").and_then(|v| v.as_str()).is_none()
        {
            return Err(AppError::BadRequest(
                "quiet_hours must include \"start\" and \"end\" (HH:MM)".into(),
            ));
        }
    }
    Ok(())
}

pub async fn get_monitoring(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    actor(&state, channel_id, &claims, false).await?;
    let row = sqlx::query_as::<_, MonitoringDto>("SELECT channel_id, bot_id, mode, scope, debounce_seconds, min_interval_seconds, max_evaluations_per_hour, batch_size, confidence_threshold::float8 AS confidence_threshold, policy FROM channel_bot_monitoring WHERE channel_id=$1 AND bot_id=$2")
        .bind(channel_id.to_string()).bind(bot_id.to_string()).fetch_optional(&state.db).await?;
    Ok(Json(json!(row.unwrap_or(MonitoringDto {
        channel_id: channel_id.to_string(),
        bot_id: bot_id.to_string(),
        mode: "off".into(),
        scope: String::new(),
        debounce_seconds: 15,
        min_interval_seconds: 60,
        max_evaluations_per_hour: 20,
        batch_size: 8,
        confidence_threshold: 0.75,
        policy: serde_json::Value::Null,
    }))))
}

pub async fn put_monitoring(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<MonitoringInput>,
) -> Result<Json<MonitoringDto>, AppError> {
    actor(&state, channel_id, &claims, true).await?;
    validate(&input)?;
    let member = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='bot')")
        .bind(channel_id.to_string()).bind(bot_id.to_string()).fetch_one(&state.db).await?;
    if !member {
        return Err(AppError::BadRequest("bot is not a channel member".into()));
    }
    let row = sqlx::query_as::<_, MonitoringDto>(r#"INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode,scope,debounce_seconds,min_interval_seconds,max_evaluations_per_hour,batch_size,confidence_threshold,next_eligible_at,policy)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $3='off' THEN NULL ELSE NOW() END,$10)
        ON CONFLICT(channel_id,bot_id) DO UPDATE SET mode=EXCLUDED.mode,scope=EXCLUDED.scope,debounce_seconds=EXCLUDED.debounce_seconds,min_interval_seconds=EXCLUDED.min_interval_seconds,max_evaluations_per_hour=EXCLUDED.max_evaluations_per_hour,batch_size=EXCLUDED.batch_size,confidence_threshold=EXCLUDED.confidence_threshold,next_eligible_at=CASE WHEN EXCLUDED.mode='off' THEN NULL ELSE NOW() END,policy=EXCLUDED.policy,updated_at=NOW()
        RETURNING channel_id,bot_id,mode,scope,debounce_seconds,min_interval_seconds,max_evaluations_per_hour,batch_size,confidence_threshold::float8 AS confidence_threshold,policy"#)
        .bind(channel_id.to_string()).bind(bot_id.to_string()).bind(&input.mode).bind(input.scope.trim()).bind(input.debounce_seconds).bind(input.min_interval_seconds).bind(input.max_evaluations_per_hour).bind(input.batch_size).bind(input.confidence_threshold).bind(&input.policy).fetch_one(&state.db).await?;
    Ok(Json(row))
}

pub async fn list_claims(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    actor(&state, channel_id, &claims, false).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let rows = sqlx::query_as::<_, ClaimDto>(r#"SELECT r.claim_id,r.evaluation_id,r.channel_id,r.bot_id,COALESCE(NULLIF(b.display_name,''),b.username) AS bot_name,r.summary,r.proposed_action,r.confidence::float8 AS confidence,r.impact,r.status,r.resolved_by,r.resolution_note,r.execution_msg_id,r.created_at,r.resolved_at FROM task_claim_requests r JOIN bot_accounts b ON b.bot_id=r.bot_id WHERE r.channel_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT $3"#)
        .bind(channel_id.to_string()).bind(q.status.as_deref()).bind(limit).fetch_all(&state.db).await?;
    Ok(Json(json!({"claims": rows})))
}

pub async fn resolve_claim(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, claim_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<ResolveInput>,
) -> Result<Json<Value>, AppError> {
    let user_id = actor(&state, channel_id, &claims, true).await?;
    if !matches!(input.decision.as_str(), "accept" | "reject") {
        return Err(AppError::BadRequest(
            "decision must be accept or reject".into(),
        ));
    }
    let status = if input.decision == "accept" {
        "accepted"
    } else {
        "rejected"
    };
    // Resolve dispatch prerequisites before consuming the one-way pending state.
    // Previously a missing PRIMARY session returned 409 only after the claim had
    // already become accepted, making the approval impossible to retry.
    let dispatch_session = if status == "accepted" {
        let bot_id = sqlx::query_scalar::<_, String>(
            "SELECT bot_id FROM task_claim_requests WHERE claim_id=$1 AND channel_id=$2 AND status='pending'",
        )
        .bind(claim_id.to_string())
        .bind(channel_id.to_string())
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::Conflict("claim is no longer pending".into()))?
        .parse::<Uuid>()
        .map_err(|_| AppError::Internal("invalid bot id".into()))?;
        Some(
            crate::domain::sessions::resolve_primary_session(
                &state.db,
                bot_id,
                &channel_id.to_string(),
            )
            .await?
            .ok_or_else(|| AppError::Conflict("bot has no primary channel session".into()))?,
        )
    } else {
        None
    };
    let row = sqlx::query(r#"UPDATE task_claim_requests SET status=$3,resolved_by=$4,resolution_note=$5,resolved_at=NOW(),updated_at=NOW() WHERE claim_id=$1 AND channel_id=$2 AND status='pending' RETURNING bot_id,summary,proposed_action"#)
        .bind(claim_id.to_string()).bind(channel_id.to_string()).bind(status).bind(user_id.to_string()).bind(input.note.as_deref()).fetch_optional(&state.db).await?;
    let Some(row) = row else {
        return Err(AppError::Conflict("claim is no longer pending".into()));
    };
    let bot_id: Uuid = row
        .try_get::<String, _>("bot_id")?
        .parse()
        .map_err(|_| AppError::Internal("invalid bot id".into()))?;
    let summary: String = row.try_get("summary")?;
    let action: String = row.try_get("proposed_action")?;
    let mut execution_msg_id = None;
    if status == "accepted" {
        // A private trigger row gives the existing dispatcher one durable, idempotent
        // trigger identity without publishing a fake human message to the channel.
        let trigger_id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("cheers:task-claim:{claim_id}").as_bytes(),
        );
        sqlx::query("INSERT INTO messages(msg_id,channel_id,sender_id,sender_type,content,msg_type,is_secret,is_partial) VALUES($1,$2,$3,'user',$4,'task_claim',TRUE,FALSE) ON CONFLICT(msg_id) DO NOTHING")
            .bind(trigger_id.to_string()).bind(channel_id.to_string()).bind(user_id.to_string()).bind(format!("Approved proactive task claim.\nSummary: {summary}\nRequested action: {action}\nComplete the requested work and report the result in this channel.")).execute(&state.db).await?;
        let session = dispatch_session.expect("accepted claims preflight a primary session");
        let result = dispatcher::dispatch(&state.db,&state.fanout,&state.stream_registry,&state.bot_locator,DispatchParams { trigger_msg_id: trigger_id,trigger_seq: 0,bot_id,channel_id,depth: 0,provider_session_key: session.1,session_id: Some(session.0),chain_id: None,context_bundle: Some(json!({"kind":"task_claim","claim_id":claim_id,"summary":summary,"proposed_action":action})) },&MediaCache::default()).await;
        match result {
            dispatcher::DispatchResult::Dispatched { placeholder_msg_id } => {
                execution_msg_id = Some(placeholder_msg_id.to_string());
                sqlx::query("UPDATE task_claim_requests SET status='executing',execution_msg_id=$2,updated_at=NOW() WHERE claim_id=$1").bind(claim_id.to_string()).bind(&execution_msg_id).execute(&state.db).await?;
            }
            dispatcher::DispatchResult::AlreadyInProgress => {
                let placeholder_msg_id = Uuid::new_v5(
                    &Uuid::NAMESPACE_DNS,
                    format!("{trigger_id}:{bot_id}").as_bytes(),
                );
                execution_msg_id = Some(placeholder_msg_id.to_string());
                sqlx::query("UPDATE task_claim_requests SET status='executing',execution_msg_id=$2,updated_at=NOW() WHERE claim_id=$1").bind(claim_id.to_string()).bind(&execution_msg_id).execute(&state.db).await?;
            }
            dispatcher::DispatchResult::BotOffline | dispatcher::DispatchResult::DbError(_) => {
                sqlx::query("UPDATE task_claim_requests SET status='failed',resolution_note=COALESCE(resolution_note,'Bot is offline'),updated_at=NOW() WHERE claim_id=$1").bind(claim_id.to_string()).execute(&state.db).await?;
            }
        }
    }
    state.fanout.broadcast_channel(channel_id, WireFrame::channel(channel_id,"task_claim_updated",json!({"claim_id":claim_id,"status":if execution_msg_id.is_some(){"executing"}else{status},"execution_msg_id":execution_msg_id}))).await;
    Ok(Json(
        json!({"claim_id":claim_id,"status":if execution_msg_id.is_some(){"executing"}else{status},"execution_msg_id":execution_msg_id}),
    ))
}

/// POST /api/v1/channels/:channel_id/task-claims/:claim_id/cancel — claimant bot
/// or channel admin cancels a still-pending/executing claim. Idempotent on a
/// terminal-state hit.
pub async fn cancel_claim(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, claim_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<CancelInput>,
) -> Result<Json<Value>, AppError> {
    let user_id = actor(&state, channel_id, &claims, true).await?;
    let row = sqlx::query(
        "UPDATE task_claim_requests
         SET status='cancelled', resolved_by=$3, resolution_note=$4, resolved_at=NOW(), updated_at=NOW()
         WHERE claim_id=$1 AND channel_id=$2 AND status IN ('pending','executing')
         RETURNING status",
    )
    .bind(claim_id.to_string())
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .bind(input.note.as_deref())
    .fetch_optional(&state.db)
    .await?;
    if row.is_none() {
        // Either the claim doesn't exist or it's already terminal — report which.
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT status FROM task_claim_requests WHERE claim_id=$1 AND channel_id=$2",
        )
        .bind(claim_id.to_string())
        .bind(channel_id.to_string())
        .fetch_optional(&state.db)
        .await?;
        return match existing.as_deref() {
            Some("cancelled") => Ok(Json(json!({"claim_id": claim_id, "status": "cancelled"}))),
            Some(_) => Err(AppError::Conflict("claim is no longer pending".into())),
            None => Err(AppError::NotFound),
        };
    }
    state
        .fanout
        .broadcast_channel(
            channel_id,
            WireFrame::channel(
                channel_id,
                "task_claim_updated",
                json!({"claim_id": claim_id, "status": "cancelled"}),
            ),
        )
        .await;
    Ok(Json(json!({"claim_id": claim_id, "status": "cancelled"})))
}

/// Sweep claims whose `expires_at` is in the past → `failed`. Called on a timer
/// (e.g. 60 s) from `main.rs`. A claim with `expires_at = NULL` never expires
/// (default for back-compat / migrated rows).
pub async fn sweep_expired_claims(db: &sqlx::PgPool) -> Result<u64, AppError> {
    let result = sqlx::query(
        "UPDATE task_claim_requests
         SET status='failed', resolution_note='expired', updated_at=NOW()
         WHERE status IN ('pending','executing') AND expires_at IS NOT NULL AND expires_at <= NOW()",
    )
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

/// Wire a pending claim to supersede an earlier, still-pending claim on the same
/// channel+bot (competing-claim dedup). The older claim is marked superseded so
/// its audit trail stays intact. No-op if the target is already terminal.
pub async fn supersede_claim(
    db: &sqlx::PgPool,
    channel_id: &str,
    superseded_claim_id: &str,
    new_claim_id: &str,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE task_claim_requests
         SET superseded_at = NOW(), resolution_note = $3, updated_at = NOW()
         WHERE claim_id = $1 AND channel_id = $2 AND status = 'pending'",
    )
    .bind(superseded_claim_id)
    .bind(channel_id)
    .bind(format!("superseded by {new_claim_id}"))
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}
