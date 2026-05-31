use axum::{
    middleware,
    routing::{delete, get, patch, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

use crate::{
    api::{self, middleware::jwt_auth},
    app_state::AppState,
    gateway::ws,
};

pub fn build(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let authed = Router::new()
        .route("/api/v1/workspaces", get(api::workspaces::list_workspaces).post(api::workspaces::create_workspace))
        .route("/api/v1/workspaces/:workspace_id", patch(api::workspaces::update_workspace).delete(api::workspaces::delete_workspace))
        .route("/api/v1/workspaces/:workspace_id/invite", post(api::workspaces::invite_workspace_member))
        .route("/api/v1/workspaces/:workspace_id/members", get(api::workspaces::list_workspace_members).post(api::workspaces::add_workspace_member))
        .route("/api/v1/workspaces/:workspace_id/members/:user_id", delete(api::workspaces::remove_workspace_member))
        .route("/api/v1/channels", get(api::channels::list_channels).post(api::channels::create_channel))
        .route("/api/v1/channels/:channel_id", get(api::channels::get_channel).patch(api::channels::update_channel).delete(api::channels::delete_channel))
        .route("/api/v1/channels/:channel_id/members", get(api::channels::list_channel_members).post(api::channels::add_channel_member))
        .route("/api/v1/channels/:channel_id/members/:member_id", delete(api::channels::remove_channel_member))
        .route("/api/v1/channels/:channel_id/context", get(api::channels::get_channel_context).put(api::channels::put_channel_context))
        .route("/api/v1/channels/:channel_id/messages", post(api::messages::send_message).get(api::messages::list_messages))
        .route("/api/v1/bots", get(api::bots::list_bots).post(api::bots::create_bot))
        .route("/api/v1/bots/:bot_id/status", get(api::bots::get_bot_status))
        .route("/api/v1/bots/:bot_id/test", post(api::bots::test_bot))
        .route("/api/v1/files/presign", post(api::files::request_presign))
        .route("/api/v1/files/:file_id/confirm", post(api::files::confirm_upload))
        .route("/api/v1/files/:file_id/status", get(api::files::get_file_status))
        .route("/api/v1/friends", get(api::friends::list_friends).post(api::friends::add_friend).delete(api::friends::remove_friend))
        .route("/api/v1/friends/search", get(api::friends::search_users))
        .route("/api/v1/mcp/preview", post(api::mcp::preview_mcp_config))
        .route("/api/v1/mcp/parse-claude-config", post(api::mcp::parse_claude_config))
        .layer(middleware::from_fn_with_state(state.clone(), jwt_auth));

    let public = Router::new()
        .route("/health", get(health))
        .route("/api/v1/auth/login", post(api::auth::login));

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
