use axum::{
    middleware,
    routing::{delete, get, patch, post},
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
        .route("/api/v1/workspaces", get(rest::workspaces::list_workspaces).post(rest::workspaces::create_workspace))
        .route("/api/v1/workspaces/:workspace_id", patch(rest::workspaces::update_workspace).delete(rest::workspaces::delete_workspace))
        .route("/api/v1/workspaces/:workspace_id/invite", post(rest::workspaces::invite_workspace_member))
        .route(
            "/api/v1/workspaces/:workspace_id/members",
            get(rest::workspaces::list_workspace_members).post(rest::workspaces::add_workspace_member),
        )
        .route("/api/v1/workspaces/:workspace_id/members/:user_id", delete(rest::workspaces::remove_workspace_member))
        .route("/api/v1/channels", get(rest::channels::list_channels).post(rest::channels::create_channel))
        .route("/api/v1/channels/:channel_id", get(rest::channels::get_channel).patch(rest::channels::update_channel).delete(rest::channels::delete_channel))
        .route(
            "/api/v1/channels/:channel_id/members",
            get(rest::channels::list_channel_members).post(rest::channels::add_channel_member),
        )
        .route("/api/v1/channels/:channel_id/members/:member_id", delete(rest::channels::remove_channel_member))
        .route("/api/v1/channels/:channel_id/context", get(rest::channels::get_channel_context).put(rest::channels::put_channel_context))
        .route(
            "/api/v1/channels/:channel_id/messages",
            post(rest::messages::send_message).get(rest::messages::list_messages),
        )
        .route("/api/v1/bots", get(rest::bots::list_bots).post(rest::bots::create_bot))
        .route("/api/v1/bots/:bot_id/status", get(rest::bots::get_bot_status))
        .route("/api/v1/bots/:bot_id/test", post(rest::bots::test_bot))
        .route("/api/v1/files/presign", post(rest::files::request_presign))
        .route("/api/v1/files/:file_id/confirm", post(rest::files::confirm_upload))
        .route("/api/v1/files/:file_id/status", get(rest::files::get_file_status))
        .route("/api/v1/friends", get(rest::friends::list_friends).post(rest::friends::add_friend).delete(rest::friends::remove_friend))
        .route("/api/v1/friends/search", get(rest::friends::search_users))
        .route("/api/v1/mcp/preview", post(rest::mcp::preview_mcp_config))
        .route("/api/v1/mcp/parse-claude-config", post(rest::mcp::parse_claude_config))
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
