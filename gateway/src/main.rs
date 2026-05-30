use std::sync::Arc;

use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod acp_bridge;
mod app_state;
mod config;
mod domain;
mod errors;
mod infra;
mod realtime;
mod transport;

use app_state::AppState;
use config::Config;
use realtime::manager::ConnectionManager;
use acp_bridge::stream::StreamRegistry;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── 日志初始化 ─────────────────────────────────────────────────────────
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "gateway=debug,sqlx=warn,redis=warn".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // ── 配置 ──────────────────────────────────────────────────────────────
    let config = Arc::new(Config::from_env());
    info!(port = config.port, "starting gateway");

    // ── 数据库连接池 ───────────────────────────────────────────────────────
    let db = infra::db::create_pool(&config.database_url).await?;
    info!("database pool ready");

    // ── 运行 sqlx 迁移 ────────────────────────────────────────────────────
    sqlx::migrate!("./migrations").run(&db).await?;
    info!("migrations applied");

    // ── Redis 连接 ────────────────────────────────────────────────────────
    let redis_client = redis::Client::open(config.redis_url.as_str())?;
    let redis_publisher = redis::aio::ConnectionManager::new(redis_client.clone()).await?;
    info!("redis ready");

    // ── Fan-out：RedisFanout（所有广播经 Redis，跨实例天然可用）──────────
    let fanout = realtime::redis_fanout::RedisFanout::new(&config.redis_url).await?;

    // ── ConnectionManager（复用 fanout 里的 InProcessFanout 做本地路由）──
    // RedisFanout 内部已有 local InProcessFanout；
    // ConnectionManager 需要一个 Arc<InProcessFanout> 来做 subscribe 注册。
    // 这里直接用 local 字段的 Arc。
    let conn_manager = ConnectionManager::new_with_redis(fanout.clone(), db.clone());

    // ── Bot Registry：RedisBotRegistry（bind/unbind via Redis pub/sub）──
    let bot_registry = acp_bridge::redis_registry::RedisBotRegistry::new(
        redis_client.clone(),
        redis_publisher.clone(),
    ) as Arc<dyn acp_bridge::registry::BotRegistry>;

    // ── Bot Locator：RedisBotLocator（dispatch via Redis PUBLISH）────────
    let bot_locator = acp_bridge::redis_registry::RedisBotLocator::new(redis_publisher.clone())
        as Arc<dyn acp_bridge::registry::BotLocator>;

    let stream_registry = StreamRegistry::new();

    // ── 全局共享状态 ───────────────────────────────────────────────────────
    let state = AppState {
        db,
        config: config.clone(),
        fanout,
        conn_manager,
        bot_locator,
        bot_registry,
        stream_registry,
    };

    // ── 路由组装 ──────────────────────────────────────────────────────────
    let app = transport::router::build(state);

    // ── 启动服务器 ────────────────────────────────────────────────────────
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr, "listening");
    axum::serve(listener, app).await?;

    Ok(())
}
