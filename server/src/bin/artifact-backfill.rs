//! Operator-only command; uses DATABASE_URL and never exposes a public endpoint.
use anyhow::Context;
use server::resource::{artifact_backfill, artifact_store};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(
        args.len() == 1 && matches!(args[0].as_str(), "enqueue" | "copy" | "report"),
        "usage: artifact-backfill <enqueue|copy|report> (DATABASE_URL required)"
    );
    // Validate copy configuration before mutating anything. No gateway JWT keys
    // or service startup are needed for this one-shot operator job.
    let storage = if args[0] == "copy" {
        let required =
            |name| std::env::var(name).with_context(|| format!("{name} required for copy"));
        let client = server::infra::s3::build_client_with_credentials(
            &required("S3_ENDPOINT")?,
            &std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
            &required("S3_ACCESS_KEY")?,
            &required("S3_SECRET_KEY")?,
        );
        Some((client, required("S3_BUCKET")?))
    } else {
        None
    };
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    if args[0] == "enqueue" {
        while artifact_backfill::repair_heads(&db).await? > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let mut queued = 0;
        loop {
            let count = artifact_backfill::enqueue_batch(&db, 500).await?;
            queued += count;
            if count == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        eprintln!(
            "Queued {queued} historical revisions; the gateway mirror worker copies their objects."
        );
    }
    if let Some((client, bucket)) = storage {
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            server::infra::s3::ensure_bucket(&client, &bucket),
        )
        .await??;
        let mut attempted = 0;
        // Bound each invocation even if live writers keep adding new revisions.
        // Failed copies retain F2's backoff; never busy-wait on unavailable S3.
        while attempted < 500 && artifact_store::mirror_one(&db, &client, &bucket).await? {
            attempted += 1;
        }
        eprintln!("Attempted {attempted} queued revisions; run report to inspect pending or unavailable versions.");
    }
    let report = artifact_backfill::report(&db).await?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    db.close().await;
    if args[0] != "enqueue" && !report.ready_for_read_switch {
        std::process::exit(2);
    }
    Ok(())
}
