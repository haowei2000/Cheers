use axum::{extract::{Path, State}, Extension, Json};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{app_state::AppState, errors::AppError, transport::middleware::auth::Claims};

#[derive(Deserialize)]
pub struct PresignRequest {
    pub channel_id: String,
    pub filename: String,
    pub content_type: String,
    #[serde(default)]
    pub size_bytes: i64,
    pub size: Option<i64>,
}

fn safe_filename(raw: &str) -> Result<String, AppError> {
    let name = raw.trim().rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || matches!(name, "." | "..") {
        return Err(AppError::BadRequest("filename is required".into()));
    }
    Ok(name.to_string())
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
    let size_bytes = body.size.unwrap_or(body.size_bytes);
    let expires_at = Utc::now() + Duration::hours(24);
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
    .bind(size_bytes as i32)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    let upload_url = format!(
        "{}/{}/{}",
        state.config.s3_endpoint.trim_end_matches('/'),
        state.config.s3_bucket,
        object_key
    );
    Ok(Json(json!({
        "file_id": file_id,
        "upload_url": upload_url,
        "headers": {"Content-Type": body.content_type},
        "expires_in": 3600,
        "object_key": object_key,
    })))
}

pub async fn confirm_upload(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(file_id): Path<String>,
) -> Result<Json<Value>, AppError> {
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
        "file_id": row.try_get::<String, _>("file_id").unwrap_or(file_id),
        "original_filename": row.try_get::<String, _>("original_filename").ok(),
        "content_type": row.try_get::<String, _>("content_type").ok(),
        "size_bytes": row.try_get::<i32, _>("size_bytes").ok(),
        "status": row.try_get::<String, _>("status").unwrap_or_else(|_| "uploaded".into()),
        "preview_url": format!("/api/v1/files/{}/preview", row.try_get::<String, _>("file_id").unwrap_or_default()),
        "download_url": format!("/api/v1/files/{}/download", row.try_get::<String, _>("file_id").unwrap_or_default()),
    })))
}

pub async fn get_file_status(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
    Path(file_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = sqlx::query(
        "SELECT file_id, channel_id, original_filename, content_type, size_bytes, status,
                summary_3lines, last_error, uploaded_at, converted_at
         FROM file_records WHERE file_id = $1",
    )
    .bind(&file_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(json!({
        "file_id": row.try_get::<String, _>("file_id").unwrap_or(file_id),
        "channel_id": row.try_get::<String, _>("channel_id").ok(),
        "original_filename": row.try_get::<String, _>("original_filename").ok(),
        "content_type": row.try_get::<String, _>("content_type").ok(),
        "size_bytes": row.try_get::<i32, _>("size_bytes").ok(),
        "status": row.try_get::<String, _>("status").unwrap_or_else(|_| "pending".into()),
        "summary_3lines": row.try_get::<String, _>("summary_3lines").ok(),
        "last_error": row.try_get::<String, _>("last_error").ok(),
    })))
}
