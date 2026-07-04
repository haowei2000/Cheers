//! Durable agent-trace timeline (`message_traces`).
//!
//! Append-only progress log anchored to the bot-turn message it belongs to.
//! "Approve" folds in as `kind="approval"` rows so the approval lifecycle
//! interleaves with tool_call/plan/prompt traces for the same turn. Sibling to
//! [`crate::domain::approval`] `approval_audit`, which stays the immutable legal
//! log; this table is the queryable in-context timeline (best-effort).
//! See docs/arch/TRACE_PERSISTENCE.md.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Run-skeleton phases persisted durably (besides `kind="approval"`, which is
/// always kept). Per-token / thought chunks are dropped by default — see
/// [`should_persist`]. Keeps durable rows ~tool-call-count per turn, not token
/// count.
const PERSISTED_TRACE_PHASES: &[&str] = &[
    "tool_call",
    "tool_call_update",
    "plan",
    "prompt_started",
    "prompt_finished",
    "prompt_failed",
    "terminal_ack_failed",
];

const SEQ_RETRY: u8 = 4;

/// Write-time retention allowlist. `kind="approval"` is always persisted
/// (low-volume, compliance); run-skeleton phases are persisted; everything else
/// (e.g. `agent_thought_chunk`, per-token frames) is dropped from durable
/// storage unless `CHEERS_TRACE_PERSIST_THOUGHTS=1`. The live fan-out is
/// unaffected — only the durable record is thinned.
pub fn should_persist(kind: &str, phase: &str) -> bool {
    if kind == "approval" {
        return true;
    }
    if PERSISTED_TRACE_PHASES.contains(&phase) {
        return true;
    }
    matches!(
        std::env::var("CHEERS_TRACE_PERSIST_THOUGHTS").as_deref(),
        Ok("1") | Ok("true")
    )
}

/// One append-only trace event. Construct with `..Default::default()` and fill
/// only the relevant fields. `kind="trace"` for agent progress, `kind="approval"`
/// for the approval lifecycle (sub-state in `approval_kind`).
#[derive(Default)]
pub struct TraceEvent {
    pub msg_id: String,
    pub channel_id: String,
    pub bot_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub stream: Option<String>,
    pub kind: &'static str,
    pub phase: String,
    pub status: Option<String>,
    pub title: Option<String>,
    pub message: Option<String>,
    pub data: Option<Value>,
    // Approval lifecycle (only when kind="approval").
    pub request_id: Option<String>,
    pub approval_kind: Option<String>,
    pub decision: Option<String>,
    pub option_id: Option<String>,
    pub actor_id: Option<String>,
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.code().as_deref() == Some("23505"))
}

/// Append a trace row, allocating a per-`msg_id` monotonic `trace_seq` via
/// `MAX(seq)+1` with a bounded retry against the `UNIQUE(msg_id, trace_seq)`
/// guard (concurrent runs can share a `msg_id`). Best-effort: callers on the
/// high-frequency path spawn this and log on error — a trace write must never
/// block the connector frame loop or the approval hot path.
pub async fn record(db: &PgPool, ev: TraceEvent) -> Result<(), sqlx::Error> {
    // Defense-in-depth: `msg_id` is the VARCHAR(36) anchor and can originate from
    // a bot-supplied frame. Skip (best-effort) rather than let a too-long/empty
    // id raise a Postgres 22001 that silently drops the row. Centralized here so
    // every caller is protected.
    if ev.msg_id.is_empty() || ev.msg_id.len() > 36 {
        tracing::warn!(msg_id = %ev.msg_id, "message_traces: invalid anchor msg_id; skipping persist");
        return Ok(());
    }
    let stream = ev.stream.clone().unwrap_or_else(|| "acp".to_string());
    let kind = if ev.kind.is_empty() { "trace" } else { ev.kind };
    let mut last_err: Option<sqlx::Error> = None;
    for _ in 0..SEQ_RETRY {
        let res = sqlx::query(
            "INSERT INTO message_traces
                (id, msg_id, channel_id, bot_id, task_id, run_id, trace_seq, stream,
                 kind, phase, status, title, message, data,
                 request_id, approval_kind, decision, option_id, actor_id)
             VALUES ($1, $2, $3, $4, $5, $6,
                 (SELECT COALESCE(MAX(trace_seq), 0) + 1 FROM message_traces WHERE msg_id = $2),
                 $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&ev.msg_id)
        .bind(&ev.channel_id)
        .bind(&ev.bot_id)
        .bind(&ev.task_id)
        .bind(&ev.run_id)
        .bind(&stream)
        .bind(kind)
        .bind(&ev.phase)
        .bind(&ev.status)
        .bind(&ev.title)
        .bind(&ev.message)
        .bind(&ev.data)
        .bind(&ev.request_id)
        .bind(&ev.approval_kind)
        .bind(&ev.decision)
        .bind(&ev.option_id)
        .bind(&ev.actor_id)
        .execute(db)
        .await;
        match res {
            Ok(_) => return Ok(()),
            // Lost the MAX(seq)+1 race for this msg_id; recompute and retry.
            Err(err) if is_unique_violation(&err) => {
                last_err = Some(err);
                continue;
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        sqlx::Error::Protocol("message_traces trace_seq retry exhausted".into())
    }))
}

fn row_to_json(r: sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "msg_id": r.try_get::<String, _>("msg_id").unwrap_or_default(),
        "channel_id": r.try_get::<String, _>("channel_id").unwrap_or_default(),
        "bot_id": r.try_get::<Option<String>, _>("bot_id").ok().flatten(),
        "task_id": r.try_get::<Option<String>, _>("task_id").ok().flatten(),
        "run_id": r.try_get::<Option<String>, _>("run_id").ok().flatten(),
        "trace_seq": r.try_get::<i64, _>("trace_seq").unwrap_or_default(),
        "stream": r.try_get::<String, _>("stream").unwrap_or_default(),
        "kind": r.try_get::<String, _>("kind").unwrap_or_default(),
        "phase": r.try_get::<String, _>("phase").unwrap_or_default(),
        "status": r.try_get::<Option<String>, _>("status").ok().flatten(),
        "title": r.try_get::<Option<String>, _>("title").ok().flatten(),
        "message": r.try_get::<Option<String>, _>("message").ok().flatten(),
        "data": r.try_get::<Option<Value>, _>("data").ok().flatten(),
        "request_id": r.try_get::<Option<String>, _>("request_id").ok().flatten(),
        "approval_kind": r.try_get::<Option<String>, _>("approval_kind").ok().flatten(),
        "decision": r.try_get::<Option<String>, _>("decision").ok().flatten(),
        "option_id": r.try_get::<Option<String>, _>("option_id").ok().flatten(),
        "actor_id": r.try_get::<Option<String>, _>("actor_id").ok().flatten(),
        "created_at": r
            .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
            .map(|t| t.to_rfc3339())
            .unwrap_or_default(),
    })
}

const SELECT_COLS: &str = "SELECT id, msg_id, channel_id, bot_id, task_id, run_id, trace_seq, \
     stream, kind, phase, status, title, message, data, request_id, approval_kind, decision, \
     option_id, actor_id, created_at FROM message_traces";

/// All traces for one bot turn, oldest-first (the per-turn replay/display query).
pub async fn list_for_message(
    db: &PgPool,
    msg_id: &str,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let sql = format!("{SELECT_COLS} WHERE msg_id = $1 ORDER BY trace_seq ASC LIMIT $2");
    let rows = sqlx::query(&sql)
        .bind(msg_id)
        .bind(limit)
        .fetch_all(db)
        .await?;
    Ok(rows.into_iter().map(row_to_json).collect())
}

/// Channel-wide trace timeline (audit feed), newest-first; optional kind filter.
pub async fn list_for_channel(
    db: &PgPool,
    channel_id: &str,
    kind: Option<&str>,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = if let Some(k) = kind {
        let sql = format!(
            "{SELECT_COLS} WHERE channel_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT $3"
        );
        sqlx::query(&sql)
            .bind(channel_id)
            .bind(k)
            .bind(limit)
            .fetch_all(db)
            .await?
    } else {
        let sql = format!("{SELECT_COLS} WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2");
        sqlx::query(&sql)
            .bind(channel_id)
            .bind(limit)
            .fetch_all(db)
            .await?
    };
    Ok(rows.into_iter().map(row_to_json).collect())
}
