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
            // `cheers=info` covers the custom `cheers::*` targets (e.g. the
            // dev-mode email delivery that logs verification codes when Brevo
            // is unconfigured) — they sit outside the `server` module tree, so
            // without it the documented "grep the logs for the code" path is
            // silently filtered out.
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "server=debug,cheers=info,sqlx=warn,redis=warn".into()),
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

    // Seed the official workbench plugins (embedded in this binary). Version-gated
    // upserts: admin deletions stick within a release; see domain/workbench_official.rs.
    server::domain::workbench_official::seed(&db).await?;
    server::domain::workbench_official_templates::seed(&db).await?;

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
    let workspace_rpc = Arc::new(gateway::workspace_rpc::WorkspaceRpc::new());

    // Web Push (PWA notifications): disabled unless a VAPID key is configured.
    let web_push = infra::web_push::WebPushSender::from_config(&config).map(Arc::new);
    if web_push.is_none() {
        tracing::info!(
            "VAPID_PRIVATE_KEY unset — Web Push disabled (in-app WS notifications only)"
        );
    }

    // OS push — direct APNs (store app) or relay (self-hosted); optional.
    let push = server::notify::PushTransport::from_env().map(Arc::new);
    if push.is_none() {
        tracing::info!("push not configured (APNS_* or PUSH_RELAY_URL) — OS push disabled");
    }

    let webauthn = match server::domain::webauthn::WebauthnService::from_config(&config) {
        Ok(Some(service)) => {
            tracing::info!(rp_id = %service.rp_id(), "WebAuthn / Passkeys enabled");
            Some(Arc::new(service))
        }
        Ok(None) => {
            tracing::info!("WebAuthn not configured (WEBAUTHN_RP_ID / WEBAUTHN_RP_ORIGIN unset)");
            None
        }
        Err(e) => {
            tracing::error!(error = %e, "invalid WebAuthn configuration; Passkeys disabled");
            None
        }
    };

    let state = AppState {
        db,
        config: config.clone(),
        webauthn,
        s3,
        fanout,
        conn_manager,
        bot_locator,
        bot_registry,
        stream_registry,
        workspace_rpc,
        web_push,
        push,
    };

    // Orphan-placeholder reclaimer (flow 8 gap): finalize placeholders that
    // never got a `done` (backend restart lost the in-memory registry, or a bot
    // vanished mid-task) so chat bubbles don't hang on "thinking" forever.
    gateway::reclaimer::spawn(
        state.db.clone(),
        state.stream_registry.clone(),
        state.fanout.clone(),
        config.orphan_reclaim_interval_secs,
        config.orphan_reclaim_threshold_secs,
    );

    // Approval-card TTL sweeper: finalize permission cards that were never
    // resolved and whose connector died before its own timeout could cancel
    // them, so they don't hang pending forever (no other server-side expiry).
    gateway::approval_sweeper::spawn(
        state.db.clone(),
        state.fanout.clone(),
        config.approval_sweep_interval_secs,
        config.approval_card_ttl_secs,
    );

    // Reap spent/expired bot-onboarding enrollment codes (audit follow-up L2):
    // the per-owner/per-bot caps count only live codes, so terminal rows would
    // otherwise accumulate without bound. Hourly, keeping rows 1 day for audit.
    gateway::enrollment_reaper::spawn(state.db.clone(), 3600, 86_400);

    // Prune bot bridge connection history (bot_connection_events) — kept 30 days
    // for uptime inspection, then reaped hourly so a flapping connector can't
    // grow the table without bound.
    gateway::connection_event_reaper::spawn(state.db.clone(), 3600, 30 * 86_400);

    // Office→PDF preview conversion (Gotenberg). Only runs when GOTENBERG_URL is
    // configured; otherwise office files simply have no preview rendition.
    if let Some(gotenberg_url) = config.gotenberg_url.clone() {
        gateway::conversion_worker::spawn(
            state.db.clone(),
            state.s3.clone(),
            state.config.clone(),
            gotenberg_url,
            config.conversion_poll_interval_secs,
        );
        info!("gotenberg conversion worker started");
    } else {
        info!("GOTENBERG_URL unset; office→PDF preview conversion disabled");
    }

    // Audio→text transcription via the admin-configured STT endpoint. Always
    // spawned: whether it does anything is a runtime DB setting (admin UI),
    // re-read each poll cycle — enabling STT needs no restart.
    gateway::transcription_worker::spawn(
        state.db.clone(),
        state.s3.clone(),
        state.config.clone(),
        state.fanout.clone(),
        config.conversion_poll_interval_secs,
    );

    // Opt-in proactive task claiming. Policies default to `off`; PostgreSQL
    // persists rate limits and cursors so restarts never replay claimed ranges.
    // Feature-gated: TASK_CLAIMS_ENABLED=true to activate the scheduler. The
    // REST/resource endpoints stay mounted so clients can persist policy, but
    // without the scheduler no evaluations run behind the flag.
    if state.config.task_claims_enabled {
        gateway::task_claim_scheduler::spawn(state.clone());
    } else {
        tracing::info!("task-claim scheduler disabled (TASK_CLAIMS_ENABLED != true)");
    }

    // Claim-expiry sweeper: pending/executing claims with `expires_at <= NOW()`
    // transition to `failed` so a stale claim never blocks a channel forever.
    let sweep_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            match server::api::task_claims::sweep_expired_claims(&sweep_state.db).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(expired = n, "task-claim expiry sweep"),
                Err(e) => tracing::warn!(err = %e, "task-claim expiry sweep failed"),
            }
        }
    });

    // Scheduled bot self-status refresh (audit item 6). The connector was
    // historically meant to run this loop but ships no implementation, so the
    // gateway owns it. Best-effort; never panics (per-tick/per-bot errors logged).
    tokio::spawn(server::domain::bot_status_scheduler::run(state.clone()));

    let app = router::build(state);

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr, "listening");
    // ConnectInfo gives handlers the peer socket address — the rate limiter keys
    // on it unless TRUST_PROXY_HEADERS explicitly opts into proxy headers.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}
