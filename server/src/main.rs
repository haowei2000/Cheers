//! AgentNexus backend entrypoint.
//!
//! Builds runtime dependencies (config, database pool, Redis, gateway registries),
//! initializes tracing, applies migrations, and starts the Axum server
//! that exposes REST and WebSocket routes.

use std::sync::Arc;

use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod api;
mod app_state;
mod config;
mod domain;
mod errors;
mod gateway;
mod infra;
mod resource;
mod router;

use app_state::AppState;
use config::Config;
use gateway::realtime::manager::ConnectionManager;
use gateway::stream::StreamRegistry;

/// Start the HTTP/WebSocket gateway service.
///
/// Runtime flow:
/// 1. Initialize tracing/logging.
/// 2. Load configuration from environment.
/// 3. Build database pool and run migrations.
/// 4. Connect to Redis and initialize gateway components.
/// 5. Compose shared application state.
/// 6. Build router and start Axum listener.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "server=debug,sqlx=warn,redis=warn".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Bootstrap in startup order: config -> db -> migrations -> redis -> gateway services.
    let config = Arc::new(Config::from_env());
    info!(port = config.port, "starting server");

    let db = infra::db::create_pool(&config.database_url).await?;
    info!("database pool ready");

    sqlx::migrate!("./migrations").run(&db).await?;
    info!("migrations applied");

    let redis_client = redis::Client::open(config.redis_url.as_str())?;
    let redis_publisher = redis::aio::ConnectionManager::new(redis_client.clone()).await?;
    info!("redis ready");

    let fanout = gateway::realtime::redis_fanout::RedisFanout::new(&config.redis_url).await?;

    let conn_manager = ConnectionManager::new_with_redis(fanout.clone(), db.clone());

    let bot_registry = gateway::redis_registry::RedisBotRegistry::new(
        redis_client.clone(),
        redis_publisher.clone(),
    ) as Arc<dyn gateway::registry::BotRegistry>;

    let bot_locator = gateway::redis_registry::RedisBotLocator::new(redis_publisher.clone())
        as Arc<dyn gateway::registry::BotLocator>;

    let stream_registry = StreamRegistry::new();

    let state = AppState {
        db,
        config: config.clone(),
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
