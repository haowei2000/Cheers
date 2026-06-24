use std::sync::OnceLock;

use aws_sdk_s3::Client;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{
    authorize_channel_read, authorize_channel_write, not_found, Principal, ResourceResult,
};

/// Largest chat-file content returned inline to the agent (matches the workspace cap).
/// Bigger files are truncated — the agent should download via `download_url` instead.
const TEXT_CAP: usize = 256 * 1024;

/// Largest file an agent may deliver inline (base64) via `inbox_deliver`. Bigger files should go
/// through the chunked upload path, not a single resource frame.
const MAX_DELIVER_BYTES: usize = 8 * 1024 * 1024;

/// Process-global S3 handle (client + default bucket), injected at startup by main.rs.
/// The resource dispatch only carries `db`, and threading S3 through it would force every
/// fs.* test to build an S3 client; a single-process gateway can share one handle here.
static S3: OnceLock<(Client, String)> = OnceLock::new();

pub fn init_s3(client: Client, bucket: String) {
    let _ = S3.set((client, bucket));
}

/// channel.files (Inbox `inbox_list`): the channel's uploaded chat files. Scoped by
/// `file_records.channel_id` (matching how uploads link + the REST list endpoint).
///
/// Status filter `('uploaded','converted')`: `uploaded` is the live state set by upload_file;
/// `converted` is the reserved terminal state for the doc→markdown pipeline (the `converted_at`
/// / `md_path` columns) — not wired yet, kept here so the filter doesn't need changing when it is.
pub async fn handle_list(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    let limit = params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50)
        .min(200);

    let rows = sqlx::query(
        "SELECT file_id, original_filename, content_type, size_bytes, status, created_at
         FROM file_records
         WHERE channel_id = $1 AND status IN ('uploaded', 'converted')
         ORDER BY created_at DESC
         LIMIT $2",
    )
    .bind(channel_id.to_string())
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let files: Vec<Value> = rows
        .iter()
        .map(|r| json!({
            "file_id": r.try_get::<String, _>("file_id").unwrap_or_default(),
            "filename": r.try_get::<Option<String>, _>("original_filename").unwrap_or(None),
            "content_type": r.try_get::<Option<String>, _>("content_type").unwrap_or(None),
            "size_bytes": r.try_get::<Option<i32>, _>("size_bytes").unwrap_or(None),
            "status": r.try_get::<Option<String>, _>("status").unwrap_or(None),
            "created_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").unwrap_or(None),
        }))
        .collect();

    Ok(json!({ "files": files, "total": files.len(), "next_cursor": null }))
}

/// Is this content a text-ish type the agent can read as a string?
fn is_text(content_type: Option<&str>, filename: Option<&str>) -> bool {
    if let Some(ct) = content_type {
        // Strip any "; charset=..." parameter before matching.
        let ct = ct.to_ascii_lowercase();
        let ct = ct.split(';').next().unwrap_or(&ct).trim();
        if ct.starts_with("text/") {
            return true;
        }
        // Structured-syntax suffixes (RFC 6839): application/vnd.foo+json, image/svg+xml, ...
        if ct.ends_with("+json") || ct.ends_with("+xml") {
            return true;
        }
        if matches!(
            ct,
            "application/json"
                | "application/xml"
                | "application/csv"
                | "application/x-ndjson"
                | "application/yaml"
                | "application/x-yaml"
                | "application/toml"
                | "application/javascript"
                | "application/x-sh"
        ) {
            return true;
        }
    }
    if let Some(f) = filename {
        let f = f.to_ascii_lowercase();
        return [
            ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".log", ".yaml", ".yml",
            ".toml", ".xml", ".html", ".css", ".js", ".ts", ".py", ".rs", ".sql",
        ]
        .iter()
        .any(|e| f.ends_with(e));
    }
    false
}

/// channel.files.read (Inbox `inbox_open`): read one chat file's content by file_id,
/// scoped to the channel. Text files return `content`; binaries (image/pdf/...) return a
/// `kind:"binary"` marker + summary + download_url — never raw bytes decoded as text.
pub async fn handle_read(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    let file_id = params
        .get("file_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "file_id required"))?;

    authorize_channel_read(db, principal, channel_id).await?;

    // Scope by channel_id: fixes the previously-always-404 (file_scope_links was never
    // populated) AND guards against reading a file from another channel by guessing file_id.
    // Gate on status + expiry exactly like the REST download path (api::files): a file the
    // product treats as expired/not-yet-uploaded must not be readable through the agent door
    // either, and the same gate keeps inbox_open consistent with inbox_list (handle_list).
    let row = sqlx::query(
        "SELECT original_filename, content_type, size_bytes, object_key, storage_bucket,
                status, summary_3lines
         FROM file_records
         WHERE file_id = $1 AND channel_id = $2
           AND status IN ('uploaded', 'converted')
           AND (expires_at IS NULL OR expires_at > NOW())",
    )
    .bind(file_id)
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?
    .ok_or_else(|| not_found("file"))?;

    let filename: Option<String> = row.try_get("original_filename").unwrap_or(None);
    let content_type: Option<String> = row.try_get("content_type").unwrap_or(None);
    let size_bytes: Option<i32> = row.try_get("size_bytes").unwrap_or(None);
    let object_key: Option<String> = row.try_get("object_key").unwrap_or(None);
    let storage_bucket: Option<String> = row.try_get("storage_bucket").unwrap_or(None);
    let summary: Option<String> = row.try_get("summary_3lines").unwrap_or(None);

    let meta = json!({
        "file_id": file_id,
        "filename": filename,
        "content_type": content_type,
        "size_bytes": size_bytes,
        "download_url": format!("/api/v1/files/{file_id}/download"),
    });
    let with = |extra: Value| -> ResourceResult {
        let mut m = meta.as_object().cloned().unwrap_or_default();
        if let Value::Object(e) = extra {
            m.extend(e);
        }
        Ok(Value::Object(m))
    };

    let Some(object_key) = object_key.filter(|k| !k.is_empty()) else {
        return with(json!({ "content": null, "kind": "pending", "truncated": false,
            "note": "file is not in storage yet (upload incomplete)" }));
    };

    // Distinct from "binary": this is an infrastructure failure, not a property of the file.
    // Returning kind:"binary" here would tell the agent to give up and download a text file.
    let Some((client, default_bucket)) = S3.get() else {
        return with(json!({ "content": null, "kind": "unavailable", "truncated": false,
            "note": "object storage temporarily unavailable; retry or use download_url" }));
    };

    if !is_text(content_type.as_deref(), filename.as_deref()) {
        return with(json!({ "content": null, "kind": "binary", "truncated": false, "summary": summary,
            "note": "binary file (image/pdf/docx/...); not readable as text — use download_url" }));
    }

    let bucket = storage_bucket.unwrap_or_else(|| default_bucket.clone());
    match crate::infra::s3::get_object(client, &bucket, &object_key).await {
        Ok(bytes) => {
            // Cut at TEXT_CAP, then back off to a UTF-8 char boundary so the last multibyte
            // character isn't split into a U+FFFD replacement char.
            let mut end = bytes.len().min(TEXT_CAP);
            while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
                end -= 1;
            }
            let truncated = end < bytes.len();
            let slice = &bytes[..end];
            let content = String::from_utf8_lossy(slice).into_owned();
            with(json!({ "content": content, "kind": "text",
                "truncated": truncated, "returned_bytes": slice.len() }))
        }
        Err(_) => Err(super::resource_error(
            "INTERNAL_ERROR",
            "failed to read file from storage",
        )),
    }
}

/// Reduce an agent-supplied filename to a single safe path segment (strip any directory parts),
/// so it cannot escape the `uploads/<file_id>/` object-key prefix.
fn safe_attachment_name(raw: &str) -> Result<String, (String, String)> {
    let name = raw.trim().rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || matches!(name, "." | "..") {
        return Err(super::resource_error("INVALID_PARAMS", "filename is required"));
    }
    Ok(name.to_string())
}

/// channel.files.create (Inbox `inbox_deliver`): store an agent-delivered file as a channel
/// attachment. Mirrors `api::files::upload_file`: decode the inline base64, `put_object` to S3
/// (via the `init_s3` handle), and INSERT a `file_records` row as `status='uploaded'` with a
/// 7-day TTL — so the delivered file behaves exactly like a human upload (listable via inbox_list,
/// readable via inbox_open, downloadable over REST).
pub async fn handle_create(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "channel_id required"))?;

    authorize_channel_write(db, principal, channel_id).await?;

    let filename = params
        .get("filename")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "filename required"))?;
    let filename = safe_attachment_name(filename)?;

    let data_b64 = params
        .get("data_b64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| super::resource_error("INVALID_PARAMS", "data_b64 required"))?;
    let bytes = STANDARD
        .decode(data_b64.trim())
        .map_err(|_| super::resource_error("INVALID_PARAMS", "data_b64 is not valid base64"))?;
    if bytes.is_empty() {
        return Err(super::resource_error("INVALID_PARAMS", "empty file"));
    }
    if bytes.len() > MAX_DELIVER_BYTES {
        return Err(super::resource_error(
            "E_TOO_LARGE",
            "file exceeds the 8MB inline delivery limit; use the chunked upload path",
        ));
    }
    let size_bytes = i32::try_from(bytes.len())
        .map_err(|_| super::resource_error("E_TOO_LARGE", "file too large"))?;

    let content_type = params
        .get("content_type")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();

    let Some((client, bucket)) = S3.get() else {
        return Err(super::resource_error(
            "E_STORAGE_UNAVAILABLE",
            "object storage unavailable; cannot store the file",
        ));
    };

    let file_id = Uuid::new_v4().to_string();
    let object_key = format!("uploads/{file_id}/{filename}");

    crate::infra::s3::put_object(client, bucket, &object_key, &content_type, bytes)
        .await
        .map_err(|_| super::resource_error("INTERNAL_ERROR", "failed to store file"))?;

    // channels.workspace_id is NOT NULL; carry it onto the record like upload_file does.
    let workspace_id: Option<String> = sqlx::query_scalar(
        "SELECT workspace_id FROM channels WHERE channel_id = $1",
    )
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(7 * 24 * 60 * 60);
    sqlx::query(
        "INSERT INTO file_records
            (file_id, channel_id, workspace_id, uploader_id, original_path, object_key,
             storage_bucket, original_filename, content_type, size_bytes, status,
             uploaded_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, 'uploaded', NOW(), $10)",
    )
    .bind(&file_id)
    .bind(channel_id.to_string())
    .bind(&workspace_id)
    .bind(principal.principal_id.to_string())
    .bind(&object_key)
    .bind(bucket)
    .bind(&filename)
    .bind(&content_type)
    .bind(size_bytes)
    .bind(expires_at)
    .execute(db)
    .await
    .map_err(|_| super::resource_error("INTERNAL_ERROR", "db error"))?;

    Ok(json!({
        "file_id": file_id,
        "filename": filename,
        "content_type": content_type,
        "size_bytes": size_bytes,
        "status": "uploaded",
        "download_url": format!("/api/v1/files/{file_id}/download"),
    }))
}

#[cfg(test)]
mod tests {
    use super::is_text;

    #[test]
    fn is_text_by_content_type() {
        assert!(is_text(Some("text/plain"), None));
        assert!(is_text(Some("text/markdown; charset=utf-8"), None)); // charset param stripped
        assert!(is_text(Some("application/json"), None));
        assert!(is_text(Some("application/vnd.api+json"), None)); // +json suffix
        assert!(is_text(Some("image/svg+xml"), None)); // +xml suffix
        assert!(is_text(Some("application/javascript"), None));
        assert!(!is_text(Some("image/png"), None));
        assert!(!is_text(Some("application/pdf"), None));
        assert!(!is_text(Some("application/octet-stream"), None));
    }

    #[test]
    fn is_text_by_filename_fallback() {
        assert!(is_text(None, Some("notes.md")));
        assert!(is_text(None, Some("DATA.CSV"))); // case-insensitive
        assert!(is_text(Some("application/octet-stream"), Some("config.yaml"))); // ext wins fallback
        assert!(!is_text(None, Some("photo.png")));
    }

    #[test]
    fn is_text_unknown_is_not_text() {
        // No content_type and no filename -> cannot claim text; default to binary marker.
        assert!(!is_text(None, None));
    }
}
