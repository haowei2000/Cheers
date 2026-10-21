//! Durable polling scheduler for proactive bot task-claim evaluations.
//! Monitoring is opt-in (`mode != off`). PostgreSQL owns cursors, rate limits and
//! reservations; connectors only decide whether the reserved activity is theirs.

use chrono::{DateTime, Timelike, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

use crate::app_state::AppState;

const POLL_SECONDS: u64 = 2;

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(POLL_SECONDS));
        loop {
            tick.tick().await;
            if let Err(error) = run_once(&state).await {
                tracing::error!(%error, "task-claim scheduler tick failed");
            }
        }
    });
}

async fn run_once(state: &AppState) -> anyhow::Result<()> {
    recover_expired_evaluations(&state.db).await?;
    let rows = sqlx::query_as!(crate::infra::db::query_rows::MonitoringRow, r###"SELECT channel_id,bot_id,mode,scope,debounce_seconds,min_interval_seconds,max_evaluations_per_hour,batch_size,confidence_threshold::float8 AS confidence_threshold,last_evaluated_seq,policy
        FROM channel_bot_monitoring
        WHERE mode <> 'off' AND (next_eligible_at IS NULL OR next_eligible_at <= NOW())
        ORDER BY COALESCE(next_eligible_at,created_at) LIMIT 20"###,
    ).fetch_all(&state.db).await?;
    for row in rows {
        if let Err(error) = schedule_one(state, row).await {
            tracing::warn!(%error, "task-claim evaluation scheduling failed");
        }
    }
    Ok(())
}

/// Recover only reservations that remain undecided after acquiring their locks.
/// Monitoring precedes evaluation everywhere in scheduler maintenance; canonical
/// completion locks evaluation without retaining a monitoring lock.
pub async fn recover_expired_evaluations(db: &PgPool) -> Result<u64, sqlx::Error> {
    let changed = sqlx::query!(
        r#"WITH monitoring AS MATERIALIZED (
          SELECT m.channel_id,m.bot_id FROM channel_bot_monitoring m
          WHERE EXISTS (
            SELECT 1 FROM task_claim_evaluations e
            WHERE e.channel_id=m.channel_id AND e.bot_id=m.bot_id
              AND e.status='dispatched' AND e.dispatched_at<clock_timestamp()-INTERVAL '10 minutes'
          )
          ORDER BY m.channel_id,m.bot_id LIMIT 20 FOR UPDATE OF m SKIP LOCKED
        ), stale AS MATERIALIZED (
          SELECT e.evaluation_id,e.channel_id,e.bot_id,e.source_seq_from,e.source_seq_to
          FROM task_claim_evaluations e JOIN monitoring m
            ON e.channel_id=m.channel_id AND e.bot_id=m.bot_id
          WHERE e.status='dispatched' AND e.dispatched_at<clock_timestamp()-INTERVAL '10 minutes'
          ORDER BY e.evaluation_id LIMIT 100 FOR UPDATE OF e SKIP LOCKED
        ), rewound AS (
          UPDATE channel_bot_monitoring m
          SET last_evaluated_seq=s.source_seq_from-1,next_eligible_at=NOW(),updated_at=NOW()
          FROM stale s WHERE m.channel_id=s.channel_id AND m.bot_id=s.bot_id
            AND m.last_evaluated_seq=s.source_seq_to
        )
        UPDATE task_claim_evaluations e
        SET status='failed',error='evaluation lease expired',completed_at=NOW()
        FROM stale s WHERE e.evaluation_id=s.evaluation_id AND e.status='dispatched'"#,
    )
    .execute(db)
    .await?;
    Ok(changed.rows_affected())
}

/// A failed socket delivery can return after a decision or a newer attempt.
/// Fence it to the actual committed reservation timestamp before touching either
/// the monitoring cursor or the evaluation's terminal state.
pub async fn fail_delivery(
    db: &PgPool,
    evaluation_id: Uuid,
    channel_id: Uuid,
    bot_id: Uuid,
    dispatched_at: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    let mut tx = db.begin().await?;
    let monitoring = sqlx::query!(
        "SELECT channel_id FROM channel_bot_monitoring WHERE channel_id=$1 AND bot_id=$2 FOR UPDATE",
        channel_id.to_string(), bot_id.to_string(),
    ).fetch_optional(&mut *tx).await?;
    if monitoring.is_none() {
        return Ok(false);
    }
    let evaluation = sqlx::query!(
        "SELECT status,source_seq_from,source_seq_to,dispatched_at FROM task_claim_evaluations
         WHERE evaluation_id=$1 AND channel_id=$2 AND bot_id=$3 FOR UPDATE",
        evaluation_id.to_string(),
        channel_id.to_string(),
        bot_id.to_string(),
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(evaluation) = evaluation else {
        return Ok(false);
    };
    if evaluation.status != "dispatched" || evaluation.dispatched_at != Some(dispatched_at) {
        return Ok(false);
    }
    sqlx::query!(
        "UPDATE channel_bot_monitoring
         SET last_evaluated_seq=$3::int8-1,next_eligible_at=NOW()+INTERVAL '15 seconds',updated_at=NOW()
         WHERE channel_id=$1 AND bot_id=$2 AND last_evaluated_seq=$4",
        channel_id.to_string(),bot_id.to_string(),evaluation.source_seq_from,evaluation.source_seq_to,
    ).execute(&mut *tx).await?;
    sqlx::query!(
        "UPDATE task_claim_evaluations SET status='failed',error='bot went offline',completed_at=NOW()
         WHERE evaluation_id=$1 AND status='dispatched' AND dispatched_at=$2",
        evaluation_id.to_string(), dispatched_at,
    ).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

async fn schedule_one(
    state: &AppState,
    row: crate::infra::db::query_rows::MonitoringRow,
) -> anyhow::Result<()> {
    let channel_id: Uuid = row.channel_id.clone().parse()?;
    let bot_id: Uuid = row.bot_id.clone().parse()?;
    if !state.bot_locator.is_online(bot_id).await {
        sqlx::query!(
            "UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '15 seconds' WHERE channel_id=$1 AND bot_id=$2",
            channel_id.to_string(),
            bot_id.to_string(),
        ).execute(&state.db).await?;
        return Ok(());
    }
    let mode: String = row.mode.clone();
    let last: i64 = row.last_evaluated_seq.clone();
    let batch: i32 = row.batch_size.clone();
    let max_hourly: i32 = row.max_evaluations_per_hour.clone();
    let debounce: i32 = row.debounce_seconds.clone();
    let interval: i32 = row.min_interval_seconds.clone();
    let confidence: f64 = row
        .confidence_threshold
        .clone()
        .ok_or_else(|| sqlx::Error::Decode(Box::new(sqlx::error::UnexpectedNullError)))?;
    let policy: serde_json::Value = row.policy.clone();
    // Quiet-hours gate: if the policy declares a quiet window and we are inside
    // it, pause (re-arm at the top of the hour — the sweeper will re-check on
    // the next tick). `quiet_hours: { "start": "22:00", "end": "07:00" }`.
    if let Some(window) = policy.get("quiet_hours") {
        if in_quiet_window(window) {
            sqlx::query!(
                "UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '10 minutes' WHERE channel_id=$1 AND bot_id=$2",
                channel_id.to_string(),
                bot_id.to_string(),
            ).execute(&state.db).await?;
            return Ok(());
        }
    }
    let hourly: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "value!" FROM task_claim_evaluations WHERE channel_id=$1 AND bot_id=$2 AND reserved_at > NOW()-INTERVAL '1 hour'"#,
        channel_id.to_string(),
        bot_id.to_string(),
    ).fetch_one(&state.db).await?;
    if hourly >= i64::from(max_hourly) {
        sqlx::query!(
            "UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '5 minutes' WHERE channel_id=$1 AND bot_id=$2",
            channel_id.to_string(),
            bot_id.to_string(),
        ).execute(&state.db).await?;
        return Ok(());
    }
    let include_voice = mode != "text";
    let candidates = sqlx::query!(
        r#"SELECT seq,kind,actor,text,created_at FROM (
        SELECT channel_seq AS seq,'message'::text AS kind,COALESCE(NULLIF(u.display_name,''),u.username,m.sender_id) AS actor,m.content AS text,m.created_at
        FROM messages m LEFT JOIN users u ON m.sender_type='user' AND u.user_id=m.sender_id
        WHERE m.channel_id=$1 AND m.sender_type='user' AND NOT m.is_partial AND NOT m.is_deleted AND NOT m.is_secret AND m.channel_seq>$2
        UNION ALL
        SELECT v.channel_seq,'voice_transcript',COALESCE(NULLIF(u.display_name,''),u.username,v.user_id),v.text,v.finalized_at
        FROM voice_transcript_segments v LEFT JOIN users u ON u.user_id=v.user_id
        WHERE v.channel_id=$1 AND $3 AND v.channel_seq>$2
      ) activity ORDER BY seq LIMIT $4"#,
        channel_id.to_string(),
        last,
        include_voice,
        i64::from(batch),
    ).fetch_all(&state.db).await?;
    if candidates.is_empty() {
        sqlx::query!(
            "UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '10 seconds' WHERE channel_id=$1 AND bot_id=$2",
            channel_id.to_string(),
            bot_id.to_string(),
        ).execute(&state.db).await?;
        return Ok(());
    }
    let newest: chrono::DateTime<chrono::Utc> = candidates
        .last()
        .unwrap()
        .created_at
        .clone()
        .ok_or_else(|| sqlx::Error::Decode(Box::new(sqlx::error::UnexpectedNullError)))?;
    let age = chrono::Utc::now()
        .signed_duration_since(newest)
        .num_seconds();
    // Immediate triggers (policy.immediate_triggers keywords present in the
    // newest candidate's text) bypass the debounce window so a directed request
    // is evaluated without waiting for the silence period.
    let immediate_triggers: Vec<String> = policy
        .get("immediate_triggers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let newest_text: String = candidates
        .last()
        .and_then(|r| r.text.clone())
        .unwrap_or_default();
    let is_immediate = immediate_triggers
        .iter()
        .any(|kw| !kw.is_empty() && newest_text.to_lowercase().contains(&kw.to_lowercase()));
    if !is_immediate && age < i64::from(debounce) {
        sqlx::query!(
            "UPDATE channel_bot_monitoring SET next_eligible_at=$3 WHERE channel_id=$1 AND bot_id=$2",
            channel_id.to_string(),
            bot_id.to_string(),
            newest + chrono::Duration::seconds(i64::from(debounce)),
        )
        .execute(&state.db)
        .await?;
        return Ok(());
    }
    let from: i64 = candidates.first().unwrap().seq.unwrap_or_default();
    let to: i64 = candidates.last().unwrap().seq.unwrap_or_default();
    let new_evaluation_id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    let reserved = sqlx::query!(
        "UPDATE channel_bot_monitoring SET last_evaluated_seq=$3,next_eligible_at=NOW()+make_interval(secs=>$4::int4),updated_at=NOW() WHERE channel_id=$1 AND bot_id=$2 AND last_evaluated_seq=$5",
        channel_id.to_string(),
        bot_id.to_string(),
        to,
        interval,
        last,
    ).execute(&mut *tx).await?.rows_affected()==1;
    if !reserved {
        tx.rollback().await?;
        return Ok(());
    }
    // A lost connector rewinds the cursor and marks its reservation failed.
    // The range itself stays unique so retries must reactivate that durable
    // evaluation instead of attempting a duplicate insert.  Reusing its ID
    // also keeps Activity history and any late connector response coherent.
    let reservation = sqlx::query!(
        "INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,reserved_at,dispatched_at) \
         VALUES($1,$2,$3,$4,$5,'dispatched',NOW(),NOW()) \
         ON CONFLICT(channel_id,bot_id,source_seq_from,source_seq_to) DO UPDATE \
         SET status='dispatched', error=NULL, reserved_at=NOW(), dispatched_at=NOW(), completed_at=NULL \
         WHERE task_claim_evaluations.status='failed' \
         RETURNING evaluation_id, dispatched_at AS \"dispatched_at!\"",
        new_evaluation_id.to_string(),
        channel_id.to_string(),
        bot_id.to_string(),
        from,
        to,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow::anyhow!("evaluation range is already active"))?;
    tx.commit().await?;
    let evaluation_id: Uuid = reservation.evaluation_id.parse()?;
    let items: Vec<Value> = candidates.into_iter().map(|r| json!({"seq":r.seq.clone().unwrap_or_default(),"kind":r.kind.clone().unwrap_or_default(),"actor":r.actor.clone().unwrap_or_default(),"text":r.text.clone().unwrap_or_default(),"created_at":r.created_at.clone().map(|d|d.to_rfc3339())})).collect();
    let frame = json!({"type":"claim_evaluation","v":1,"evaluation_id":evaluation_id,"channel_id":channel_id,"provider_session_key":format!("cheers:claim-evaluation:{channel_id}:{bot_id}"),"scope":row.scope.clone(),"confidence_threshold":confidence,"source_seq_from":from,"source_seq_to":to,"activity":items});
    if !state.bot_locator.dispatch_task(bot_id, frame).await {
        fail_delivery(
            &state.db,
            evaluation_id,
            channel_id,
            bot_id,
            reservation.dispatched_at,
        )
        .await?;
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum LegacyDecision {
    Claim,
    Ignore,
}

#[derive(Debug, serde::Deserialize)]
struct Decision {
    decision: LegacyDecision,
    confidence: Option<f64>,
}

/// Decode legacy WS results, then use the same transaction and postcommit
/// publication as MCP. Current connectors also send a final WS diagnostic after
/// their MCP decision, so an already-consumed reservation is a harmless ACK.
pub async fn complete(
    db: &PgPool,
    fanout: &dyn super::realtime::fanout::Fanout,
    bot_id: Uuid,
    evaluation_id: Uuid,
    content: Option<&str>,
    error: Option<&str>,
) -> Result<Value, crate::errors::AppError> {
    use crate::domain::task_claims::{
        complete_evaluation, CompleteEvaluationParams, EvaluationDecision,
    };
    let decision = if let Some(error) = error {
        EvaluationDecision::Failed {
            reason: error.to_string(),
        }
    } else {
        let cleaned = content
            .unwrap_or("")
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        match serde_json::from_str::<Decision>(cleaned) {
            Ok(Decision {
                decision: LegacyDecision::Claim,
                confidence,
            }) => EvaluationDecision::Claim {
                confidence: confidence.unwrap_or(0.0),
            },
            Ok(Decision {
                decision: LegacyDecision::Ignore,
                ..
            }) => EvaluationDecision::Ignore,
            Err(_) => EvaluationDecision::Failed {
                reason: if cleaned.is_empty() {
                    "bot session ended without a task-claim decision"
                } else {
                    "invalid model decision JSON"
                }
                .into(),
            },
        }
    };
    let outcome = complete_evaluation(
        db,
        CompleteEvaluationParams {
            bot_id,
            evaluation_id,
            channel_id: None,
            decision,
        },
    )
    .await?;
    if outcome.newly_decided {
        super::resource_effects::publish_claim_evaluation(fanout, &outcome.data).await;
    }
    Ok(outcome.data)
}

/// True when the current local time falls inside the policy's quiet-hours window.
/// `window` shape: `{"start":"22:00","end":"07:00"}`. Windows that cross midnight
/// (start > end) are supported. Missing/invalid fields → not quiet (fail open).
fn in_quiet_window(window: &serde_json::Value) -> bool {
    let (start, end) = match (
        window.get("start").and_then(|v| v.as_str()),
        window.get("end").and_then(|v| v.as_str()),
    ) {
        (Some(s), Some(e)) => (s, e),
        _ => return false,
    };
    let parse = |hhmm: &str| -> Option<(u32, u32)> {
        let mut parts = hhmm.split(':');
        let h = parts.next()?.parse::<u32>().ok()?;
        let m = parts.next()?.parse::<u32>().ok()?;
        if h < 24 && m < 60 {
            Some((h, m))
        } else {
            None
        }
    };
    let (sh, sm) = match parse(start) {
        Some(v) => v,
        None => return false,
    };
    let (eh, em) = match parse(end) {
        Some(v) => v,
        None => return false,
    };
    let now = chrono::Local::now();
    let minutes = now.time().hour() * 60 + now.time().minute();
    let start_min = sh * 60 + sm;
    let end_min = eh * 60 + em;
    if start_min <= end_min {
        minutes >= start_min && minutes < end_min
    } else {
        // Crosses midnight: e.g. 22:00 → 07:00.
        minutes >= start_min || minutes < end_min
    }
}
