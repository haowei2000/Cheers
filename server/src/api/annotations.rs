//! Channel-scoped annotations for workspace files and agent trace operations.
use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    File {
        path: String,
        anchor: Value,
    },
    Event {
        msg_id: String,
        event_id: String,
        tool_call_id: Option<String>,
        snapshot: Value,
    },
}
#[derive(Debug, Deserialize)]
pub struct CreateAnnotation {
    pub target: Target,
    pub label: String,
    pub note: String,
}
#[derive(Debug, Deserialize)]
pub struct DeleteAnnotation {
    pub revision: i64,
}
#[derive(Debug, Deserialize)]
pub struct EditAnnotation {
    pub note: String,
    pub revision: i64,
}

fn validate_text(label: &str, note: &str) -> Result<(), AppError> {
    if label.trim().is_empty() || label.len() > 1024 || note.trim().is_empty() || note.len() > 16384
    {
        return Err(AppError::BadRequest(
            "annotation needs a label and a note (maximum 16 KB)".into(),
        ));
    }
    Ok(())
}
fn validate_target(target: &Target) -> Result<(), AppError> {
    match target {
        Target::File { path, anchor } => {
            if crate::resource::fs::normalize_path(path, false).as_deref() != Ok(path.as_str())
                || !anchor.is_object()
                || anchor.to_string().len() > 16384
            {
                return Err(AppError::BadRequest(
                    "invalid file annotation target".into(),
                ));
            }
            let valid = match anchor.get("kind").and_then(Value::as_str) {
                Some("file") => true,
                Some("uri") => anchor
                    .get("uri")
                    .and_then(Value::as_str)
                    .is_some_and(|s| matches!(cheers_mcp_server::locator::parse(s), Some(cheers_mcp_server::locator::Locator::Desk { path: ref target_path, .. }) if target_path == path)),
                Some("text") => anchor
                    .get("sourceText")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty()),
                Some("path") => anchor
                    .get("sourcePath")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.iter().all(|v| v.is_string() || v.as_u64().is_some())),
                _ => false,
            };
            if !valid {
                return Err(AppError::BadRequest(
                    "invalid file annotation anchor".into(),
                ));
            }
        }
        Target::Event {
            msg_id,
            event_id,
            tool_call_id,
            snapshot,
        } => {
            if Uuid::parse_str(msg_id).is_err()
                || event_id.is_empty()
                || event_id.len() > 512
                || tool_call_id
                    .as_ref()
                    .is_some_and(|id| id.is_empty() || id.len() > 512)
                || !snapshot.is_object()
                || snapshot.to_string().len() > 16384
            {
                return Err(AppError::BadRequest(
                    "invalid event annotation target".into(),
                ));
            }
        }
    }
    Ok(())
}
async fn member(
    state: &AppState,
    channel: &str,
    user: &str,
    write: bool,
) -> Result<bool, AppError> {
    let role: Option<String> = sqlx::query_scalar!(
        "SELECT role FROM channel_memberships WHERE channel_id=$1 AND member_id=$2 AND member_type='user'",
        channel,
        user,
    ).fetch_optional(&state.db).await?;
    let role = role.ok_or_else(|| AppError::Forbidden("not a channel member".into()))?;
    if write && !crate::resource::role_can_write(&role) {
        return Err(AppError::Forbidden("channel role is read-only".into()));
    }
    Ok(crate::resource::role_can_admin(&role))
}
struct AnnotationRow {
    id: String,
    channel_id: String,
    author_id: Option<String>,
    target: Value,
    label: String,
    note: String,
    revision: i64,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

fn dto(row: AnnotationRow) -> Value {
    json!({
        "id": row.id, "channel_id": row.channel_id,
        "author_id": row.author_id, "target": row.target,
        "label": row.label, "note": row.note, "revision": row.revision,
        "created_at": row.created_at, "updated_at": row.updated_at
    })
}

async fn visible(
    state: &AppState,
    channel: &str,
    claims: &Claims,
    items: Vec<Value>,
) -> Result<Vec<Value>, AppError> {
    let events = items.iter().enumerate().filter_map(|(index,item)| {
        let target=&item["target"];
        (target["kind"]=="event").then(|| json!({"id":index,"bot_id":target["snapshot"]["bot_id"],"kind":target["snapshot"]["kind"]}))
    }).collect();
    let allowed = crate::api::approval::filter_traces_by_see(
        state,
        channel.parse().map_err(|_| AppError::NotFound)?,
        claims
            .sub
            .parse()
            .map_err(|_| AppError::Unauthorized("invalid user id".into()))?,
        &claims.role,
        events,
    )
    .await;
    let indexes: std::collections::HashSet<usize> = allowed
        .iter()
        .filter_map(|e| e["id"].as_u64().map(|n| n as usize))
        .collect();
    Ok(items
        .into_iter()
        .enumerate()
        .filter_map(|(i, item)| {
            (item["target"]["kind"] != "event" || indexes.contains(&i)).then_some(item)
        })
        .collect())
}
async fn verify_target(
    state: &AppState,
    channel: &str,
    claims: &Claims,
    target: Target,
) -> Result<Target, AppError> {
    validate_target(&target)?;
    if let Target::Event {
        msg_id,
        event_id,
        tool_call_id,
        ..
    } = target
    {
        // Authoritative metadata and visibility come from a persisted source, never
        // from a client-supplied snapshot. Keep the snapshot if trace retention prunes it.
        let row = sqlx::query!(
            "SELECT t.id,t.data,t.title,t.phase,t.status,t.bot_id,t.kind,m.channel_seq AS \"channel_seq?\" FROM message_traces t LEFT JOIN messages m ON m.msg_id=t.msg_id AND m.channel_id=t.channel_id WHERE t.channel_id=$1 AND t.msg_id=$2 AND (t.id=$3 OR t.request_id=$3 OR t.data->>'event_id'=$3 OR t.data->>'toolCallId'=$3 OR t.data->>'tool_call_id'=$3 OR ($4::text IS NOT NULL AND (t.data->>'toolCallId'=$4 OR t.data->>'tool_call_id'=$4 OR t.data->'update'->>'toolCallId'=$4))) ORDER BY t.trace_seq LIMIT 1",
            channel,
            &msg_id,
            &event_id,
            tool_call_id.as_deref(),
        ).fetch_optional(&state.db).await?
            .ok_or_else(||AppError::BadRequest("event is not saved in this channel yet; try again after it completes".into()))?;
        let data: Option<Value> = row.data;
        let presentation = data
            .as_ref()
            .and_then(crate::domain::tool_presentation::classify);
        let snapshot = json!({"title":row.title,"phase":row.phase,"status":row.status,"bot_id":row.bot_id,"kind":row.kind,"channel_seq":row.channel_seq,"presentation":presentation.map(|p|json!({"event_type":p["event_type"],"path":p["path"],"command":p["command"],"query":p["query"]}))});
        let result = Target::Event {
            msg_id,
            event_id: row.id,
            tool_call_id,
            snapshot,
        };
        if visible(state, channel, claims, vec![json!({"target":result})])
            .await?
            .is_empty()
        {
            return Err(AppError::Forbidden("you cannot view this event".into()));
        }
        Ok(result)
    } else {
        Ok(target)
    }
}
async fn writable_note(
    state: &AppState,
    channel: &str,
    id: &str,
    claims: &Claims,
    admin: bool,
) -> Result<(), AppError> {
    let row = sqlx::query_as!(
        AnnotationRow,
        "SELECT id,channel_id,author_id,target,label,note,revision,created_at,updated_at FROM channel_annotations WHERE channel_id=$1 AND id=$2 AND deleted_at IS NULL",
        channel,
        id,
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let item = dto(row);
    if !admin && item["author_id"].as_str() != Some(claims.sub.as_str()) {
        return Err(AppError::Forbidden(
            "only the author or a channel administrator can change this annotation".into(),
        ));
    }
    if visible(state, channel, claims, vec![item])
        .await?
        .is_empty()
    {
        return Err(AppError::NotFound);
    }
    Ok(())
}
pub async fn list(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let channel = channel.to_string();
    member(&state, &channel, &claims.sub, false).await?;
    let import_warning = match import_legacy(&state, &channel).await {
        Ok(()) => None,
        Err(AppError::BadRequest(message)) => Some(message),
        Err(error) => return Err(error),
    };
    let rows = sqlx::query_as!(
        AnnotationRow,
        "SELECT id,channel_id,author_id,target,label,note,revision,created_at,updated_at FROM channel_annotations WHERE channel_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",
        &channel,
    ).fetch_all(&state.db).await?;
    let notes = visible(
        &state,
        &channel,
        &claims,
        rows.into_iter().map(dto).collect(),
    )
    .await?;
    Ok(Json(json!({"notes":notes,"import_warning":import_warning})))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel): Path<Uuid>,
    Json(body): Json<CreateAnnotation>,
) -> Result<Json<Value>, AppError> {
    let channel = channel.to_string();
    member(&state, &channel, &claims.sub, true).await?;
    validate_text(&body.label, &body.note)?;
    let target = verify_target(&state, &channel, &claims, body.target).await?;
    let row = sqlx::query_as!(
        AnnotationRow,
        "INSERT INTO channel_annotations(id,channel_id,author_id,target,label,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,channel_id,author_id,target,label,note,revision,created_at,updated_at",
        Uuid::new_v4().to_string(),
        channel,
        claims.sub,
        serde_json::to_value(target).map_err(|e| AppError::Internal(e.to_string()))?,
        body.label.trim(),
        body.note.trim(),
    ).fetch_one(&state.db).await?;
    Ok(Json(dto(row)))
}
pub async fn edit(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<EditAnnotation>,
) -> Result<Json<Value>, AppError> {
    let channel = channel.to_string();
    let admin = member(&state, &channel, &claims.sub, true).await?;
    writable_note(&state, &channel, &id.to_string(), &claims, admin).await?;
    validate_text("note", &body.note)?;
    let row = sqlx::query_as!(
        AnnotationRow,
        "UPDATE channel_annotations SET note=$3,revision=revision+1,updated_at=NOW() WHERE channel_id=$1 AND id=$2 AND deleted_at IS NULL AND revision=$4 AND (author_id=$5 OR $6) RETURNING id,channel_id,author_id,target,label,note,revision,created_at,updated_at",
        channel,
        id.to_string(),
        body.note.trim(),
        body.revision,
        claims.sub,
        admin,
    ).fetch_optional(&state.db).await?;
    Ok(Json(dto(row.ok_or_else(|| {
        AppError::Conflict("annotation changed or you cannot edit it; refresh and retry".into())
    })?)))
}
pub async fn remove(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<DeleteAnnotation>,
) -> Result<Json<Value>, AppError> {
    let channel = channel.to_string();
    let admin = member(&state, &channel, &claims.sub, true).await?;
    writable_note(&state, &channel, &id.to_string(), &claims, admin).await?;
    let result = sqlx::query!(
        "UPDATE channel_annotations SET deleted_at=NOW(),revision=revision+1 WHERE channel_id=$1 AND id=$2 AND deleted_at IS NULL AND revision=$3 AND (author_id=$4 OR $5)",
        channel,
        id.to_string(),
        body.revision,
        claims.sub,
        admin,
    ).execute(&state.db).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::Conflict(
            "annotation changed or you cannot delete it; refresh and retry".into(),
        ));
    }
    Ok(Json(json!({"deleted":true})))
}
/// Parse the old agent-readable document, retaining its anchors and timestamps.
/// Invalid entries are skipped exactly as in the old frontend parser; the original
/// document remains untouched so malformed entries can be repaired and re-imported.
fn legacy_entries(
    raw: &Value,
) -> Vec<(
    String,
    Target,
    String,
    String,
    Option<chrono::DateTime<chrono::Utc>>,
)> {
    let mut seen = std::collections::HashSet::new();
    raw.get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?;
            let path = entry.get("path")?.as_str()?;
            let note = entry.get("note")?.as_str()?;
            let label = entry
                .get("label")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(path);
            if id.is_empty()
                || id.len() > 512
                || !seen.insert(id.to_string())
                || validate_text(label, note).is_err()
            {
                return None;
            }
            let old = &entry["anchor"];
            let anchor = if let Some(uri) = old.get("uri").and_then(Value::as_str) {
                json!({"kind":"uri","uri":uri})
            } else if let Some(path) = old.get("path").and_then(Value::as_array) {
                json!({"kind":"path","sourcePath":path})
            } else if let Some(text) = old
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                json!({"kind":"text","sourceText":text})
            } else {
                json!({"kind":"file"})
            };
            let mut target = Target::File {
                path: path.into(),
                anchor,
            };
            if validate_target(&target).is_err() {
                target = Target::File {
                    path: path.into(),
                    anchor: json!({"kind":"file"}),
                };
            }
            if validate_target(&target).is_err() {
                return None;
            }
            let created = entry
                .get("created")
                .and_then(Value::as_str)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.with_timezone(&chrono::Utc));
            Some((id.into(), target, label.into(), note.trim().into(), created))
        })
        .collect()
}
async fn import_legacy(state: &AppState, channel: &str) -> Result<(), AppError> {
    let content: Option<String> = sqlx::query_scalar!(
        "SELECT content FROM context_files WHERE channel_id=$1 AND path='annotations.yaml' AND NOT is_dir",
        channel,
    ).fetch_optional(&state.db).await?;
    let Some(content) = content else {
        return Ok(());
    };
    let raw: Value = serde_yaml::from_str(&content).map_err(|_| {
        AppError::BadRequest(
            "Could not import annotations.yaml. Fix its YAML syntax in Workbench and retry.".into(),
        )
    })?;
    let entries = legacy_entries(&raw);
    if entries.is_empty() {
        return Ok(());
    }
    let mut tx = state.db.begin().await?;
    for (legacy_id, target, label, note, created) in entries {
        // Missing historical authors remain unknown. Deleted ids are tombstones.
        sqlx::query!(
            "INSERT INTO channel_annotations(id,channel_id,target,label,note,legacy_id,created_at) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,NOW())) ON CONFLICT(channel_id,legacy_id) DO NOTHING",
            Uuid::new_v4().to_string(),
            channel,
            serde_json::to_value(target).map_err(|e|AppError::Internal(e.to_string()))?,
            label,
            note,
            legacy_id,
            created,
        ).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_blank_and_oversized_notes() {
        assert!(validate_text("x", " ").is_err());
        assert!(validate_text("x", &"a".repeat(16385)).is_err());
    }
    #[test]
    fn legacy_import_preserves_anchors_dates_and_deduplicates() {
        let entries = legacy_entries(&json!({"notes":[
            {"id":"old-1","path":"docs/my spec.md","label":"Timeout","note":"Keep it","anchor":{"text":"30 seconds"},"created":"2025-01-02T03:04:05Z"},
            {"id":"old-1","path":"other.md","note":"Duplicate"},
            {"id":"invalid","path":"../secret","note":"Bad path"}
        ]}));
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].4.unwrap().to_rfc3339(),
            "2025-01-02T03:04:05+00:00"
        );
        assert!(
            matches!(&entries[0].1, Target::File { path, anchor } if path == "docs/my spec.md" && anchor["sourceText"] == "30 seconds")
        );
    }
    #[test]
    fn validates_typed_anchors() {
        assert!(validate_target(&Target::File {
            path: "x.rs".into(),
            anchor: json!({"kind":"path","sourcePath":["items",0]})
        })
        .is_ok());
        assert!(validate_target(&Target::File {
            path: "x.rs".into(),
            anchor: json!({"kind":"path","sourcePath":[true]})
        })
        .is_err());
        assert!(serde_json::from_value::<Target>(
            json!({"kind":"event","msg_id":"x","event_id":"e","path":"x"})
        )
        .is_err());
    }
}
