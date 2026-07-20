//! Durable polling scheduler for proactive bot task-claim evaluations.
//! Monitoring is opt-in (`mode != off`). PostgreSQL owns cursors, rate limits and
//! reservations; connectors only decide whether the reserved activity is theirs.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::time::Duration;
use uuid::Uuid;

use crate::{app_state::AppState, gateway::realtime::frame::WireFrame};

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
    // Re-open ranges whose connector vanished mid-evaluation. The cursor rewind
    // is conditional on still pointing at that exact reservation, so it cannot
    // overwrite a later successful reservation.
    sqlx::query(r#"WITH stale AS (
        SELECT evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to
        FROM task_claim_evaluations WHERE status='dispatched' AND dispatched_at < NOW()-INTERVAL '10 minutes'
      ), rewound AS (
        UPDATE channel_bot_monitoring m SET last_evaluated_seq=s.source_seq_from-1,next_eligible_at=NOW()
        FROM stale s WHERE m.channel_id=s.channel_id AND m.bot_id=s.bot_id AND m.last_evaluated_seq=s.source_seq_to
        RETURNING s.evaluation_id
      ) UPDATE task_claim_evaluations e SET status='failed',error='evaluation lease expired',completed_at=NOW()
        FROM rewound r WHERE e.evaluation_id=r.evaluation_id"#).execute(&state.db).await?;
    let rows = sqlx::query(r#"SELECT channel_id,bot_id,mode,scope,debounce_seconds,min_interval_seconds,max_evaluations_per_hour,batch_size,confidence_threshold::float8 AS confidence_threshold,last_evaluated_seq
        FROM channel_bot_monitoring
        WHERE mode <> 'off' AND (next_eligible_at IS NULL OR next_eligible_at <= NOW())
        ORDER BY COALESCE(next_eligible_at,created_at) LIMIT 20"#).fetch_all(&state.db).await?;
    for row in rows {
        if let Err(error) = schedule_one(state, row).await {
            tracing::warn!(%error, "task-claim evaluation scheduling failed");
        }
    }
    Ok(())
}

async fn schedule_one(state: &AppState, row: sqlx::postgres::PgRow) -> anyhow::Result<()> {
    let channel_id: Uuid = row.try_get::<String, _>("channel_id")?.parse()?;
    let bot_id: Uuid = row.try_get::<String, _>("bot_id")?.parse()?;
    if !state.bot_locator.is_online(bot_id).await {
        sqlx::query("UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '15 seconds' WHERE channel_id=$1 AND bot_id=$2")
            .bind(channel_id.to_string()).bind(bot_id.to_string()).execute(&state.db).await?;
        return Ok(());
    }
    let mode: String = row.try_get("mode")?;
    let last: i64 = row.try_get("last_evaluated_seq")?;
    let batch: i32 = row.try_get("batch_size")?;
    let max_hourly: i32 = row.try_get("max_evaluations_per_hour")?;
    let debounce: i32 = row.try_get("debounce_seconds")?;
    let interval: i32 = row.try_get("min_interval_seconds")?;
    let confidence: f64 = row.try_get("confidence_threshold")?;
    let hourly: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_claim_evaluations WHERE channel_id=$1 AND bot_id=$2 AND reserved_at > NOW()-INTERVAL '1 hour'")
        .bind(channel_id.to_string()).bind(bot_id.to_string()).fetch_one(&state.db).await?;
    if hourly >= i64::from(max_hourly) {
        sqlx::query("UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '5 minutes' WHERE channel_id=$1 AND bot_id=$2")
            .bind(channel_id.to_string()).bind(bot_id.to_string()).execute(&state.db).await?;
        return Ok(());
    }
    let include_voice = mode != "text";
    let candidates = sqlx::query(r#"SELECT seq,kind,actor,text,created_at FROM (
        SELECT channel_seq AS seq,'message'::text AS kind,COALESCE(NULLIF(u.display_name,''),u.username,m.sender_id) AS actor,m.content AS text,m.created_at
        FROM messages m LEFT JOIN users u ON m.sender_type='user' AND u.user_id=m.sender_id
        WHERE m.channel_id=$1 AND m.sender_type='user' AND NOT m.is_partial AND NOT m.is_deleted AND NOT m.is_secret AND m.channel_seq>$2
        UNION ALL
        SELECT v.channel_seq,'voice_transcript',COALESCE(NULLIF(u.display_name,''),u.username,v.user_id),v.text,v.finalized_at
        FROM voice_transcript_segments v LEFT JOIN users u ON u.user_id=v.user_id
        WHERE v.channel_id=$1 AND $3 AND v.channel_seq>$2
      ) activity ORDER BY seq LIMIT $4"#)
        .bind(channel_id.to_string()).bind(last).bind(include_voice).bind(batch).fetch_all(&state.db).await?;
    if candidates.is_empty() {
        sqlx::query("UPDATE channel_bot_monitoring SET next_eligible_at=NOW()+INTERVAL '10 seconds' WHERE channel_id=$1 AND bot_id=$2")
            .bind(channel_id.to_string()).bind(bot_id.to_string()).execute(&state.db).await?;
        return Ok(());
    }
    let newest: chrono::DateTime<chrono::Utc> = candidates.last().unwrap().try_get("created_at")?;
    let age = chrono::Utc::now()
        .signed_duration_since(newest)
        .num_seconds();
    if age < i64::from(debounce) {
        sqlx::query("UPDATE channel_bot_monitoring SET next_eligible_at=$3 WHERE channel_id=$1 AND bot_id=$2")
            .bind(channel_id.to_string()).bind(bot_id.to_string()).bind(newest + chrono::Duration::seconds(i64::from(debounce))).execute(&state.db).await?;
        return Ok(());
    }
    let from: i64 = candidates.first().unwrap().try_get("seq")?;
    let to: i64 = candidates.last().unwrap().try_get("seq")?;
    let evaluation_id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    let reserved = sqlx::query("UPDATE channel_bot_monitoring SET last_evaluated_seq=$3,next_eligible_at=NOW()+make_interval(secs=>$4),updated_at=NOW() WHERE channel_id=$1 AND bot_id=$2 AND last_evaluated_seq=$5")
        .bind(channel_id.to_string()).bind(bot_id.to_string()).bind(to).bind(interval).bind(last).execute(&mut *tx).await?.rows_affected()==1;
    if !reserved {
        tx.rollback().await?;
        return Ok(());
    }
    sqlx::query("INSERT INTO task_claim_evaluations(evaluation_id,channel_id,bot_id,source_seq_from,source_seq_to,status,reserved_at,dispatched_at) VALUES($1,$2,$3,$4,$5,'dispatched',NOW(),NOW())")
        .bind(evaluation_id.to_string()).bind(channel_id.to_string()).bind(bot_id.to_string()).bind(from).bind(to).execute(&mut *tx).await?;
    tx.commit().await?;
    let items: Vec<Value> = candidates.into_iter().map(|r| json!({"seq":r.try_get::<i64,_>("seq").unwrap_or_default(),"kind":r.try_get::<String,_>("kind").unwrap_or_default(),"actor":r.try_get::<String,_>("actor").unwrap_or_default(),"text":r.try_get::<String,_>("text").unwrap_or_default(),"created_at":r.try_get::<chrono::DateTime<chrono::Utc>,_>("created_at").ok().map(|d|d.to_rfc3339())})).collect();
    let frame = json!({"type":"claim_evaluation","v":1,"evaluation_id":evaluation_id,"channel_id":channel_id,"provider_session_key":format!("cheers:claim-evaluation:{channel_id}:{bot_id}"),"scope":row.try_get::<String,_>("scope").unwrap_or_default(),"confidence_threshold":confidence,"source_seq_from":from,"source_seq_to":to,"activity":items});
    if !state.bot_locator.dispatch_task(bot_id, frame).await {
        let mut tx = state.db.begin().await?;
        sqlx::query("UPDATE channel_bot_monitoring SET last_evaluated_seq=$3-1,next_eligible_at=NOW()+INTERVAL '15 seconds' WHERE channel_id=$1 AND bot_id=$2 AND last_evaluated_seq=$4").bind(channel_id.to_string()).bind(bot_id.to_string()).bind(from).bind(to).execute(&mut *tx).await?;
        sqlx::query("UPDATE task_claim_evaluations SET status='failed',error='bot went offline',completed_at=NOW() WHERE evaluation_id=$1").bind(evaluation_id.to_string()).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
struct Decision {
    decision: String,
    summary: Option<String>,
    proposed_action: Option<String>,
    confidence: Option<f64>,
    impact: Option<String>,
}

/// Complete one evaluation from the connector. The connector returns the agent's
/// strict JSON decision; the gateway validates policy and is the only claim writer.
pub async fn complete(
    db: &PgPool,
    state: &AppState,
    bot_id: Uuid,
    evaluation_id: Uuid,
    content: Option<&str>,
    error: Option<&str>,
) -> anyhow::Result<Value> {
    let eval = sqlx::query(
        "SELECT channel_id,status FROM task_claim_evaluations WHERE evaluation_id=$1 AND bot_id=$2",
    )
    .bind(evaluation_id.to_string())
    .bind(bot_id.to_string())
    .fetch_optional(db)
    .await?;
    let Some(eval) = eval else {
        anyhow::bail!("unknown evaluation");
    };
    if eval.try_get::<String, _>("status")? != "dispatched" {
        return Ok(json!({"evaluation_id":evaluation_id,"duplicate":true}));
    }
    let channel_id: Uuid = eval.try_get::<String, _>("channel_id")?.parse()?;
    if let Some(error) = error {
        sqlx::query("UPDATE task_claim_evaluations SET status='failed',error=$2,completed_at=NOW() WHERE evaluation_id=$1").bind(evaluation_id.to_string()).bind(error).execute(db).await?;
        return Ok(json!({"evaluation_id":evaluation_id,"status":"failed"}));
    }
    let cleaned = content
        .unwrap_or("")
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let decision: Decision = serde_json::from_str(cleaned).unwrap_or(Decision {
        decision: "ignore".into(),
        summary: None,
        proposed_action: None,
        confidence: None,
        impact: None,
    });
    if decision.decision != "claim" {
        sqlx::query("UPDATE task_claim_evaluations SET status='ignored',completed_at=NOW() WHERE evaluation_id=$1").bind(evaluation_id.to_string()).execute(db).await?;
        return Ok(json!({"evaluation_id":evaluation_id,"status":"ignored"}));
    }
    let threshold: f64 = sqlx::query_scalar("SELECT confidence_threshold::float8 FROM channel_bot_monitoring WHERE channel_id=$1 AND bot_id=$2").bind(channel_id.to_string()).bind(bot_id.to_string()).fetch_one(db).await?;
    let confidence = decision.confidence.unwrap_or(0.0).clamp(0.0, 1.0);
    if confidence < threshold {
        sqlx::query("UPDATE task_claim_evaluations SET status='ignored',completed_at=NOW() WHERE evaluation_id=$1").bind(evaluation_id.to_string()).execute(db).await?;
        return Ok(json!({"evaluation_id":evaluation_id,"status":"below_threshold"}));
    }
    let summary = decision
        .summary
        .unwrap_or_default()
        .trim()
        .chars()
        .take(1000)
        .collect::<String>();
    let action = decision
        .proposed_action
        .unwrap_or_default()
        .trim()
        .chars()
        .take(4000)
        .collect::<String>();
    if summary.is_empty() || action.is_empty() {
        anyhow::bail!("claim decision missing summary or proposed_action");
    }
    let impact = decision
        .impact
        .filter(|v| matches!(v.as_str(), "low" | "medium" | "high"))
        .unwrap_or_else(|| "medium".into());
    let claim_id = Uuid::new_v4();
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE task_claim_evaluations SET status='completed',completed_at=NOW() WHERE evaluation_id=$1 AND status='dispatched'").bind(evaluation_id.to_string()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO task_claim_requests(claim_id,evaluation_id,channel_id,bot_id,summary,proposed_action,confidence,impact) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(evaluation_id) DO NOTHING")
        .bind(claim_id.to_string()).bind(evaluation_id.to_string()).bind(channel_id.to_string()).bind(bot_id.to_string()).bind(&summary).bind(&action).bind(confidence).bind(&impact).execute(&mut *tx).await?;
    tx.commit().await?;
    state.fanout.broadcast_channel(channel_id,WireFrame::channel(channel_id,"task_claim_created",json!({"claim_id":claim_id,"evaluation_id":evaluation_id,"channel_id":channel_id,"bot_id":bot_id,"summary":summary,"proposed_action":action,"confidence":confidence,"impact":impact,"status":"pending"}))).await;
    Ok(json!({"evaluation_id":evaluation_id,"claim_id":claim_id,"status":"pending"}))
}
