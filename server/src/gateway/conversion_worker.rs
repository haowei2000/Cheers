//! Background worker: convert office documents into a PDF preview rendition via Gotenberg.
//!
//! Chat uploads store the original bytes in S3 as `status='uploaded'`. For office
//! documents (docx/xlsx/pptx/…) the browser can't render the original, so this worker
//! polls for freshly-uploaded office files, converts them to PDF through Gotenberg,
//! stores the PDF alongside the original, and records its S3 key in `preview_object_key`.
//! `GET /files/:id/preview` then serves that PDF.
//!
//! Readiness is signalled by `preview_object_key` (not a status change), so files stay
//! `uploaded` and never drop out of the channel file list while converting. Failures
//! bump `conversion_attempts`; after `MAX_ATTEMPTS` the file is left alone (still
//! downloadable) so a poison document can't hot-loop the worker.
//!
//! The worker is path-agnostic: it keys off content-type/extension, so office files
//! arriving via gateway upload, MCP `inbox_deliver`, or connector `realize` are all
//! picked up. Candidates are ordered `conversion_attempts ASC` so fresh files are never
//! starved behind ones that keep failing.

use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::Client as S3Client;
use sqlx::{PgPool, Row};

use crate::config::Config;
use crate::infra::{gotenberg, s3};

const MAX_ATTEMPTS: i32 = 3;
const BATCH: i64 = 5;

/// One poll: convert up to `BATCH` pending office files. Returns how many succeeded.
async fn convert_batch(
    db: &PgPool,
    s3client: &S3Client,
    http: &reqwest::Client,
    bucket: &str,
    gotenberg_url: &str,
) -> usize {
    let rows = match sqlx::query(
        r#"SELECT file_id, object_key, original_filename
           FROM file_records
           WHERE status = 'uploaded'
             AND preview_object_key IS NULL
             AND converted_at IS NULL
             AND conversion_attempts < $1
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (
                 content_type ILIKE '%officedocument%'
                 OR content_type ILIKE '%msword%'
                 OR content_type ILIKE '%ms-excel%'
                 OR content_type ILIKE '%ms-powerpoint%'
                 OR content_type ILIKE '%opendocument%'
                 OR lower(coalesce(original_filename, '')) ~ '\.(doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf)$'
             )
           ORDER BY conversion_attempts ASC, created_at ASC
           LIMIT $2"#,
    )
    .bind(MAX_ATTEMPTS)
    .bind(BATCH)
    .fetch_all(db)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "conversion worker: candidate query failed");
            return 0;
        }
    };

    let mut converted = 0usize;
    for row in &rows {
        let file_id: String = row.try_get("file_id").unwrap_or_default();
        let filename: String = row
            .try_get::<Option<String>, _>("original_filename")
            .ok()
            .flatten()
            .unwrap_or_else(|| format!("{file_id}.bin"));
        let object_key: Option<String> = row.try_get::<Option<String>, _>("object_key").ok().flatten();
        let Some(object_key) = object_key else {
            record_failure(db, &file_id, "missing object_key").await;
            continue;
        };

        match convert_one(db, s3client, http, bucket, gotenberg_url, &file_id, &object_key, &filename).await {
            Ok(()) => converted += 1,
            Err(e) => record_failure(db, &file_id, &e.to_string()).await,
        }
    }
    if converted > 0 {
        tracing::info!(count = converted, "conversion worker: generated PDF previews");
    }
    converted
}

/// Fetch the original from S3, convert to PDF, store the PDF, and record its key.
async fn convert_one(
    db: &PgPool,
    s3client: &S3Client,
    http: &reqwest::Client,
    bucket: &str,
    gotenberg_url: &str,
    file_id: &str,
    object_key: &str,
    filename: &str,
) -> anyhow::Result<()> {
    let src = s3::get_object(s3client, bucket, object_key).await?;
    let pdf = gotenberg::convert_to_pdf(http, gotenberg_url, filename, src).await?;
    let preview_key = format!("previews/{file_id}.pdf");
    s3::put_object(s3client, bucket, &preview_key, "application/pdf", pdf).await?;
    sqlx::query(
        "UPDATE file_records
         SET preview_object_key = $1, converted_at = NOW(), last_error = NULL
         WHERE file_id = $2",
    )
    .bind(&preview_key)
    .bind(file_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Record a conversion failure: bump the attempt counter and store the error so the
/// file is retried (until `MAX_ATTEMPTS`) and the UI can surface a "download instead".
async fn record_failure(db: &PgPool, file_id: &str, err: &str) {
    let truncated: String = err.chars().take(500).collect();
    if let Err(e) = sqlx::query(
        "UPDATE file_records
         SET conversion_attempts = conversion_attempts + 1, last_error = $1
         WHERE file_id = $2",
    )
    .bind(&truncated)
    .bind(file_id)
    .execute(db)
    .await
    {
        tracing::error!(error = %e, file_id, "conversion worker: failed to record failure");
    } else {
        tracing::warn!(file_id, error = %truncated, "conversion worker: PDF conversion failed");
    }
}

/// Start the background conversion worker: an initial pass at startup (converts
/// anything uploaded while the process was down), then every `interval_secs`.
/// `interval_secs == 0` runs only the startup pass.
pub fn spawn(
    db: PgPool,
    s3client: S3Client,
    config: Arc<Config>,
    gotenberg_url: String,
    interval_secs: u64,
) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let bucket = config.s3_bucket.clone();

    tokio::spawn(async move {
        convert_batch(&db, &s3client, &http, &bucket, &gotenberg_url).await;

        if interval_secs == 0 {
            return;
        }

        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs));
        tick.tick().await; // first tick is immediate — startup pass already ran.
        loop {
            tick.tick().await;
            convert_batch(&db, &s3client, &http, &bucket, &gotenberg_url).await;
        }
    });
}
