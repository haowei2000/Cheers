use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::task_claims::{self, ClaimDecision, ResolveClaimParams},
    errors::AppError,
    gateway::realtime::frame::WireFrame,
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
    pub requester_id: Option<String>,
    pub source_message_id: Option<String>,
    pub confirmation_message_id: Option<String>,
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
    let role = sqlx::query_scalar!(
        "SELECT role FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='user'",
        channel_id.to_string(),
        user_id.to_string(),
    )
    .fetch_optional(&state.db)
    .await?;
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
    let row = sqlx::query_as!(
        MonitoringDto,
        r#"SELECT channel_id, bot_id, mode, scope, debounce_seconds, min_interval_seconds, max_evaluations_per_hour, batch_size, confidence_threshold::float8 AS "confidence_threshold!", policy FROM channel_bot_monitoring WHERE channel_id=$1 AND bot_id=$2"#,
        channel_id.to_string(),
        bot_id.to_string(),
    ).fetch_optional(&state.db).await?;
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
    let member = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 AS present FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='bot') AS "value!" "#,
        channel_id.to_string(),
        bot_id.to_string(),
    ).fetch_one(&state.db).await?;
    if !member {
        return Err(AppError::BadRequest("bot is not a channel member".into()));
    }
    let row = sqlx::query_as!(
        MonitoringDto,
        r#"INSERT INTO channel_bot_monitoring(channel_id,bot_id,mode,scope,debounce_seconds,min_interval_seconds,max_evaluations_per_hour,batch_size,confidence_threshold,next_eligible_at,policy)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::float8,CASE WHEN $3::varchar='off' THEN NULL ELSE NOW() END,$10)
        ON CONFLICT(channel_id,bot_id) DO UPDATE SET mode=EXCLUDED.mode,scope=EXCLUDED.scope,debounce_seconds=EXCLUDED.debounce_seconds,min_interval_seconds=EXCLUDED.min_interval_seconds,max_evaluations_per_hour=EXCLUDED.max_evaluations_per_hour,batch_size=EXCLUDED.batch_size,confidence_threshold=EXCLUDED.confidence_threshold,next_eligible_at=CASE WHEN EXCLUDED.mode='off' THEN NULL ELSE NOW() END,policy=EXCLUDED.policy,updated_at=NOW()
        RETURNING channel_id,bot_id,mode,scope,debounce_seconds,min_interval_seconds,max_evaluations_per_hour,batch_size,confidence_threshold::float8 AS "confidence_threshold!",policy"#,
        channel_id.to_string(),
        bot_id.to_string(),
        &input.mode,
        input.scope.trim(),
        input.debounce_seconds,
        input.min_interval_seconds,
        input.max_evaluations_per_hour,
        input.batch_size,
        input.confidence_threshold,
        &input.policy,
    ).fetch_one(&state.db).await?;
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
    let rows = sqlx::query_as!(
        ClaimDto,
        r#"SELECT r.claim_id,r.evaluation_id,r.channel_id,r.bot_id,COALESCE(NULLIF(b.display_name,''),b.username) AS "bot_name!",r.summary,r.proposed_action,r.confidence::float8 AS "confidence!",r.impact,r.status,r.resolved_by,r.resolution_note,r.execution_msg_id,r.created_at,r.resolved_at,r.requester_id,r.source_message_id,r.confirmation_message_id FROM task_claim_requests r JOIN bot_accounts b ON b.bot_id=r.bot_id WHERE r.channel_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT $3"#,
        channel_id.to_string(),
        q.status.as_deref(),
        limit,
    ).fetch_all(&state.db).await?;
    Ok(Json(json!({"claims": rows})))
}

pub async fn resolve_claim(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, claim_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<ResolveInput>,
) -> Result<Json<Value>, AppError> {
    let requester_id = actor(&state, channel_id, &claims, false).await?;
    let decision = match input.decision.as_str() {
        "accept" => ClaimDecision::Accept,
        "reject" => ClaimDecision::Reject,
        _ => {
            return Err(AppError::BadRequest(
                "decision must be accept or reject".into(),
            ))
        }
    };
    let outcome = task_claims::resolve(
        &state.db,
        state.bot_locator.as_ref(),
        ResolveClaimParams {
            channel_id,
            claim_id,
            requester_id,
            decision,
            note: input.note,
        },
    )
    .await?;
    let result = json!({"claim_id":outcome.claim_id,"status":outcome.status,"execution_msg_id":outcome.execution_msg_id});
    state
        .fanout
        .broadcast_channel(
            channel_id,
            WireFrame::channel(channel_id, "task_claim_updated", result.clone()),
        )
        .await;
    // The committed intent survives process loss at this boundary. Preparation
    // never blocks the approval response and cannot overwrite a later cancel.
    if let Some(trigger) = outcome.trigger_msg_id {
        let (db, fanout, registry, locator) = (
            state.db.clone(),
            state.fanout.clone(),
            state.stream_registry.clone(),
            state.bot_locator.clone(),
        );
        tokio::spawn(async move {
            if let Err(error) = crate::gateway::dispatch_intents::deliver_trigger(
                &db, &fanout, &registry, &locator, trigger,
            )
            .await
            {
                tracing::warn!(%claim_id,%error,"approved task claim retained for delivery recovery");
            }
        });
    }
    Ok(Json(result))
}

/// POST /api/v1/channels/:channel_id/task-claims/:claim_id/cancel — a channel
/// administrator cancels a still-pending/executing claim. Idempotent on a
/// terminal-state hit.
pub async fn cancel_claim(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, claim_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<CancelInput>,
) -> Result<Json<Value>, AppError> {
    let user_id = actor(&state, channel_id, &claims, true).await?;
    let outcome = task_claims::cancel(
        &state.db,
        channel_id,
        claim_id,
        user_id,
        input.note.as_deref(),
    )
    .await?;
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
    Ok(Json(
        json!({"claim_id": outcome.claim_id, "status": outcome.status}),
    ))
}

/// Sweep claims whose `expires_at` is in the past → `failed`. Called on a timer
/// (e.g. 60 s) from `main.rs`. A claim with `expires_at = NULL` never expires
/// (default for back-compat / migrated rows).
pub async fn sweep_expired_claims(db: &sqlx::PgPool) -> Result<u64, AppError> {
    let result = sqlx::query!(
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
    let result = sqlx::query!(
        "UPDATE task_claim_requests
         SET superseded_at = NOW(), resolution_note = $3, updated_at = NOW()
         WHERE claim_id = $1 AND channel_id = $2 AND status = 'pending'",
        superseded_claim_id,
        channel_id,
        format!("superseded by {new_claim_id}"),
    )
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}
