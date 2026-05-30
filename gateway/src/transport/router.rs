use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

use crate::{
    app_state::AppState,
    transport::{
        middleware::auth::jwt_auth,
        rest,
        ws,
    },
};

pub fn build(state: AppState) -> Router {
    // ── CORS ──────────────────────────────────────────────────────────────
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // ── 需要 JWT 的路由 ────────────────────────────────────────────────────
    let authed = Router::new()
        .route(
            "/api/v1/channels/:channel_id/messages",
            post(rest::messages::send_message).get(rest::messages::list_messages),
        )
        .layer(middleware::from_fn_with_state(state.clone(), jwt_auth));

    // ── 公开路由 ──────────────────────────────────────────────────────────
    let public = Router::new()
        .route("/health", get(health))
        .route("/api/v1/auth/login", post(rest::auth::login));

    // ── WebSocket 路由（不走 JWT middleware，自带首帧 auth）────────────────
    let ws_routes = Router::new()
        .route("/ws", get(ws::browser::ws_handler))
        .route("/ws/acp-bridge/control", get(ws::acp_bridge::control_handler))
        .route("/ws/acp-bridge/data", get(ws::acp_bridge::data_handler));

    Router::new()
        .merge(public)
        .merge(authed)
        .merge(ws_routes)
        .layer(cors)
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}
