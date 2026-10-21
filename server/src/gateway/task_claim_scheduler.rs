//! Durable polling scheduler for proactive bot task-claim evaluations.
//! Monitoring is opt-in (`mode != off`). PostgreSQL owns cursors, rate limits and
//! reservations; connectors only decide whether the reserved activity is theirs.

use chrono::{DateTime, Timelike, Utc};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, Transaction};
use std::{collections::HashMap, sync::Arc, time::Duration};
use uuid::Uuid;

use super::{registry::BotLocator, task_acceptance};
use crate::app_state::AppState;

const POLL_SECONDS: u64 = 2;

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(POLL_SECONDS));
        loop {
            tick.tick().await;
            if let Err(error) = run_once(&state.db, &state.bot_locator).await {
                tracing::error!(%error, "task-claim scheduler tick failed");
            }
        }
    });
}

pub async fn run_once(db: &PgPool, locator: &Arc<dyn BotLocator>) -> anyhow::Result<()> {
    recover_expired_evaluations(db).await?;
    let rows = sqlx::query!(
        "SELECT channel_id,bot_id
        FROM channel_bot_monitoring
        WHERE mode <> 'off' AND (next_eligible_at IS NULL OR next_eligible_at <= NOW())
        ORDER BY COALESCE(next_eligible_at,created_at) LIMIT 20",
    )
    .fetch_all(db)
    .await?;
    for row in rows {
        if let Err(error) =
            schedule_one(db, locator, row.channel_id.parse()?, row.bot_id.parse()?).await
        {
            tracing::warn!(%error, "task-claim evaluation scheduling failed");
        }
    }
    Ok(())
}

/// Recover only reservations that remain undecided after acquiring their locks.
/// Monitoring precedes evaluation in both scheduler maintenance and canonical
/// completion, after the latter has locked bot/member authority.
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

async fn defer_monitoring(
    tx: &mut Transaction<'_, Postgres>,
    channel_id: Uuid,
    bot_id: Uuid,
    seconds: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        "UPDATE channel_bot_monitoring SET next_eligible_at=clock_timestamp()+make_interval(secs=>$3::int4)
         WHERE channel_id=$1 AND bot_id=$2",
        channel_id.to_string(),
        bot_id.to_string(),
        seconds,
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn schedule_one(
    db: &PgPool,
    locator: &Arc<dyn BotLocator>,
    channel_id: Uuid,
    bot_id: Uuid,
) -> anyhow::Result<()> {
    // The due scan owns no configuration snapshot. A slow/offline locator must
    // not make an old selection overwrite a later monitoring change.
    if !locator.is_online(bot_id).await {
        sqlx::query!(
            "UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '15 seconds'
             WHERE channel_id=$1 AND bot_id=$2 AND mode<>'off'
               AND (next_eligible_at IS NULL OR next_eligible_at<=NOW())",
            channel_id.to_string(),
            bot_id.to_string(),
        )
        .execute(db)
        .await?;
        return Ok(());
    }
    let mut tx = db.begin().await?;
    // Parent bot/member authority precedes its monitoring/evaluation children,
    // including the FK cascade order used when a bot is deleted.
    let may_evaluate = task_acceptance::may_execute(&mut tx, bot_id, channel_id, None).await?;
    let row = sqlx::query_as!(crate::infra::db::query_rows::MonitoringRow,
        "SELECT mode,scope,debounce_seconds,min_interval_seconds,
                max_evaluations_per_hour,batch_size,confidence_threshold::float8 AS confidence_threshold,
                last_evaluated_seq,policy FROM channel_bot_monitoring
         WHERE channel_id=$1 AND bot_id=$2 AND mode<>'off'
           AND (next_eligible_at IS NULL OR next_eligible_at<=clock_timestamp())
         FOR UPDATE SKIP LOCKED",
        channel_id.to_string(), bot_id.to_string(),
    ).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(());
    };
    // Online is a transport property. Use the same enabled/writable bot gate as
    // execution grants before reading any channel activity.
    if !may_evaluate {
        defer_monitoring(&mut tx, channel_id, bot_id, 15).await?;
        tx.commit().await?;
        return Ok(());
    }
    if row.policy.get("quiet_hours").is_some_and(in_quiet_window) {
        defer_monitoring(&mut tx, channel_id, bot_id, 600).await?;
        tx.commit().await?;
        return Ok(());
    }
    let hourly = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "value!" FROM task_claim_evaluations
           WHERE channel_id=$1 AND bot_id=$2 AND reserved_at>clock_timestamp()-INTERVAL '1 hour'"#,
        channel_id.to_string(),
        bot_id.to_string(),
    )
    .fetch_one(&mut *tx)
    .await?;
    if hourly >= i64::from(row.max_evaluations_per_hour) {
        defer_monitoring(&mut tx, channel_id, bot_id, 300).await?;
        tx.commit().await?;
        return Ok(());
    }
    let candidates = sqlx::query!(
        r#"SELECT id AS "id!",seq AS "seq!",kind AS "kind!",author_id AS "author_id!",
                  actor AS "actor!",text AS "text!",created_at AS "created_at!" FROM (
          SELECT m.msg_id AS id,m.channel_seq AS seq,'message'::text AS kind,m.sender_id AS author_id,
                 COALESCE(NULLIF(u.display_name,''),u.username,m.sender_id) AS actor,
                 m.content AS text,m.created_at
          FROM messages m LEFT JOIN users u ON u.user_id=m.sender_id
          WHERE m.channel_id=$1 AND m.sender_type='user' AND NOT m.is_partial
            AND NOT m.is_deleted AND NOT m.is_secret AND m.channel_seq>$2
          UNION ALL
          SELECT v.segment_id,v.channel_seq,'voice_transcript',v.user_id,
                 COALESCE(NULLIF(u.display_name,''),u.username,v.user_id),v.text,v.finalized_at
          FROM voice_transcript_segments v LEFT JOIN users u ON u.user_id=v.user_id
          WHERE v.channel_id=$1 AND $3 AND v.channel_seq>$2 AND v.deleted_at IS NULL
        ) activity ORDER BY seq LIMIT $4"#,
        channel_id.to_string(), row.last_evaluated_seq, row.mode != "text", i64::from(row.batch_size),
    ).fetch_all(&mut *tx).await?;
    if candidates.is_empty() {
        defer_monitoring(&mut tx, channel_id, bot_id, 10).await?;
        tx.commit().await?;
        return Ok(());
    }
    // Lock the actual selected sources and compare their bodies after any lock
    // wait. Never disclose an old copy of a deleted, hidden or edited source.
    let message_ids: Vec<String> = candidates
        .iter()
        .filter(|r| r.kind == "message")
        .map(|r| r.id.clone())
        .collect();
    let segment_ids: Vec<String> = candidates
        .iter()
        .filter(|r| r.kind == "voice_transcript")
        .map(|r| r.id.clone())
        .collect();
    let messages = sqlx::query!(
        "SELECT msg_id,sender_id,channel_seq,content FROM messages
         WHERE channel_id=$1 AND msg_id=ANY($2) AND sender_type='user'
           AND NOT is_partial AND NOT is_deleted AND NOT is_secret ORDER BY msg_id FOR SHARE",
        channel_id.to_string(),
        &message_ids,
    )
    .fetch_all(&mut *tx)
    .await?;
    let segments = sqlx::query!(
        "SELECT segment_id,user_id,channel_seq,text FROM voice_transcript_segments
         WHERE channel_id=$1 AND segment_id=ANY($2) AND deleted_at IS NULL ORDER BY segment_id FOR SHARE",
        channel_id.to_string(), &segment_ids,
    ).fetch_all(&mut *tx).await?;
    for candidate in &candidates {
        let unchanged = if candidate.kind == "message" {
            messages.iter().any(|m| {
                m.msg_id == candidate.id
                    && m.sender_id == candidate.author_id
                    && m.channel_seq == Some(candidate.seq)
                    && m.content == candidate.text
            })
        } else {
            segments.iter().any(|v| {
                v.segment_id == candidate.id
                    && v.user_id == candidate.author_id
                    && v.channel_seq == candidate.seq
                    && v.text == candidate.text
            })
        };
        if !unchanged {
            return Ok(());
        }
    }
    let mut authors = HashMap::new();
    let mut eligible = Vec::new();
    for candidate in &candidates {
        let author = candidate.author_id.parse::<Uuid>()?;
        let allowed = if let Some(allowed) = authors.get(&author) {
            *allowed
        } else {
            use crate::domain::message_policy::{
                reauthorize_human_intent_tx, HumanIntentPolicyError,
            };
            let allowed =
                match reauthorize_human_intent_tx(&mut tx, author, channel_id, bot_id).await {
                    Ok(()) => true,
                    Err(HumanIntentPolicyError::Denied(_)) => false,
                    Err(HumanIntentPolicyError::Retryable(error)) => return Err(error.into()),
                };
            authors.insert(author, allowed);
            allowed
        };
        if allowed {
            eligible.push(candidate);
        }
    }
    let from = candidates[0].seq;
    let Some(newest) = eligible.last() else {
        // A pending evaluation owns this cursor for delivery/lease recovery.
        // Scanning a denied tail must not take that recovery position away.
        let pending = sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM task_claim_evaluations
               WHERE channel_id=$1 AND bot_id=$2 AND status='dispatched'
                 AND source_seq_to=$3) AS "pending!""#,
            channel_id.to_string(),
            bot_id.to_string(),
            row.last_evaluated_seq,
        )
        .fetch_one(&mut *tx)
        .await?;
        if pending {
            defer_monitoring(&mut tx, channel_id, bot_id, 10).await?;
            tx.commit().await?;
            return Ok(());
        }
        // Denial is authoritative, unlike a DB outage. Advance a wholly denied
        // window without spending evaluation budget so it cannot block later work.
        sqlx::query!(
            "UPDATE channel_bot_monitoring SET last_evaluated_seq=$3,
                 next_eligible_at=clock_timestamp()+INTERVAL '10 seconds',updated_at=NOW()
             WHERE channel_id=$1 AND bot_id=$2",
            channel_id.to_string(),
            bot_id.to_string(),
            candidates.last().unwrap().seq,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(());
    };
    let immediate = row
        .policy
        .get("immediate_triggers")
        .and_then(Value::as_array)
        .is_some_and(|triggers| {
            triggers.iter().filter_map(Value::as_str).any(|keyword| {
                !keyword.is_empty() && newest.text.to_lowercase().contains(&keyword.to_lowercase())
            })
        });
    if !immediate
        && Utc::now()
            .signed_duration_since(newest.created_at)
            .num_seconds()
            < i64::from(row.debounce_seconds)
    {
        sqlx::query!(
            "UPDATE channel_bot_monitoring SET next_eligible_at=$3 WHERE channel_id=$1 AND bot_id=$2",
            channel_id.to_string(),bot_id.to_string(),newest.created_at+chrono::Duration::seconds(i64::from(row.debounce_seconds)),
        ).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(());
    }
    // The final source must be an actually disclosed, authorized activity. Keep
    // denied trailing rows for the next scan so retry rewind still owns its range.
    let to = newest.seq;
    sqlx::query!(
        "UPDATE channel_bot_monitoring SET last_evaluated_seq=$3,
             next_eligible_at=clock_timestamp()+make_interval(secs=>$4::int4),updated_at=NOW()
         WHERE channel_id=$1 AND bot_id=$2",
        channel_id.to_string(),
        bot_id.to_string(),
        to,
        row.min_interval_seconds,
    )
    .execute(&mut *tx)
    .await?;
    let reservation = sqlx::query!(
        r#"INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,reserved_at,dispatched_at)
         VALUES($1,$2,$3,$4,$5,'dispatched',clock_timestamp(),clock_timestamp())
         ON CONFLICT(channel_id,bot_id,source_seq_from,source_seq_to) DO UPDATE
         SET status='dispatched',error=NULL,reserved_at=clock_timestamp(),dispatched_at=clock_timestamp(),completed_at=NULL
         WHERE task_claim_evaluations.status='failed'
         RETURNING evaluation_id,dispatched_at AS "dispatched_at!""#,
        Uuid::new_v4().to_string(),channel_id.to_string(),bot_id.to_string(),from,to,
    ).fetch_optional(&mut *tx).await?
        .ok_or_else(|| anyhow::anyhow!("evaluation range is already active"))?;
    let confidence = row
        .confidence_threshold
        .ok_or_else(|| sqlx::Error::Decode(Box::new(sqlx::error::UnexpectedNullError)))?;
    let items: Vec<Value> = eligible.iter().map(|r| json!({"seq":r.seq,"kind":r.kind,"actor":r.actor,"text":r.text,"created_at":r.created_at.to_rfc3339()})).collect();
    let evaluation_id: Uuid = reservation.evaluation_id.parse()?;
    let frame = json!({"type":"claim_evaluation","v":1,"evaluation_id":evaluation_id,"channel_id":channel_id,
        "provider_session_key":format!("cheers:claim-evaluation:{channel_id}:{bot_id}"),"scope":row.scope,
        "confidence_threshold":confidence,"source_seq_from":from,"source_seq_to":to,"activity":items});
    tx.commit().await?;
    if !locator.dispatch_task(bot_id, frame).await {
        fail_delivery(
            db,
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
