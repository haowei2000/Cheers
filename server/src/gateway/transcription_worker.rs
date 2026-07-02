//! Background worker: transcribe audio chat files via the admin-configured
//! OpenAI-compatible STT endpoint (system_settings key `stt`).
//!
//! Mirrors `conversion_worker` (office→PDF): poll `file_records` for freshly
//! uploaded audio, pull the bytes from S3, POST them to the STT service, store
//! the transcript at `transcripts/{file_id}.txt`, and record its S3 key in
//! `md_path` (audio→text is the audio analog of the doc→markdown pipeline those
//! reserved columns were made for). `summary_3lines` gets a short snippet for
//! lightweight display; `converted_at` marks completion.
//!
//! Settings are re-read from the DB every poll cycle, so admin changes (enable,
//! endpoint, key) take effect without a restart — the worker is spawned
//! unconditionally and simply idles while STT is unconfigured/disabled.
//!
//! Failures bump `conversion_attempts` (shared with the office worker — the two
//! select disjoint content types, so a file only ever belongs to one pipeline);
//! after `MAX_ATTEMPTS` the file is left alone so one poison clip can't hot-loop.

use std::sync::Arc;
use std::time::Duration;

use aws_sdk_s3::Client as S3Client;
use sqlx::{PgPool, Row};

use crate::config::Config;
use crate::domain::stt_settings::{self, SttSettings};
use crate::infra::{crypto, s3, stt};

const MAX_ATTEMPTS: i32 = 3;
/// Audio transcription is slow (minutes for long clips) — keep batches small so
/// one poll cycle can't occupy the worker for too long.
const BATCH: i64 = 3;
/// Snippet stored in `summary_3lines` for list/agent-line display.
const SUMMARY_CHARS: usize = 300;

/// One poll: transcribe up to `BATCH` pending audio files. Returns successes.
async fn transcribe_batch(
    db: &PgPool,
    s3client: &S3Client,
    http: &reqwest::Client,
    bucket: &str,
    master_key: &[u8; 32],
) -> usize {
    // Hot-reload: settings live in the DB and are read per cycle.
    let settings = match stt_settings::load(db, master_key).await {
        Ok(Some(s)) if s.enabled && !s.endpoint.is_empty() => s,
        Ok(_) => return 0, // unconfigured or disabled — idle quietly
        Err(e) => {
            tracing::error!(error = %e, "transcription worker: settings load failed");
            return 0;
        }
    };

    let rows = match sqlx::query(
        r#"SELECT file_id, object_key, original_filename
           FROM file_records
           WHERE status = 'uploaded'
             AND md_path IS NULL
             AND conversion_attempts < $1
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (
                 content_type ILIKE 'audio/%'
                 OR lower(coalesce(original_filename, '')) ~ '\.(mp3|wav|m4a|ogg|oga|opus|flac|weba|webm|aac)$'
             )
             AND coalesce(content_type, '') NOT ILIKE 'video/%'
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
            tracing::error!(error = %e, "transcription worker: candidate query failed");
            return 0;
        }
    };

    let mut transcribed = 0usize;
    for row in &rows {
        let file_id: String = row.try_get("file_id").unwrap_or_default();
        let filename: String = row
            .try_get::<Option<String>, _>("original_filename")
            .ok()
            .flatten()
            .unwrap_or_else(|| format!("{file_id}.bin"));
        let object_key: Option<String> = row
            .try_get::<Option<String>, _>("object_key")
            .ok()
            .flatten();
        let Some(object_key) = object_key else {
            record_failure(db, &file_id, "missing object_key").await;
            continue;
        };

        match transcribe_one(
            db, s3client, http, bucket, &settings, &file_id, &object_key, &filename,
        )
        .await
        {
            Ok(()) => transcribed += 1,
            Err(e) => record_failure(db, &file_id, &e.to_string()).await,
        }
    }
    if transcribed > 0 {
        tracing::info!(count = transcribed, "transcription worker: transcripts stored");
    }
    transcribed
}

/// Fetch the audio from S3, transcribe it, store the transcript, record its key.
#[allow(clippy::too_many_arguments)]
async fn transcribe_one(
    db: &PgPool,
    s3client: &S3Client,
    http: &reqwest::Client,
    bucket: &str,
    settings: &SttSettings,
    file_id: &str,
    object_key: &str,
    filename: &str,
) -> anyhow::Result<()> {
    let audio = s3::get_object(s3client, bucket, object_key).await?;
    let transcript = stt::transcribe(
        http,
        &settings.endpoint,
        settings.api_key.as_deref(),
        &settings.model,
        filename,
        audio,
    )
    .await?;

    let transcript_key = format!("transcripts/{file_id}.txt");
    s3::put_object(
        s3client,
        bucket,
        &transcript_key,
        "text/plain; charset=utf-8",
        transcript.clone().into_bytes(),
    )
    .await?;

    let summary = snippet(&transcript, SUMMARY_CHARS);
    sqlx::query(
        "UPDATE file_records
         SET md_path = $1, summary_3lines = $2, converted_at = NOW(), last_error = NULL
         WHERE file_id = $3",
    )
    .bind(&transcript_key)
    .bind(&summary)
    .bind(file_id)
    .execute(db)
    .await?;
    Ok(())
}

/// First `max_chars` of the transcript on a char boundary, single-spaced.
fn snippet(text: &str, max_chars: usize) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= max_chars {
        return joined;
    }
    let cut: String = joined.chars().take(max_chars).collect();
    format!("{cut}…")
}

/// Record a failure: bump the shared attempt counter and keep the error for the UI.
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
        tracing::error!(error = %e, file_id, "transcription worker: failed to record failure");
    } else {
        tracing::warn!(file_id, error = %truncated, "transcription worker: transcription failed");
    }
}

/// Start the background transcription worker: startup pass, then every
/// `interval_secs` (0 = startup pass only). Spawned unconditionally — whether
/// it does anything is decided per cycle by the admin-configured settings.
pub fn spawn(db: PgPool, s3client: S3Client, config: Arc<Config>, interval_secs: u64) {
    let http = stt::build_client();
    let bucket = config.s3_bucket.clone();
    let master_key = crypto::derive_master_key(
        config.secret_store_key.as_deref(),
        &config.jwt_private_key_pem,
    );

    tokio::spawn(async move {
        transcribe_batch(&db, &s3client, &http, &bucket, &master_key).await;

        if interval_secs == 0 {
            return;
        }

        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs));
        tick.tick().await; // first tick is immediate — startup pass already ran.
        loop {
            tick.tick().await;
            transcribe_batch(&db, &s3client, &http, &bucket, &master_key).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 摘要截断：不超限原样返回；超限按字符边界截断加省略号；空白折叠为单空格。
    #[test]
    fn snippet_truncates_on_char_boundary() {
        assert_eq!(snippet("short  text\nhere", 300), "short text here");
        let long = "字".repeat(400);
        let s = snippet(&long, 300);
        assert_eq!(s.chars().count(), 301); // 300 + …
        assert!(s.ends_with('…'));
    }
}
