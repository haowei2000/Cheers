//! Operator-only command; uses DATABASE_URL and never exposes a public endpoint.
use server::resource::artifact_backfill;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(
        args.len() == 1 && matches!(args[0].as_str(), "enqueue" | "report"),
        "usage: artifact-backfill <enqueue|report> (DATABASE_URL required)"
    );
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
    let report = artifact_backfill::report(&db).await?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    db.close().await;
    if args[0] == "report" && !report.ready_for_read_switch {
        std::process::exit(2);
    }
    Ok(())
}
