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

/// Public wire contract shared by durable REST reads and live `bot_trace`
/// frames. Additive changes keep this version; incompatible semantics require a
/// new version and a migration period in every client.
pub const TRACE_EVENT_VERSION: u8 = 1;

const TERMINAL_STATUSES: &[&str] = &[
    "completed",
    "approved",
    "denied",
    "failed",
    "cancelled",
    "refused",
    "truncated",
    "max_turn_requests",
];

pub fn is_terminal_status(status: Option<&str>) -> bool {
    status.is_some_and(|value| TERMINAL_STATUSES.contains(&value))
}

fn normalize_status(status: Option<String>) -> Option<String> {
    status.map(|value| {
        match value.as_str() {
            "running" | "started" => "in_progress",
            "complete" | "done" | "success" | "succeeded" => "completed",
            "error" => "failed",
            _ => value.as_str(),
        }
        .to_string()
    })
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn nested_string(value: &Value, parent: &str, keys: &[&str]) -> Option<String> {
    let object = value.get(parent)?;
    keys.iter().find_map(|key| string_at(object, key))
}

/// Normalize a trace object into the canonical v1 shape. Producers may still
/// send the historical `event_id`, camel-case tool id, or lifecycle metadata
/// nested under `data`; consumers always receive one explicit contract.
pub fn normalize_event_payload(mut value: Value) -> Value {
    let Some(object) = value.as_object_mut() else {
        return value;
    };

    let request_id = string_at(&Value::Object(object.clone()), "request_id")
        .or_else(|| nested_string(&Value::Object(object.clone()), "data", &["request_id"]));
    let tool_call_id = string_at(&Value::Object(object.clone()), "tool_call_id")
        .or_else(|| string_at(&Value::Object(object.clone()), "toolCallId"))
        .or_else(|| {
            nested_string(
                &Value::Object(object.clone()),
                "data",
                &["tool_call_id", "toolCallId"],
            )
        });
    let phase = string_at(&Value::Object(object.clone()), "phase").unwrap_or_default();
    let kind = string_at(&Value::Object(object.clone()), "kind").unwrap_or_else(|| {
        if phase == "approval" {
            "approval"
        } else {
            "trace"
        }
        .to_string()
    });
    let operation = request_id
        .as_ref()
        .map(|id| ("approval", id.clone()))
        .or_else(|| tool_call_id.as_ref().map(|id| ("tool", id.clone())));
    let producer_seq = object
        .get("producer_seq")
        .or_else(|| object.get("seq"))
        .cloned();
    let id = string_at(&Value::Object(object.clone()), "id")
        .or_else(|| string_at(&Value::Object(object.clone()), "event_id"))
        .or_else(|| {
            producer_seq.as_ref().map(|producer_seq| {
                let seed = json!({
                    "msg_id": object.get("msg_id"),
                    "run_id": object.get("run_id"),
                    "stream": object.get("stream"),
                    "producer_seq": producer_seq,
                    "phase": phase,
                })
                .to_string();
                Uuid::new_v5(&Uuid::NAMESPACE_OID, seed.as_bytes()).to_string()
            })
        })
        .or_else(|| operation.as_ref().map(|(_, id)| id.clone()))
        .unwrap_or_else(|| {
            let seed = json!({
                "msg_id": object.get("msg_id"),
                "run_id": object.get("run_id"),
                "stream": object.get("stream"),
                "phase": phase,
                "title": object.get("title"),
                "created_at": object.get("created_at"),
            })
            .to_string();
            Uuid::new_v5(&Uuid::NAMESPACE_OID, seed.as_bytes()).to_string()
        });
    let status = normalize_status(string_at(&Value::Object(object.clone()), "status"));

    object.insert("v".to_string(), json!(TRACE_EVENT_VERSION));
    object.insert("id".to_string(), json!(id.clone()));
    // Compatibility alias for released clients. New consumers use `id`.
    object.insert("event_id".to_string(), json!(id));
    object.insert("kind".to_string(), json!(kind));
    object.insert("phase".to_string(), json!(phase));
    object.insert("status".to_string(), json!(status.clone()));
    object.insert("request_id".to_string(), json!(request_id));
    object.insert("tool_call_id".to_string(), json!(tool_call_id));
    object.insert(
        "operation_kind".to_string(),
        json!(operation.as_ref().map(|(kind, _)| *kind)),
    );
    object.insert(
        "operation_id".to_string(),
        json!(operation.as_ref().map(|(_, id)| id)),
    );
    object.insert(
        "is_terminal".to_string(),
        json!(is_terminal_status(status.as_deref())),
    );
    if !object.contains_key("trace_seq") {
        object.insert("trace_seq".to_string(), Value::Null);
    }
    if !object.contains_key("producer_seq") {
        object.insert(
            "producer_seq".to_string(),
            producer_seq.unwrap_or(Value::Null),
        );
    }
    if !object.contains_key("created_at") {
        object.insert(
            "created_at".to_string(),
            json!(chrono::Utc::now().to_rfc3339()),
        );
    }
    for field in ["approval_kind", "decision", "option_id", "actor_id"] {
        if !object.contains_key(field) {
            let nested = nested_string(&Value::Object(object.clone()), "data", &[field]);
            object.insert(field.to_string(), json!(nested));
        }
    }
    if let Some(data) = object.get_mut("data") {
        if let Some(presentation) = crate::domain::tool_presentation::classify(data) {
            if let Some(data_object) = data.as_object_mut() {
                data_object.insert("presentation".to_string(), presentation);
            }
        }
    }
    value
}

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
    pub id: Option<String>,
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
    let event_id = ev.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut last_err: Option<sqlx::Error> = None;
    for _ in 0..SEQ_RETRY {
        let res = sqlx::query(
            "INSERT INTO message_traces
                (id, msg_id, channel_id, bot_id, task_id, run_id, trace_seq, stream,
                 kind, phase, status, title, message, data,
                 request_id, approval_kind, decision, option_id, actor_id)
             VALUES ($1, $2, $3, $4, $5, $6,
                 (SELECT COALESCE(MAX(trace_seq), 0) + 1 FROM message_traces WHERE msg_id = $2),
                 $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(&event_id)
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
    normalize_event_payload(json!({
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
    }))
}

#[cfg(test)]
#[allow(
    clippy::items_after_test_module,
    reason = "normalization contract tests stay beside row conversion; query helpers follow"
)]
mod contract_tests {
    use super::*;

    #[test]
    fn normalizes_live_tool_event_to_v1_contract() {
        let event = normalize_event_payload(json!({
            "event_id": "call-1",
            "msg_id": "message-1",
            "phase": "tool_call_update",
            "status": "completed",
            "data": {"tool_call_id": "call-1", "output": {"ok": true}}
        }));

        assert_eq!(event["v"], TRACE_EVENT_VERSION);
        assert_eq!(event["id"], "call-1");
        assert_eq!(event["kind"], "trace");
        assert_eq!(event["tool_call_id"], "call-1");
        assert_eq!(event["operation_kind"], "tool");
        assert_eq!(event["operation_id"], "call-1");
        assert_eq!(event["is_terminal"], true);
        assert!(event.get("trace_seq").is_some());
        assert!(event.get("created_at").is_some());
    }

    #[test]
    fn enriches_tool_data_with_shared_presentation() {
        let event = normalize_event_payload(json!({
            "msg_id": "message-1",
            "phase": "tool_call",
            "status": "in_progress",
            "data": {
                "tool_call_id": "call-1",
                "tool_name": "Bash",
                "input": {"command": "git status --short", "cwd": "/work"}
            }
        }));

        assert_eq!(event["data"]["presentation"]["family"], "git");
        assert_eq!(event["data"]["presentation"]["operation"], "status");
        assert_eq!(event["data"]["presentation"]["v"], 2);
        assert_eq!(event["data"]["presentation"]["event_type"], "git_status");
        assert_eq!(event["data"]["presentation"]["cwd"], "/work");
    }

    #[test]
    fn normalizes_nested_approval_metadata() {
        let event = normalize_event_payload(json!({
            "msg_id": "message-1",
            "phase": "approval",
            "status": "approved",
            "data": {
                "request_id": "request-1",
                "approval_kind": "resolved",
                "decision": "allow_once"
            }
        }));

        assert_eq!(event["kind"], "approval");
        assert_eq!(event["request_id"], "request-1");
        assert_eq!(event["operation_kind"], "approval");
        assert_eq!(event["operation_id"], "request-1");
        assert_eq!(event["approval_kind"], "resolved");
        assert_eq!(event["decision"], "allow_once");
        assert_eq!(event["is_terminal"], true);
    }

    #[test]
    fn normalizes_cross_agent_status_vocabulary() {
        let event = normalize_event_payload(json!({
            "msg_id": "message-1",
            "phase": "tool_call_update",
            "status": "done",
            "tool_call_id": "call-1"
        }));

        assert_eq!(event["status"], "completed");
        assert_eq!(event["is_terminal"], true);
    }

    #[test]
    fn mints_stable_id_for_non_operation_event() {
        let payload = json!({
            "msg_id": "message-1",
            "run_id": "run-1",
            "stream": "acp",
            "producer_seq": 7,
            "phase": "plan",
            "status": "completed"
        });

        let first = normalize_event_payload(payload.clone());
        let second = normalize_event_payload(payload);
        assert_eq!(first["id"], second["id"]);
        assert_eq!(first["event_id"], second["event_id"]);
    }

    #[test]
    fn lifecycle_rows_have_distinct_ids_and_shared_operation_id() {
        let opening = normalize_event_payload(json!({
            "msg_id": "message-1",
            "run_id": "run-1",
            "producer_seq": 1,
            "phase": "tool_call",
            "status": "in_progress",
            "data": {"tool_call_id": "call-1"}
        }));
        let terminal = normalize_event_payload(json!({
            "msg_id": "message-1",
            "run_id": "run-1",
            "producer_seq": 2,
            "phase": "tool_call_update",
            "status": "completed",
            "data": {"tool_call_id": "call-1"}
        }));

        assert_ne!(opening["id"], terminal["id"]);
        assert_eq!(opening["operation_id"], terminal["operation_id"]);
    }
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
