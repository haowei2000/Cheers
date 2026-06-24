//! Cheers backend entrypoint.
//!
//! Builds runtime dependencies (config, database pool, in-process gateway
//! registries), initializes tracing, applies migrations, and starts the Axum
//! server that exposes REST and WebSocket routes.

use std::sync::Arc;

use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use server::gateway::realtime::manager::ConnectionManager;
use server::gateway::stream::StreamRegistry;
use server::{gateway, infra, router, AppState, Config};

/// Start the HTTP/WebSocket gateway service.
///
/// Runtime flow:
/// 1. Initialize tracing/logging.
/// 2. Load configuration from environment.
/// 3. Build database pool and run migrations.
/// 4. Initialize in-process gateway components (fan-out + bot registry).
/// 5. Compose shared application state.
/// 6. Build router and start Axum listener.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=debug,sqlx=warn,redis=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Bootstrap in startup order: config -> db -> migrations -> gateway services.
    let config = Arc::new(Config::from_env());
    info!(port = config.port, "starting server");

    let db = infra::db::create_pool(&config.database_url).await?;
    info!("database pool ready");

    sqlx::migrate!("./migrations").run(&db).await?;
    info!("migrations applied");

    // Bootstrap a default admin on an empty database (there is no seed
    // migration), so the gateway is reachable for the login/demo flow.
    server::domain::seed::ensure_admin_user(&db).await?;

    // S3 / RustFS client for gateway-proxied file storage. Bucket bootstrap is
    // best-effort: a missing object store must not block the core chat loop.
    let s3 = infra::s3::build_client(&config);
    if let Err(e) = infra::s3::ensure_bucket(&s3, &config.s3_bucket).await {
        tracing::warn!(error = %e, bucket = %config.s3_bucket, "S3 bucket bootstrap failed; file upload/download will be unavailable until storage is reachable");
    }
    // Let the resource layer (channel.files.read / inbox_open) read chat-file bytes.
    server::resource::files::init_s3(s3.clone(), config.s3_bucket.clone());

    // Single-instance deployment (R1-A): in-process fan-out + bot registry.
    // Redis is NOT a startup dependency on the realtime path. The Redis impls
    // (redis_fanout.rs / redis_registry.rs) stay compiled for a future
    // multi-instance / HA switch but are intentionally not wired here.
    let fanout_inner = gateway::realtime::fanout::InProcessFanout::new();
    let conn_manager = ConnectionManager::new(fanout_inner.clone(), db.clone());
    let fanout = fanout_inner as Arc<dyn gateway::realtime::fanout::Fanout>;

    // One in-process locator serves both roles: bind_control/bind_data store the
    // bot sessions, dispatch_task/send_data read them. They MUST share a single
    // instance — the Redis path can split registry/locator because it coordinates
    // through Redis, but in-process the shared DashMap is the only coordination.
    let locator = gateway::registry::InProcessBotLocator::new();
    let bot_registry = locator.clone() as Arc<dyn gateway::registry::BotRegistry>;
    let bot_locator = locator as Arc<dyn gateway::registry::BotLocator>;

    let stream_registry = StreamRegistry::new();

    let state = AppState {
        db,
        config: config.clone(),
        s3,
        fanout,
        conn_manager,
        bot_locator,
        bot_registry,
        stream_registry,
    };

    let app = router::build(state);

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr, "listening");
    axum::serve(listener, app).await?;

    Ok(())
}
