//! PUT /api/v1/agent-uploads/:upload_id: receive the raw bytes of a prepared agent upload
//! (see `resource::uploads`). The ticket is checked before the body is read, so a caller
//! without one can't make the gateway buffer anything.

use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{header, HeaderMap},
    Json,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::{app_state::AppState, errors::AppError, infra::crypto};

/// Each upload is held in memory while it is verified, so this bounds peak memory to
/// this many times the upload limit.
static UPLOAD_SLOTS: Semaphore = Semaphore::const_new(4);

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

pub async fn receive_upload(
    State(state): State<AppState>,
    Path(upload_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Value>, AppError> {
    let refused = || AppError::Unauthorized("invalid upload ticket".into());
    let ticket_hash = crypto::sha256_hex(bearer(&headers).ok_or_else(refused)?);
    let upload = sqlx::query!(
        r#"SELECT bot_id, channel_id, execution_id, object_key, content_type, size_bytes, sha256,
                  status, expires_at <= NOW() AS "expired!"
           FROM agent_file_uploads WHERE upload_id = $1 AND ticket_hash = $2"#,
        &upload_id,
        &ticket_hash,
    )
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(refused)?;

    // A retry after a lost response. Nothing is overwritten: the content was already verified.
    if matches!(upload.status.as_str(), "received" | "published") {
        return Ok(Json(
            json!({ "upload_id": upload_id, "status": "received" }),
        ));
    }
    if upload.expired {
        return Err(AppError::Forbidden("upload ticket has expired".into()));
    }
    if let Some(execution_id) = &upload.execution_id {
        let running = crate::api::mcp::execution_is_running(
            &state,
            &upload.bot_id,
            &upload.channel_id,
            execution_id,
        )
        .await?;
        if !running {
            return Err(AppError::Forbidden(
                "the task this upload belongs to has ended".into(),
            ));
        }
    }
    let _slot = UPLOAD_SLOTS
        .try_acquire()
        .map_err(|_| AppError::TooManyRequests {
            retry_after_secs: 5,
        })?;

    // A request dropped mid-body never resets its claim, so a stale one can be taken over.
    // Three minutes outlasts the router's 120-second request timeout.
    let claimed = sqlx::query!(
        "UPDATE agent_file_uploads SET status = 'receiving', receiving_since = NOW()
         WHERE upload_id = $1 AND (status = 'pending'
            OR (status = 'receiving' AND receiving_since <= NOW() - make_interval(mins => 3)))",
        &upload_id,
    )
    .execute(&state.db)
    .await?
    .rows_affected();
    if claimed == 0 {
        return Err(AppError::Conflict(
            "this file is already being uploaded".into(),
        ));
    }

    let stored = verify_and_store(
        &state,
        body,
        upload.size_bytes,
        &upload.sha256,
        &upload.object_key,
        &upload.content_type,
    )
    .await;
    let status = if stored.is_ok() {
        "received"
    } else {
        "pending"
    };
    sqlx::query!(
        "UPDATE agent_file_uploads SET status = $2, receiving_since = NULL
         WHERE upload_id = $1 AND status = 'receiving'",
        &upload_id,
        status,
    )
    .execute(&state.db)
    .await?;
    stored?;
    Ok(Json(
        json!({ "upload_id": upload_id, "status": "received" }),
    ))
}

/// Nothing reaches storage until the bytes are proven to be the prepared file.
async fn verify_and_store(
    state: &AppState,
    body: Body,
    size_bytes: i32,
    sha256: &str,
    object_key: &str,
    content_type: &str,
) -> Result<(), AppError> {
    let size = size_bytes as usize;
    let bytes = to_bytes(body, size).await.map_err(|_| {
        AppError::BadRequest(
            "the body could not be read, or is larger than the prepared size_bytes".into(),
        )
    })?;
    if bytes.len() != size {
        return Err(AppError::BadRequest(format!(
            "received {} bytes, but size_bytes was {size}",
            bytes.len()
        )));
    }
    if hex::encode(Sha256::digest(&bytes)) != sha256 {
        return Err(AppError::BadRequest(
            "the file does not match the prepared sha256".into(),
        ));
    }
    crate::infra::s3::put_object(
        &state.s3,
        &state.config.s3_bucket,
        object_key,
        content_type,
        bytes.to_vec(),
    )
    .await
    .map_err(|e| AppError::Internal(format!("upload failed: {e}")))
}
