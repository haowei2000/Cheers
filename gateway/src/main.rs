use std::sync::Arc;

use axum::{Router, routing::get};
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
use realtime::{fanout::InProcessFanout, manager::ConnectionManager};
use acp_bridge::registry::InProcessBotLocator;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── 日志初始化 ─────────────────────────────────────────────────────────
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "gateway=debug,sqlx=warn".into()))
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

    // ── 进程内 fan-out 和 bot 定位器（本期单实例实现）──────────────────────
    let fanout = InProcessFanout::new();
    let conn_manager = ConnectionManager::new(fanout.clone(), db.clone());
    let bot_locator = InProcessBotLocator::new();

    // ── 全局共享状态 ───────────────────────────────────────────────────────
    let state = AppState {
        db,
        config: config.clone(),
        fanout,
        conn_manager,
        bot_locator,
    };

    // ── 路由组装 ──────────────────────────────────────────────────────────
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(transport::ws::browser::ws_handler))
        .with_state(state);

    // ── 启动服务器 ────────────────────────────────────────────────────────
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr, "listening");
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health() -> &'static str {
    "ok"
}
