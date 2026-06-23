use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::Response,
    Extension, Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{api::middleware::Claims, app_state::AppState, errors::AppError};

#[derive(Deserialize)]
pub struct PresignRequest {
    pub channel_id: String,
    pub filename: String,
    pub content_type: String,
    #[serde(default)]
    pub size_bytes: i64,
    pub size: Option<i64>,
    /// Seconds the upload URL should remain valid.
    /// It is clamped to the range of 60s~7days for safety.
    pub expires_in_seconds: Option<i64>,
}

#[derive(Clone)]
struct FileRecord {
    file_id: String,
    channel_id: Option<String>,
    workspace_id: Option<String>,
    uploader_id: Option<String>,
    object_key: Option<String>,
    original_filename: Option<String>,
    content_type: Option<String>,
    status: String,
    size_bytes: Option<i32>,
    summary_3lines: Option<String>,
    last_error: Option<String>,
    expires_at: Option<DateTime<Utc>>,
}

fn safe_filename(raw: &str) -> Result<String, AppError> {
    let name = raw.trim().rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || matches!(name, "." | "..") {
        return Err(AppError::BadRequest("filename is required".into()));
    }
    Ok(name.to_string())
}

fn sanitize_disposition_name(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !matches!(ch, '\\' | '"' | '\n' | '\r'))
        .collect()
}

fn resolve_expires_in(seconds: Option<i64>) -> i64 {
    const MIN_SECONDS: i64 = 60;
    const MAX_SECONDS: i64 = 7 * 24 * 60 * 60;

    let requested = seconds.unwrap_or(24 * 60 * 60);
    requested.clamp(MIN_SECONDS, MAX_SECONDS)
}

fn resolve_file_url(config: &crate::config::Config, object_key: &str) -> String {
    format!(
        "{}/{}/{}",
        config.s3_endpoint.trim_end_matches('/'),
        config.s3_bucket,
        object_key
    )
}

async fn load_file_record(state: &AppState, file_id: &str) -> Result<FileRecord, AppError> {
    let row = sqlx::query(
        "SELECT file_id, channel_id, workspace_id, uploader_id, object_key, original_filename,
                content_type, status, size_bytes, summary_3lines, last_error, expires_at
         FROM file_records
         WHERE file_id = $1",
    )
    .bind(file_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(FileRecord {
        file_id: row.try_get::<String, _>("file_id").unwrap_or_default(),
        channel_id: row
            .try_get::<Option<String>, _>("channel_id")
            .ok()
            .flatten(),
        workspace_id: row
            .try_get::<Option<String>, _>("workspace_id")
            .ok()
            .flatten(),
        uploader_id: row
            .try_get::<Option<String>, _>("uploader_id")
            .ok()
            .flatten(),
        object_key: row
            .try_get::<Option<String>, _>("object_key")
            .ok()
            .flatten(),
        original_filename: row
            .try_get::<Option<String>, _>("original_filename")
            .ok()
            .flatten(),
        content_type: row
            .try_get::<Option<String>, _>("content_type")
            .ok()
            .flatten(),
        status: row
            .try_get::<String, _>("status")
            .unwrap_or_else(|_| "pending_upload".to_string()),
        size_bytes: row.try_get::<Option<i32>, _>("size_bytes").ok().flatten(),
        summary_3lines: row
            .try_get::<Option<String>, _>("summary_3lines")
            .ok()
            .flatten(),
        last_error: row
            .try_get::<Option<String>, _>("last_error")
            .ok()
            .flatten(),
        expires_at: row
            .try_get::<Option<DateTime<Utc>>, _>("expires_at")
            .ok()
            .flatten(),
    })
}

async fn mark_file_expired(state: &AppState, file_id: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE file_records
         SET status = 'expired', last_error = 'expired'
         WHERE file_id = $1",
    )
    .bind(file_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn ensure_channel_member(
    state: &AppState,
    claims: &Claims,
    channel_id: &str,
) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(());
    }

    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1
            FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
         ) AS ok",
    )
    .bind(channel_id)
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if ok {
        Ok(())
    } else {
        Err(AppError::Forbidden("not a channel member".into()))
    }
}

async fn ensure_workspace_member(
    state: &AppState,
    claims: &Claims,
    workspace_id: &str,
) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(());
    }

    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1
            FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2
         ) AS ok",
    )
    .bind(workspace_id)
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);

    if ok {
        Ok(())
    } else {
        Err(AppError::Forbidden("not a workspace member".into()))
    }
}

async fn ensure_file_scope(
    state: &AppState,
    claims: &Claims,
    file: &FileRecord,
) -> Result<(), AppError> {
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(());
    }

    if let Some(channel_id) = file.channel_id.as_deref() {
        ensure_channel_member(state, claims, channel_id).await
    } else if let Some(workspace_id) = file.workspace_id.as_deref() {
        ensure_workspace_member(state, claims, workspace_id).await
    } else {
        Err(AppError::Forbidden("file has no accessible scope".into()))
    }
}

async fn ensure_file_for_access(
    state: &AppState,
    claims: &Claims,
    file_id: &str,
    require_uploaded: bool,
) -> Result<FileRecord, AppError> {
    let file = load_file_record(state, file_id).await?;

    if let Some(expires_at) = file.expires_at {
        if expires_at <= Utc::now() {
            mark_file_expired(state, file_id).await?;
            return Err(AppError::Forbidden("file has expired".into()));
        }
    }

    if require_uploaded && file.status != "uploaded" {
        return Err(AppError::BadRequest("file is not ready".into()));
    }

    ensure_file_scope(state, claims, &file).await?;
    Ok(file)
}

#[derive(Deserialize)]
pub struct UploadQuery {
    pub channel_id: String,
    pub filename: String,
    pub content_type: Option<String>,
}

/// POST /api/v1/files?channel_id=&filename=&content_type= — gateway-proxied
/// upload. The browser sends the raw file bytes as the request body; the gateway
/// streams them to object storage with SigV4 (no browser-side S3 signing/CORS)
/// and records the file as `uploaded` in one round trip.
pub async fn upload_file(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    let member = sqlx::query(
        "SELECT c.workspace_id
         FROM channels c
         JOIN channel_memberships cm ON cm.channel_id = c.channel_id
         WHERE c.channel_id = $1 AND cm.member_id = $2 AND cm.member_type = 'user'",
    )
    .bind(&q.channel_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Forbidden("not a channel member".into()))?;
    let workspace_id: Option<String> = member.try_get("workspace_id").ok();

    if body.is_empty() {
        return Err(AppError::BadRequest("empty file".into()));
    }
    let filename = safe_filename(&q.filename)?;
    let content_type = q
        .content_type
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let size_bytes =
        i32::try_from(body.len()).map_err(|_| AppError::BadRequest("file too large".into()))?;
    let file_id = Uuid::new_v4().to_string();
    let object_key = format!("uploads/{}/{}", file_id, filename);

    crate::infra::s3::put_object(
        &state.s3,
        &state.config.s3_bucket,
        &object_key,
        &content_type,
        body.to_vec(),
    )
    .await
    .map_err(|e| AppError::Internal(format!("upload failed: {e}")))?;

    let expires_at = Utc::now() + Duration::seconds(7 * 24 * 60 * 60);
    sqlx::query(
        "INSERT INTO file_records
            (file_id, channel_id, workspace_id, uploader_id, original_path, object_key,
             storage_bucket, original_filename, content_type, size_bytes, status,
             uploaded_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, 'uploaded', NOW(), $10)",
    )
    .bind(&file_id)
    .bind(&q.channel_id)
    .bind(&workspace_id)
    .bind(&claims.sub)
    .bind(&object_key)
    .bind(&state.config.s3_bucket)
    .bind(&filename)
    .bind(&content_type)
    .bind(size_bytes)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({
        "file_id": file_id,
        "original_filename": filename,
        "content_type": content_type,
        "size_bytes": size_bytes,
        "status": "uploaded",
        "preview_url": format!("/api/v1/files/{}/preview", file_id),
        "download_url": format!("/api/v1/files/{}/download", file_id),
    })))
}

fn attachment_response(
    bytes: Vec<u8>,
    filename: &str,
    content_type: Option<&str>,
    inline: bool,
    ttl_seconds: Option<i64>,
) -> Response {
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;

    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type.unwrap_or("application/octet-stream"))
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );

    let disposition = if inline { "inline" } else { "attachment" };
    let safe_name = sanitize_disposition_name(filename);
    let content_disposition = format!("{}; filename=\"{}\"", disposition, safe_name);
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(ttl) = ttl_seconds {
        if ttl > 0 {
            let value = format!("private, max-age={ttl}");
            if let Ok(hv) = HeaderValue::from_str(&value) {
                headers.insert(header::CACHE_CONTROL, hv);
            }
        }
    }

    response
}

fn ttl_left_seconds(expires_at: Option<DateTime<Utc>>) -> Option<i64> {
    expires_at.map(|expires_at| (expires_at - Utc::now()).num_seconds())
}

pub async fn request_presign(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<PresignRequest>,
) -> Result<Json<Value>, AppError> {
    let member = sqlx::query(
        "SELECT c.workspace_id
         FROM channels c
         JOIN channel_memberships cm ON cm.channel_id = c.channel_id
         WHERE c.channel_id = $1 AND cm.member_id = $2 AND cm.member_type = 'user'",
    )
    .bind(&body.channel_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Forbidden("not a channel member".into()))?;

    let filename = safe_filename(&body.filename)?;
    let file_id = Uuid::new_v4().to_string();
    let object_key = format!("uploads/{}/{}", file_id, filename);
    let requested_size = body.size.unwrap_or(body.size_bytes);
    let size_bytes = i32::try_from(requested_size)
        .map_err(|_| AppError::BadRequest("size_bytes is out of range".into()))?;
    let expires_in_seconds = resolve_expires_in(body.expires_in_seconds);
    let expires_at = Utc::now() + Duration::seconds(expires_in_seconds);

    sqlx::query(
        "INSERT INTO file_records
            (file_id, channel_id, workspace_id, uploader_id, original_path, object_key,
             storage_bucket, original_filename, content_type, size_bytes, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, 'pending_upload', $10)",
    )
    .bind(&file_id)
    .bind(&body.channel_id)
    .bind(member.try_get::<String, _>("workspace_id").ok())
    .bind(&claims.sub)
    .bind(&object_key)
    .bind(&state.config.s3_bucket)
    .bind(&filename)
    .bind(&body.content_type)
    .bind(size_bytes)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    let upload_url = resolve_file_url(&state.config, &object_key);

    Ok(Json(json!({
        "file_id": file_id,
        "upload_url": upload_url,
        "headers": { "Content-Type": body.content_type },
        "expires_in": expires_in_seconds,
        "object_key": object_key,
    })))
}

pub async fn confirm_upload(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(file_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let file = load_file_record(&state, &file_id).await?;

    if file.uploader_id.as_deref() != Some(claims.sub.as_str()) {
        return Err(AppError::Forbidden("uploader mismatch".into()));
    }

    if file.status != "pending_upload" {
        return Err(AppError::BadRequest(
            "file is not in pending_upload state".into(),
        ));
    }

    if let Some(expires_at) = file.expires_at {
        if expires_at <= Utc::now() {
            mark_file_expired(&state, &file_id).await?;
            return Err(AppError::Forbidden("file has expired".into()));
        }
    }

    let row = sqlx::query(
        "UPDATE file_records
         SET status = 'uploaded', uploaded_at = NOW()
         WHERE file_id = $1 AND uploader_id = $2
         RETURNING file_id, original_filename, content_type, size_bytes, status, expires_at",
    )
    .bind(&file_id)
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(json!({
        "file_id": row
            .try_get::<String, _>("file_id")
            .unwrap_or_else(|_| file_id.clone()),
        "original_filename": row.try_get::<String, _>("original_filename").ok(),
        "content_type": row.try_get::<String, _>("content_type").ok(),
        "size_bytes": row.try_get::<i32, _>("size_bytes").ok(),
        "status": row
            .try_get::<String, _>("status")
            .unwrap_or_else(|_| "uploaded".into()),
        "expires_at": row
            .try_get::<DateTime<Utc>, _>("expires_at")
            .ok()
            .map(|dt| dt.to_rfc3339()),
        "preview_url": format!("/api/v1/files/{}/preview", file_id),
        "download_url": format!("/api/v1/files/{}/download", file_id),
    })))
}

pub async fn get_file_status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(file_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let mut row = load_file_record(&state, &file_id).await?;
    ensure_file_scope(&state, &claims, &row).await?;

    if let Some(expires_at) = row.expires_at {
        if expires_at <= Utc::now() && row.status != "expired" {
            mark_file_expired(&state, &file_id).await?;
            row.status = "expired".into();
            row.last_error = Some("expired".to_string());
        }
    }

    Ok(Json(json!({
        "file_id": row.file_id,
        "channel_id": row.channel_id,
        "workspace_id": row.workspace_id,
        "original_filename": row.original_filename,
        "content_type": row.content_type,
        "size_bytes": row.size_bytes,
        "status": row.status,
        "summary_3lines": row.summary_3lines,
        "last_error": row.last_error,
        "expires_at": row.expires_at.map(|dt| dt.to_rfc3339()),
    })))
}

pub async fn preview_file(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(file_id): Path<String>,
) -> Result<Response, AppError> {
    let file = ensure_file_for_access(&state, &claims, &file_id, true).await?;
    let object_key = file.object_key.ok_or_else(|| AppError::NotFound)?;
    let bytes = crate::infra::s3::get_object(&state.s3, &state.config.s3_bucket, &object_key)
        .await
        .map_err(|_| AppError::NotFound)?;

    let ttl_seconds = ttl_left_seconds(file.expires_at);
    let filename = file.original_filename.unwrap_or_else(|| file_id.clone());

    Ok(attachment_response(
        bytes,
        &filename,
        file.content_type.as_deref(),
        true,
        ttl_seconds,
    ))
}

pub async fn download_file(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(file_id): Path<String>,
) -> Result<Response, AppError> {
    let file = ensure_file_for_access(&state, &claims, &file_id, true).await?;
    let object_key = file.object_key.ok_or_else(|| AppError::NotFound)?;
    let bytes = crate::infra::s3::get_object(&state.s3, &state.config.s3_bucket, &object_key)
        .await
        .map_err(|_| AppError::NotFound)?;

    let ttl_seconds = ttl_left_seconds(file.expires_at);
    let filename = file.original_filename.unwrap_or_else(|| file_id);

    Ok(attachment_response(
        bytes,
        &filename,
        file.content_type.as_deref(),
        false,
        ttl_seconds,
    ))
}
