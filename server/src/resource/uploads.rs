//! Agent file uploads. `artifact_deliver` makes the model copy a file's bytes into a tool
//! argument, which can silently damage them. Here the model handles only metadata: it asks for
//! a ticket, its shell sends the raw bytes to `api::agent_uploads`, and it then publishes.
//!
//! The ticket only allows storing this one file; it never reads anything or publishes. Publishing
//! is a normal tool call, so it repeats every authorization check against the current identity
//! (docs/arch/MCP_AUTH_ISOLATION.md §1, §3.4).

use std::sync::OnceLock;

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{authorize_channel_write, files, Principal, PrincipalType, ResourceResult};
use crate::infra::crypto;

const TICKET_TTL_MINUTES: i64 = 15;
/// The width of the `filename` and `content_type` columns.
const MAX_NAME_BYTES: usize = 255;
/// Bounds the storage one bot can hold in uploads it never publishes.
const MAX_OPEN_UPLOADS_PER_BOT: i64 = 20;
/// Lets a `received` upload's last write settle before its object is removed.
const SWEEP_GRACE_MINUTES: i32 = 10;
/// How long a repeated publish keeps returning the original result.
const PUBLISHED_RETENTION_DAYS: i32 = 7;

struct Settings {
    url_base: String,
    max_bytes: i64,
}

static SETTINGS: OnceLock<Settings> = OnceLock::new();

pub fn init(url_base: String, max_bytes: i64) {
    let _ = SETTINGS.set(Settings {
        url_base,
        max_bytes,
    });
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, (String, String)> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", format!("{key} required")))
}

fn channel_param(params: &Value) -> Result<Uuid, (String, String)> {
    required_str(params, "channel_id")?
        .parse()
        .map_err(|_| super::resource_error("INVALID_PARAMS", "channel_id must be a uuid"))
}

fn sha256_param(params: &Value) -> Result<String, (String, String)> {
    let sha256 = required_str(params, "sha256")?.trim().to_ascii_lowercase();
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "sha256 must be 64 hex characters",
        ));
    }
    Ok(sha256)
}

/// channel.artifacts.upload_prepare: issue a ticket for one file.
pub async fn handle_prepare(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    if principal.principal_type != PrincipalType::Bot {
        return Err(super::resource_error(
            "FORBIDDEN",
            "only an agent can prepare a file upload",
        ));
    }
    let channel_id = channel_param(params)?;
    authorize_channel_write(db, principal, channel_id).await?;

    let filename = files::safe_attachment_name(required_str(params, "filename")?)?;
    if filename.len() > MAX_NAME_BYTES {
        return Err(super::resource_error(
            "INVALID_PARAMS",
            "filename must be at most 255 bytes",
        ));
    }
    let sha256 = sha256_param(params)?;
    let size_bytes = params
        .get("size_bytes")
        .and_then(Value::as_i64)
        .filter(|size| *size > 0)
        .ok_or_else(|| {
            super::resource_error("INVALID_PARAMS", "size_bytes must be a positive integer")
        })?;
    let content_type = params
        .get("content_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| value.len() <= MAX_NAME_BYTES)
        .unwrap_or("application/octet-stream");

    let (Some(settings), Some(_)) = (SETTINGS.get(), files::s3_handle()) else {
        return Err(super::resource_error(
            "E_STORAGE_UNAVAILABLE",
            "object storage unavailable; cannot store the file",
        ));
    };
    if size_bytes > settings.max_bytes {
        return Err(super::resource_error(
            "E_TOO_LARGE",
            format!("file exceeds the {} byte upload limit", settings.max_bytes),
        ));
    }
    let size_bytes = i32::try_from(size_bytes)
        .map_err(|_| super::resource_error("E_TOO_LARGE", "file too large"))?;

    let bot_id = principal.principal_id.to_string();
    let open = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM agent_file_uploads
           WHERE bot_id = $1 AND status <> 'published' AND expires_at > NOW()"#,
        &bot_id,
    )
    .fetch_one(db)
    .await
    .map_err(super::db_err("uploads.prepare: count open uploads"))?;
    if open >= MAX_OPEN_UPLOADS_PER_BOT {
        return Err(super::resource_error(
            "E_TOO_MANY_UPLOADS",
            "too many unfinished uploads; publish them or wait for them to expire",
        ));
    }

    let upload_id = Uuid::new_v4().to_string();
    let file_id = Uuid::new_v4().to_string();
    let object_key = format!("uploads/{file_id}/{filename}");
    let ticket = crypto::generate_auth_nonce();
    let expires_at = Utc::now() + Duration::minutes(TICKET_TTL_MINUTES);
    sqlx::query!(
        "INSERT INTO agent_file_uploads
            (upload_id, ticket_hash, channel_id, bot_id, on_behalf_of, execution_id, file_id,
             object_key, filename, content_type, size_bytes, sha256, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        &upload_id,
        crypto::sha256_hex(&ticket),
        channel_id.to_string(),
        &bot_id,
        principal.on_behalf_of.map(|user| user.to_string()),
        principal.task.map(|task| task.to_string()),
        &file_id,
        &object_key,
        &filename,
        content_type,
        size_bytes,
        &sha256,
        expires_at,
    )
    .execute(db)
    .await
    .map_err(super::db_err("uploads.prepare: insert upload"))?;

    let upload_url = format!("{}/{upload_id}", settings.url_base);
    Ok(json!({
        "upload_id": upload_id,
        "channel_id": channel_id,
        "upload_url": upload_url,
        "upload_token": ticket,
        "expires_at": expires_at.to_rfc3339(),
        "command": format!(
            "curl -sS -T <FILE> -H 'Authorization: Bearer {ticket}' '{upload_url}'"
        ),
        "next": "Run command with <FILE> replaced by the file's path. It prints {\"status\":\"received\"} on success. Then call artifact_upload_finish with this upload_id.",
    }))
}

/// channel.artifacts.upload_finish: publish a received upload as a channel artifact. A repeated
/// call returns the first result, so a lost response never publishes the file twice.
pub async fn handle_finish(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id = channel_param(params)?;
    authorize_channel_write(db, principal, channel_id).await?;
    let upload_id = required_str(params, "upload_id")?;

    let mut tx = db
        .begin()
        .await
        .map_err(super::db_err("uploads.finish: begin tx"))?;
    // The same bot acting for the same person: a file uploaded for one user's task must not be
    // published from another's, whose access may differ.
    let upload = sqlx::query!(
        r#"SELECT file_id, object_key, filename, content_type, size_bytes, status, result,
                  expires_at <= NOW() AS "expired!"
           FROM agent_file_uploads
           WHERE upload_id = $1 AND channel_id = $2 AND bot_id = $3
             AND on_behalf_of IS NOT DISTINCT FROM $4
           FOR UPDATE"#,
        upload_id,
        channel_id.to_string(),
        principal.principal_id.to_string(),
        principal.on_behalf_of.map(|user| user.to_string()),
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(super::db_err("uploads.finish: load upload"))?
    .ok_or_else(|| super::not_found("upload"))?;

    if upload.status == "published" {
        return upload.result.ok_or_else(|| {
            super::resource_error("INTERNAL_ERROR", "published upload has no result")
        });
    }
    if upload.expired {
        return Err(super::resource_error(
            "E_UPLOAD_EXPIRED",
            "this upload has expired",
        ));
    }
    if upload.status != "received" {
        return Err(super::resource_error(
            "E_UPLOAD_INCOMPLETE",
            "the file has not been uploaded yet",
        ));
    }
    let Some((_, bucket)) = files::s3_handle() else {
        return Err(super::resource_error(
            "E_STORAGE_UNAVAILABLE",
            "object storage unavailable; cannot store the file",
        ));
    };

    let data = files::record_delivered_file(
        &mut tx,
        principal,
        channel_id,
        files::DeliveredFile {
            file_id: &upload.file_id,
            object_key: &upload.object_key,
            bucket,
            filename: &upload.filename,
            content_type: &upload.content_type,
            size_bytes: upload.size_bytes,
        },
    )
    .await?;
    sqlx::query!(
        "UPDATE agent_file_uploads SET status = 'published', result = $2 WHERE upload_id = $1",
        upload_id,
        &data,
    )
    .execute(&mut *tx)
    .await
    .map_err(super::db_err("uploads.finish: mark published"))?;
    tx.commit()
        .await
        .map_err(super::db_err("uploads.finish: commit tx"))?;
    Ok(data)
}

/// Remove expired uploads and the objects nothing published. An object that can't be deleted
/// stays unreferenced in storage; the row goes anyway so the sweep can't stall on it.
pub async fn sweep_expired(db: &PgPool) -> Result<u64, sqlx::Error> {
    let removed = sqlx::query!(
        "DELETE FROM agent_file_uploads
         WHERE (status <> 'published' AND expires_at <= NOW() - make_interval(mins => $1))
            OR (status = 'published' AND created_at <= NOW() - make_interval(days => $2))
         RETURNING status, object_key",
        SWEEP_GRACE_MINUTES,
        PUBLISHED_RETENTION_DAYS,
    )
    .fetch_all(db)
    .await?;
    if let Some((client, bucket)) = files::s3_handle() {
        for upload in removed.iter().filter(|upload| upload.status != "published") {
            if let Err(error) =
                crate::infra::s3::delete_object(client, bucket, &upload.object_key).await
            {
                tracing::warn!(error = %error, "agent upload object cleanup failed");
            }
        }
    }
    Ok(removed.len() as u64)
}
