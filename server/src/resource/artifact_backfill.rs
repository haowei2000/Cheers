//! F3 expansion: enqueue historical revisions without changing provider reads.
//! Progress is the durable F2 job/object metadata, not a process-local checkpoint.
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::PgPool;

/// Bounded transaction. Missing/invalid snapshots remain visible in the report;
/// unavailable attachments are not retried as if their bytes still existed.
pub async fn enqueue_batch(db: &PgPool, limit: i64) -> anyhow::Result<u64> {
    anyhow::ensure!((1..=1000).contains(&limit), "batch size must be 1..=1000");
    let result = sqlx::query!(
        r#"
        INSERT INTO artifact_object_jobs(artifact_id,version)
        SELECT r.artifact_id,r.version FROM artifact_revisions r
        JOIN artifacts a USING(artifact_id)
        WHERE (r.object_key IS NULL OR r.object_bucket IS NULL OR r.sha256 IS NULL)
          AND r.verification_error IS DISTINCT FROM 'expired before copy'
          AND NOT EXISTS(SELECT 1 FROM artifact_object_jobs j
                         WHERE j.artifact_id=r.artifact_id AND j.version=r.version)
          AND (a.source_kind='text' OR (
            r.snapshot->>'object_key' IS NOT NULL
            AND r.snapshot->>'status' IN ('uploaded','converted')
            AND NOT COALESCE((r.snapshot->>'deleted')::boolean,FALSE)
            AND (r.snapshot->>'expires_at' IS NULL OR
                 (r.snapshot->>'expires_at')::timestamptz > NOW())))
        ORDER BY r.artifact_id,r.version LIMIT $1
        ON CONFLICT DO NOTHING
        "#,
        limit
    )
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

/// Metadata repair is separate from copying: legacy IDs exist even while S3 is
/// unavailable, and a pre-existing mirrored head does not need another upload.
pub async fn repair_heads(db: &PgPool) -> anyhow::Result<u64> {
    Ok(sqlx::query!(
        r#"
        WITH candidates AS (
          SELECT a.artifact_id FROM artifacts a
          JOIN artifact_revisions r ON r.artifact_id=a.artifact_id AND r.version=a.version
          WHERE a.legacy_id IS DISTINCT FROM a.source_id
             OR a.object_key IS DISTINCT FROM r.object_key
             OR a.object_bucket IS DISTINCT FROM r.object_bucket
             OR a.sha256 IS DISTINCT FROM r.sha256
          ORDER BY a.artifact_id LIMIT 500 FOR UPDATE OF a
        )
        UPDATE artifacts a SET legacy_id=a.source_id,
            object_key=r.object_key,object_bucket=r.object_bucket,sha256=r.sha256
        FROM artifact_revisions r,candidates c
        WHERE r.artifact_id=a.artifact_id AND r.version=a.version AND c.artifact_id=a.artifact_id
        "#
    )
    .execute(db)
    .await?
    .rows_affected())
}

#[derive(Debug, Serialize)]
pub struct ChannelReport {
    pub channel_id: String,
    pub revisions: i64,
    pub copied: i64,
    pub verified: i64,
    pub missing_objects: i64,
    pub verification_errors: i64,
    pub pending: i64,
    pub unavailable_attachments: i64,
    pub missing_legacy_ids: i64,
}

#[derive(Debug, Serialize)]
pub struct PathReport {
    pub channel_id: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ViewChange {
    pub channel_id: String,
    pub path: String,
    pub previous: String,
    pub current: Option<String>,
}

// Mirrors legacy built-in discovery for migration diagnostics only. Personal
// extension rules and browser-local bindings must still be checked by the library.
fn previous_builtin(path: &str, content: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    let data: serde_json::Value = if lower.ends_with(".json") {
        serde_json::from_str(content).ok()?
    } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        serde_yaml::from_str(content).ok()?
    } else {
        return super::artifact_views::view_for(path)
            .filter(|v| matches!(*v, "markdown" | "html" | "react"));
    };
    if cheers_interactive_core::validate_document(&data).is_ok_and(|surfaces| !surfaces.is_empty())
    {
        return Some("a2ui");
    }
    if data.get("canvas").and_then(serde_json::Value::as_i64) == Some(1)
        && data.get("nodes").is_some_and(serde_json::Value::is_array)
    {
        return Some("canvas");
    }
    if data.get("codemap").and_then(serde_json::Value::as_i64) == Some(1)
        && data
            .get("nodes")
            .is_some_and(|v| v.is_object() || v.is_array())
    {
        return Some("codemap");
    }
    if data
        .as_array()
        .is_some_and(|rows| !rows.is_empty() && rows.iter().all(serde_json::Value::is_object))
    {
        return Some("table");
    }
    if data.get("series").is_some() {
        return Some("chart");
    }
    None
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub generated_at: chrono::DateTime<chrono::Utc>,
    /// Counts use the last completed remote verification, not a fresh S3 scan.
    pub channels: Vec<ChannelReport>,
    pub empty_directories: Vec<PathReport>,
    /// Conservative candidates: exact old extension/personal bindings are client
    /// state. The F1 library diagnostic resolves these against installed renderers.
    pub view_review_candidates: Vec<PathReport>,
    pub builtin_view_changes: Vec<ViewChange>,
    pub ready_for_read_switch: bool,
}

pub async fn report(db: &PgPool) -> anyhow::Result<Report> {
    // A single read snapshot makes the counts and diagnostics mutually consistent.
    let mut tx = db.begin().await?;
    sqlx::query!("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let channels = sqlx::query_as!(ChannelReport, r#"
        SELECT a.channel_id,
          COUNT(*) AS "revisions!",
          COUNT(*) FILTER (WHERE r.object_key IS NOT NULL AND r.object_bucket IS NOT NULL AND r.sha256 IS NOT NULL) AS "copied!",
          COUNT(*) FILTER (WHERE r.object_key IS NOT NULL AND r.object_bucket IS NOT NULL AND r.sha256 IS NOT NULL AND r.verified_at IS NOT NULL AND r.verification_error IS NULL) AS "verified!",
          COUNT(*) FILTER (WHERE r.object_key IS NULL OR r.object_bucket IS NULL OR r.sha256 IS NULL) AS "missing_objects!",
          COUNT(*) FILTER (WHERE r.verification_error IS NOT NULL) AS "verification_errors!",
          COUNT(j.artifact_id) AS "pending!",
          COUNT(*) FILTER (WHERE a.source_kind='attachment' AND (
             r.snapshot IS NULL OR r.snapshot->>'object_key' IS NULL
             OR COALESCE(r.snapshot->>'status','') NOT IN ('uploaded','converted')
             OR COALESCE((r.snapshot->>'deleted')::boolean,FALSE)
             OR (r.snapshot->>'expires_at')::timestamptz <= NOW())) AS "unavailable_attachments!",
          COUNT(*) FILTER (WHERE a.legacy_id IS DISTINCT FROM a.source_id) AS "missing_legacy_ids!"
        FROM artifacts a JOIN artifact_revisions r USING(artifact_id)
        LEFT JOIN artifact_object_jobs j ON j.artifact_id=r.artifact_id AND j.version=r.version
        GROUP BY a.channel_id ORDER BY a.channel_id
        "#).fetch_all(&mut *tx).await?;
    let empty_directories = sqlx::query_as!(
        PathReport,
        r#"
        SELECT d.channel_id,d.path FROM context_files d
        WHERE d.is_dir AND NOT EXISTS(SELECT 1 FROM context_files f
          WHERE f.channel_id=d.channel_id AND NOT f.is_dir
            AND starts_with(f.path,d.path || '/'))
        ORDER BY d.channel_id,d.path
        "#
    )
    .fetch_all(&mut *tx)
    .await?;
    let view_review_candidates = sqlx::query_as!(
        PathReport,
        r#"
        SELECT channel_id,path FROM context_files
        WHERE NOT is_dir AND (LOWER(path) ~ '\.(json|yaml|yml)$')
        ORDER BY channel_id,path
        "#
    )
    .fetch_all(&mut *tx)
    .await?;
    let config_rows = sqlx::query!(
        "SELECT channel_id,content FROM context_files WHERE NOT is_dir AND path='.workbench.json'"
    )
    .fetch_all(&mut *tx)
    .await?;
    let configs: std::collections::HashMap<_, serde_json::Value> = config_rows
        .iter()
        .filter_map(|f| {
            serde_json::from_str(&f.content)
                .ok()
                .map(|v| (f.channel_id.as_str(), v))
        })
        .collect();
    let mut builtin_view_changes = Vec::new();
    // Stream content so a report does not hold all historical user bytes in RAM.
    let mut files = sqlx::query!("SELECT channel_id,path,content FROM context_files WHERE NOT is_dir ORDER BY channel_id,path")
        .fetch(&mut *tx);
    while let Some(file) = files.try_next().await? {
        let bound = configs.get(file.channel_id.as_str()).and_then(|config| {
            config
                .get("bindings")
                .and_then(|b| b.get(&file.path))
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    config
                        .get("views")
                        .and_then(serde_json::Value::as_array)
                        .and_then(|views| {
                            views.iter().find(|v| {
                                v.get("path").and_then(serde_json::Value::as_str)
                                    == Some(file.path.as_str())
                            })
                        })
                        .and_then(|view| view.get("renderer"))
                        .and_then(serde_json::Value::as_str)
                })
        });
        let previous = bound
            .and_then(|b| b.strip_prefix("builtin:"))
            .filter(|name| super::artifact_views::VIEWS.iter().any(|v| v.view == *name))
            .or_else(|| previous_builtin(&file.path, &file.content));
        if let Some(previous) = previous {
            let current = super::artifact_views::view_for(&file.path);
            if Some(previous) != current {
                builtin_view_changes.push(ViewChange {
                    channel_id: file.channel_id,
                    path: file.path,
                    previous: previous.into(),
                    current: current.map(str::to_owned),
                });
            }
        }
    }
    drop(files);
    tx.commit().await?;
    let ready_for_read_switch = channels.iter().all(|c| {
        c.missing_objects == 0
            && c.verification_errors == 0
            && c.pending == 0
            && c.missing_legacy_ids == 0
            && c.verified == c.revisions
            && c.unavailable_attachments == 0
    });
    Ok(Report {
        generated_at: chrono::Utc::now(),
        channels,
        empty_directories,
        view_review_candidates,
        builtin_view_changes,
        ready_for_read_switch,
    })
}

/// Opt-in, non-blocking startup scan. Restarts rescan only missing work; concurrent
/// instances are safe because the queue's primary key deduplicates their inserts.
pub fn spawn(db: PgPool) {
    if !std::env::var("ARTIFACT_OBJECT_BACKFILL").is_ok_and(|v| v == "true" || v == "1") {
        return;
    }
    tokio::spawn(async move {
        loop {
            let result = async {
                while repair_heads(&db).await? > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                while enqueue_batch(&db, 500).await? > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                anyhow::Ok(())
            }
            .await;
            match result {
                Ok(()) => {
                    tracing::info!("artifact historical revisions queued; run artifact-backfill report for verification status");
                    break;
                }
                Err(error) => tracing::warn!(%error, "artifact backfill scan failed; retrying"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}
