//! HTTP and WebSocket route construction for the Axum application.
//!
//! The router is intentionally split into three groups:
//! - `public`: endpoints available before authentication (health/login).
//! - `authed`: endpoints requiring JWT middleware.
//! - `ws_routes`: WebSocket upgrade and Agent Bridge endpoints.

use axum::{
    http::HeaderValue,
    middleware,
    routing::{delete, get, patch, post, put},
    Router,
};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::{
    api::{self, middleware::jwt_auth},
    app_state::AppState,
    gateway::ws,
};

pub fn build(state: AppState) -> Router {
    let cors = build_cors(&state);

    // Keep CORS policy explicit at the top-level router so every grouped route
    // shares a consistent browser/API access policy.
    Router::new()
        .merge(build_public_routes())
        .merge(build_authed_routes(state.clone()))
        .merge(build_ws_routes())
        .layer(cors)
        .with_state(state)
}

fn build_cors(state: &AppState) -> CorsLayer {
    let mut cors = CorsLayer::new().allow_methods(Any).allow_headers(Any);

    let configured = state
        .config
        .cors_allowed_origins
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| HeaderValue::from_str(s).ok())
        .collect::<Vec<_>>();

    if configured.is_empty() {
        cors.allow_origin(Any)
    } else {
        cors.allow_origin(AllowOrigin::list(configured))
    }
}

fn build_authed_routes(state: AppState) -> Router<AppState> {
    // Routes under this branch all require JWT authentication.
    Router::new()
        // Server-level workbench plugin store (install = admin; list/bundle = any member).
        .route(
            "/api/v1/workbench/plugins",
            get(api::workbench::list_plugins),
        )
        .route(
            "/api/v1/workbench/plugins/:plugin_id",
            put(api::workbench::install_plugin).delete(api::workbench::delete_plugin),
        )
        .route(
            "/api/v1/workbench/plugins/:plugin_id/bundle",
            get(api::workbench::get_bundle),
        )
        // Global workbench templates (DATA; install/delete = admin, list = any member).
        .route(
            "/api/v1/workbench/templates",
            get(api::workbench::list_templates),
        )
        .route(
            "/api/v1/workbench/templates/:tpl_id",
            put(api::workbench::put_template).delete(api::workbench::delete_template),
        )
        .route(
            "/api/v1/workspaces",
            get(api::workspaces::list_workspaces).post(api::workspaces::create_workspace),
        )
        // static segment → matches before :workspace_id
        .route(
            "/api/v1/workspaces/personal",
            get(api::workspaces::get_personal_workspace),
        )
        .route(
            "/api/v1/workspaces/:workspace_id",
            patch(api::workspaces::update_workspace).delete(api::workspaces::delete_workspace),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/invite",
            post(api::workspaces::invite_workspace_member),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/members",
            get(api::workspaces::list_workspace_members)
                .post(api::workspaces::add_workspace_member),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/members/:user_id",
            delete(api::workspaces::remove_workspace_member),
        )
        .route(
            "/api/v1/channels",
            get(api::channels::list_channels).post(api::channels::create_channel),
        )
        // DM: a type='dm' channel. Static segment → matches before :channel_id.
        .route(
            "/api/v1/channels/dm",
            get(api::channels::list_dms).post(api::channels::create_dm),
        )
        .route(
            "/api/v1/channels/:channel_id",
            get(api::channels::get_channel)
                .patch(api::channels::update_channel)
                .delete(api::channels::delete_channel),
        )
        .route(
            "/api/v1/channels/:channel_id/members",
            get(api::channels::list_channel_members).post(api::channels::add_channel_member),
        )
        .route(
            "/api/v1/channels/:channel_id/members/:member_id",
            delete(api::channels::remove_channel_member),
        )
        .route(
            "/api/v1/channels/:channel_id/messages",
            post(api::messages::send_message).get(api::messages::list_messages),
        )
        .route(
            "/api/v1/channels/:channel_id/messages/:msg_id/cancel",
            post(api::messages::cancel_message),
        )
        // ── ACP per-operation approval (docs/arch/ACP_APPROVAL_FLOW.md) ──────
        .route(
            "/api/v1/channels/:channel_id/permissions/:request_id/resolve",
            post(api::approval::resolve_permission),
        )
        .route(
            "/api/v1/channels/:channel_id/permissions/:request_id/request-access",
            post(api::approval::request_access),
        )
        .route(
            "/api/v1/channels/:channel_id/permissions/audit",
            get(api::approval::list_audit),
        )
        .route(
            "/api/v1/bots/:bot_id/approvers",
            get(api::approval::list_approvers).post(api::approval::grant_approver),
        )
        .route(
            "/api/v1/bots/:bot_id/approvers/:user_id",
            delete(api::approval::revoke_approver),
        )
        .route(
            "/api/v1/bots",
            get(api::bots::list_bots).post(api::bots::create_bot),
        )
        .route(
            "/api/v1/bots/:bot_id/status",
            get(api::bots::get_bot_status),
        )
        .route("/api/v1/bots/:bot_id/test", post(api::bots::test_bot))
        .route("/api/v1/bots/:bot_id/token", post(api::bots::issue_bot_token))
        .route(
            "/api/v1/bots/:bot_id/capability-delegations",
            get(api::acp_capability::list_delegations).post(api::acp_capability::create_delegation),
        )
        .route(
            "/api/v1/bots/:bot_id/capability-reject-logs",
            get(api::acp_capability::list_reject_logs),
        )
        .route(
            "/api/v1/ops/capability-reject-logs",
            get(api::acp_capability::list_reject_logs_admin),
        )
        .route(
            "/api/v1/bots/:bot_id/capability-delegations/:delegation_id",
            delete(api::acp_capability::revoke_delegation),
        )
        .route(
            "/api/v1/channels/:channel_id/files",
            get(api::files::list_channel_files),
        )
        .route("/api/v1/files", post(api::files::upload_file))
        .route("/api/v1/files/presign", post(api::files::request_presign))
        .route(
            "/api/v1/files/:file_id/confirm",
            post(api::files::confirm_upload),
        )
        .route(
            "/api/v1/files/:file_id/status",
            get(api::files::get_file_status),
        )
        .route(
            "/api/v1/files/:file_id/preview",
            get(api::files::preview_file),
        )
        .route(
            "/api/v1/files/:file_id/download",
            get(api::files::download_file),
        )
        .route(
            "/api/v1/files/:file_id/realize",
            post(api::files::realize_file),
        )
        // ── 远程工作区浏览（按 bot_id 路由到对应连接器机器）──────────────────
        .route(
            "/api/v1/channels/:channel_id/workspace/bots",
            get(api::workspace::list_workspace_bots),
        )
        .route(
            "/api/v1/channels/:channel_id/workspace/tree",
            get(api::workspace::get_tree),
        )
        .route(
            "/api/v1/channels/:channel_id/workspace/file",
            get(api::workspace::get_file).put(api::workspace::put_file),
        )
        // 出处解析:把回复里点击的文件引用解析到正确的 store(inbox/desk/workspace)
        .route(
            "/api/v1/channels/:channel_id/resolve-ref",
            post(api::workspace::resolve_ref),
        )
        .route(
            "/api/v1/friends",
            get(api::friends::list_friends)
                .post(api::friends::add_friend)
                .delete(api::friends::remove_friend),
        )
        .route("/api/v1/friends/search", get(api::friends::search_users))
        .route("/api/v1/mcp/preview", post(api::mcp::preview_mcp_config))
        .route(
            "/api/v1/mcp/parse-claude-config",
            post(api::mcp::parse_claude_config),
        )
        .layer(middleware::from_fn_with_state(state.clone(), jwt_auth))
}

fn build_public_routes() -> Router<AppState> {
    // Public endpoints used before token acquisition.
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/auth/login", post(api::auth::login))
}

fn build_ws_routes() -> Router<AppState> {
    // WebSocket endpoints are attached without JWT middleware; each handler
    // performs its own protocol-level validation where required.
    let ws_routes = Router::new()
        .route("/ws", get(ws::browser::ws_handler))
        .route(
            "/ws/agent-bridge/control",
            get(ws::agent_bridge::control_handler),
        )
        .route("/ws/agent-bridge/data", get(ws::agent_bridge::data_handler));
    ws_routes
}

async fn health() -> &'static str {
    "ok"
}
