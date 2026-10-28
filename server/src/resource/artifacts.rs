//! Channel artifact identity and discovery. Storage providers keep their existing
//! write/authorization contracts; the transactional catalog covers every producer.
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{authorize_channel_read, files, fs, Principal, ResourceResult};

#[derive(Serialize)]
struct Artifact {
    artifact_id: String,
    channel_id: String,
    source_kind: String,
    source_id: String,
    title: String,
    path: Option<String>,
    content_type: Option<String>,
    size_bytes: i64,
    version: i64,
    source_version: i64,
    source_status: String,
    internal: bool,
    created_by: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
}

impl Artifact {
    fn availability(&self) -> &'static str {
        if self.deleted_at.is_some() {
            "deleted"
        } else if self.expires_at.is_some_and(|at| at <= Utc::now()) {
            "expired"
        } else {
            match self.source_status.as_str() {
                "ready" | "uploaded" | "converted" => "ready",
                "failed" | "error" => "failed",
                "expired" => "expired",
                _ => "pending",
            }
        }
    }

    fn summary(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("artifact fields serialize");
        value["uri"] = json!(format!("cheers:artifact/{}", self.artifact_id));
        value["availability"] = json!(self.availability());
        value
    }
}

fn required_uuid(params: &Value, key: &str) -> Result<Uuid, (String, String)> {
    params
        .get(key)
        .and_then(Value::as_str)
        .and_then(|id| id.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", format!("{key} must be a UUID")))
}

async fn get(
    db: &PgPool,
    principal: &Principal,
    params: &Value,
) -> Result<Artifact, (String, String)> {
    let channel_id = required_uuid(params, "channel_id")?;
    let artifact_id = required_uuid(params, "artifact_id")?;
    authorize_channel_read(db, principal, channel_id).await?;
    sqlx::query_as!(
        Artifact,
        "SELECT artifact_id, channel_id, source_kind, source_id, title, path, content_type, size_bytes, version, source_version, source_status, internal, created_by, created_at, updated_at, expires_at, deleted_at FROM artifacts WHERE channel_id = $1 AND artifact_id = $2",
        channel_id.to_string(),
        artifact_id.to_string()
    )
    .fetch_optional(db)
    .await
    .map_err(super::db_err("artifacts.get"))?
    .ok_or_else(|| super::not_found("artifact"))
}

pub async fn handle_get(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    Ok(get(db, principal, params).await?.summary())
}

/// Legacy links resolve at one boundary; callers never infer identity from a name.
pub async fn handle_resolve(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    use cheers_mcp_server::locator::{parse, Locator};
    let channel_id = required_uuid(params, "channel_id")?;
    authorize_channel_read(db, principal, channel_id).await?;
    // Internal navigation may carry a literal path (including spaces or '#').
    // Do not manufacture a locator and reinterpret filename characters as syntax.
    if let Some(path) = params.get("path").and_then(Value::as_str) {
        if params.get("uri").is_some() {
            return Err(super::resource_error(
                "INVALID_PARAMS",
                "supply path or uri, not both",
            ));
        }
        let mut conn = db
            .acquire()
            .await
            .map_err(super::db_err("artifacts.resolve"))?;
        return for_path(&mut conn, channel_id, path).await;
    }
    let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
    let locator = parse(uri)
        .ok_or_else(|| super::resource_error("INVALID_LOCATOR", "invalid artifact reference"))?;
    if let Locator::Artifact { artifact_id, .. } = locator {
        return handle_get(
            db,
            principal,
            &json!({"channel_id":channel_id, "artifact_id":artifact_id}),
        )
        .await;
    }
    let mut conn = db
        .acquire()
        .await
        .map_err(super::db_err("artifacts.resolve"))?;
    match locator {
        Locator::Desk { path, .. } => for_path(&mut conn, channel_id, &path).await,
        Locator::Inbox { file_id } => {
            for_source(&mut conn, channel_id, "attachment", &file_id).await
        }
        _ => Err(super::resource_error(
            "INVALID_LOCATOR",
            "reference does not name a channel artifact",
        )),
    }
}

pub async fn handle_list(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id = required_uuid(params, "channel_id")?;
    authorize_channel_read(db, principal, channel_id).await?;
    let limit = match params.get("limit") {
        None => 50,
        Some(value) => value
            .as_i64()
            .ok_or_else(|| super::resource_error("INVALID_PARAMS", "limit must be an integer"))?,
    };
    if !(1..=200).contains(&limit) {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "limit must be between 1 and 200",
        ));
    }
    let before = if params.get("before").is_some_and(|v| !v.is_null()) {
        Some(required_uuid(params, "before")?.to_string())
    } else {
        None
    };
    // Validate the cursor in the same scope, including tombstones so deletion of
    // the last item on a page does not invalidate subsequent pages.
    if let Some(id) = &before {
        get(
            db,
            principal,
            &json!({"channel_id":channel_id, "artifact_id":id}),
        )
        .await?;
    }
    let include_internal = params
        .get("include_internal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut rows = sqlx::query_as!(Artifact,
        "SELECT a.artifact_id, a.channel_id, a.source_kind, a.source_id, a.title, a.path, a.content_type, a.size_bytes, a.version, a.source_version, a.source_status, a.internal, a.created_by, a.created_at, a.updated_at, a.expires_at, a.deleted_at FROM artifacts a WHERE a.channel_id = $1 AND a.deleted_at IS NULL
         AND ($2 OR NOT a.internal)
         AND ($3::text IS NULL OR (a.created_at, a.artifact_id) <
              (SELECT c.created_at, c.artifact_id FROM artifacts c WHERE c.channel_id = $1 AND c.artifact_id = $3))
         ORDER BY a.created_at DESC, a.artifact_id DESC LIMIT $4",
        channel_id.to_string(), include_internal, before, limit + 1
    ).fetch_all(db).await.map_err(super::db_err("artifacts.list"))?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if more {
        rows.last().map(|a| a.artifact_id.clone())
    } else {
        None
    };
    Ok(
        json!({"artifacts": rows.iter().map(Artifact::summary).collect::<Vec<_>>(), "next_cursor":next_cursor}),
    )
}

pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let artifact = get(db, principal, params).await?;
    if artifact.availability() != "ready" {
        return Err(super::resource_error(
            "ARTIFACT_UNAVAILABLE",
            format!("artifact is {}", artifact.availability()),
        ));
    }
    let mut content = if artifact.source_kind == "text" {
        // Read the captured revision, not the mutable path: rename/delete/recreate
        // cannot swap a different file into this stable identity between queries.
        let row = sqlx::query!(
            "SELECT snapshot FROM artifact_revisions WHERE artifact_id = $1 AND version = $2",
            artifact.artifact_id,
            artifact.version
        )
        .fetch_one(db)
        .await
        .map_err(super::db_err("artifacts.read revision"))?;
        let text = row
            .snapshot
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("");
        let service = crate::api::resources::service_id(db)
            .await
            .map_err(|e| super::resource_error("INTERNAL", e.to_string()))?;
        json!({"content":text, "data":fs::parse_structured(artifact.path.as_deref().unwrap_or(""), text),
               "uri":cheers_interactive_core::global_uri::format(&service,"desk",&artifact.source_id,None),
               "kind":"text", "truncated":false})
    } else {
        files::handle_read(db, principal, &json!({"channel_id":artifact.channel_id,
            "file_id":artifact.source_id, "as_base64":params.get("as_base64").and_then(Value::as_bool).unwrap_or(false)})).await?
    };
    content["artifact"] = artifact.summary();
    Ok(content)
}

pub async fn handle_create(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    if params.get("content").and_then(Value::as_str).is_none() {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "content is required",
        ));
    }
    let mut input = params.clone();
    input["if_version"] = json!(0);
    input["is_dir"] = json!(false);
    let key = super::idempotency::IdempotencyKey::from_params(
        principal,
        "channel.artifacts.create",
        params,
    )?;
    fs::write_with_idempotency(db, principal, &input, key).await
}

pub async fn handle_update(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    mutate(db, principal, params, false).await
}

pub async fn handle_patch(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    mutate(db, principal, params, true).await
}

async fn mutate(db: &PgPool, principal: &Principal, params: &Value, patch: bool) -> ResourceResult {
    let artifact = get(db, principal, params).await?;
    let expected = params
        .get("if_version")
        .and_then(Value::as_i64)
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "if_version is required"))?;
    if artifact.availability() != "ready" || artifact.source_kind != "text" {
        return Err(super::resource_error(
            "ARTIFACT_NOT_EDITABLE",
            "only available text artifacts can be edited",
        ));
    }
    if expected != artifact.version {
        return Err(super::resource_error(
            "VERSION_CONFLICT",
            format!("current artifact version is {}", artifact.version),
        ));
    }
    // The provider rechecks both source identity and version under its row lock.
    // A concurrent rename or delete/recreate must not redirect this ID-based edit.
    let mut input = json!({"channel_id":artifact.channel_id, "path":artifact.path,
        "if_version":artifact.source_version, "expected_file_id":artifact.source_id});
    if patch {
        input["ops"] = params.get("ops").cloned().unwrap_or(Value::Null);
        fs::handle_patch(db, principal, &input).await
    } else {
        input["content"] = json!(params
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| super::resource_error("INVALID_PARAMS", "content is required"))?);
        fs::handle_write(db, principal, &input).await
    }
}

pub(super) async fn for_path(
    db: &mut sqlx::PgConnection,
    channel_id: Uuid,
    path: &str,
) -> ResourceResult {
    let artifact = sqlx::query_as!(Artifact,
        "SELECT artifact_id, channel_id, source_kind, source_id, title, path, content_type, size_bytes, version, source_version, source_status, internal, created_by, created_at, updated_at, expires_at, deleted_at FROM artifacts WHERE channel_id = $1 AND source_kind = 'text' AND path = $2 AND deleted_at IS NULL",
        channel_id.to_string(), path
    ).fetch_optional(db).await.map_err(super::db_err("artifacts.path"))?
        .ok_or_else(|| super::not_found("artifact"))?;
    Ok(artifact.summary())
}

/// Resolve a producer's provider identity once, at the boundary. All callers
/// receive the canonical artifact instead of inventing a Desk/Inbox reference.
pub(super) async fn for_source(
    db: &mut sqlx::PgConnection,
    channel_id: Uuid,
    source_kind: &str,
    source_id: &str,
) -> ResourceResult {
    let artifact = sqlx::query_as!(
        Artifact,
        "SELECT artifact_id, channel_id, source_kind, source_id, title, path, content_type, size_bytes, version, source_version, source_status, internal, created_by, created_at, updated_at, expires_at, deleted_at FROM artifacts WHERE channel_id = $1 AND source_kind = $2 AND source_id = $3",
        channel_id.to_string(),
        source_kind,
        source_id
    )
    .fetch_optional(db)
    .await
    .map_err(super::db_err("artifacts.source"))?
    .ok_or_else(|| super::not_found("artifact"))?;
    Ok(artifact.summary())
}
