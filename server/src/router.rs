//! HTTP and WebSocket route construction for the Axum application.
//!
//! The router is intentionally split into three groups:
//! - `public`: endpoints available before authentication (health/login).
//! - `authed`: endpoints requiring JWT middleware.
//! - `ws_routes`: WebSocket upgrade and Agent Bridge endpoints.

use std::time::Duration;

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderValue, Method},
    middleware,
    routing::{delete, get, patch, post, put},
    Router,
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    timeout::TimeoutLayer,
};

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
        // Explicit request-body cap (audit H3/M5): replaces the implicit 2MB
        // default with an intentional 16 MiB ceiling sized for attachments.
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        // Backstop request timeout so a stuck handler can't pin a worker; set
        // generously so legitimate slow connector RPCs aren't cut off.
        .layer(TimeoutLayer::new(Duration::from_secs(120)))
        // CORS stays outermost so 4xx / timeout / 413 responses still carry the
        // CORS headers the browser needs to read them.
        .layer(cors)
        .with_state(state)
}

fn build_cors(state: &AppState) -> CorsLayer {
    // Fail-closed: never reflect `Any` origin. An unset CORS_ALLOWED_ORIGINS
    // falls back to a localhost dev allowlist (see Config::allowed_origins), and
    // we warn so a production deploy can't silently ship a wide-open policy.
    if state
        .config
        .cors_allowed_origins
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        tracing::warn!(
            "CORS_ALLOWED_ORIGINS not set — using localhost dev allowlist; set it explicitly in production"
        );
    }

    let origins = state
        .config
        .allowed_origins()
        .into_iter()
        .filter_map(|s| HeaderValue::from_str(&s).ok())
        .collect::<Vec<_>>();

    CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .allow_origin(AllowOrigin::list(origins))
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
        // static segments → match before :workspace_id
        .route(
            "/api/v1/workspaces/personal",
            get(api::workspaces::get_personal_workspace),
        )
        .route(
            "/api/v1/workspaces/invites",
            get(api::workspaces::list_my_invites),
        )
        // Notification center: the caller's pending invites (workspace + channel).
        .route(
            "/api/v1/notifications",
            get(api::notifications::list_notifications),
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
            "/api/v1/workspaces/:workspace_id/accept",
            post(api::workspaces::accept_invite),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/decline",
            post(api::workspaces::decline_invite),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/members",
            get(api::workspaces::list_workspace_members),
        )
        // Fleet view: workspace-level approvals inbox + bot roster (docs/design/FLEET_VIEW.md)
        .route(
            "/api/v1/workspaces/:workspace_id/fleet",
            get(api::fleet::get_fleet),
        )
        // Rail badge: workspace-agnostic actionable-pending count
        .route("/api/v1/fleet/badge", get(api::fleet::get_fleet_badge))
        // 邀请候选搜索：好友按名字模糊匹配 ∪ 任何人按完整用户名/邮箱精确匹配
        // （沿用无全站姓名目录的隐私决策；/friends/search 只认 UUID，不适用于此）
        .route(
            "/api/v1/workspaces/:workspace_id/invitable",
            get(api::workspaces::search_workspace_invitable),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/members/:user_id",
            patch(api::workspaces::set_workspace_member_role)
                .delete(api::workspaces::remove_workspace_member),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/leave",
            post(api::workspaces::leave_workspace),
        )
        // Shareable invite links: mint/list/revoke = workspace admin; accept = any
        // authenticated user (possession of the token is the authorization).
        .route(
            "/api/v1/workspaces/:workspace_id/invite-links",
            get(api::invite_links::list_invite_links).post(api::invite_links::create_invite_link),
        )
        .route(
            "/api/v1/workspaces/:workspace_id/invite-links/:link_id",
            delete(api::invite_links::revoke_invite_link),
        )
        .route(
            "/api/v1/invite-links/:token/accept",
            post(api::invite_links::accept_invite_link),
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
            "/api/v1/channels/:channel_id/invitable",
            get(api::channels::search_invitable),
        )
        .route(
            "/api/v1/channels/:channel_id/members/:member_id",
            patch(api::channels::set_channel_member_role)
                .delete(api::channels::remove_channel_member),
        )
        .route(
            "/api/v1/channels/:channel_id/leave",
            post(api::channels::leave_channel),
        )
        // Self-serve join for public channels (Slack model) — active workspace
        // members only; private channels stay invite-only.
        .route(
            "/api/v1/channels/:channel_id/join",
            post(api::channels::join_channel),
        )
        // Consent flow for a channel invite (the invitee acts on their own invite).
        .route(
            "/api/v1/channels/:channel_id/accept",
            post(api::channels::accept_channel_invite),
        )
        .route(
            "/api/v1/channels/:channel_id/decline",
            post(api::channels::decline_channel_invite),
        )
        .route(
            "/api/v1/channels/:channel_id/messages",
            post(api::messages::send_message).get(api::messages::list_messages),
        )
        .route(
            "/api/v1/channels/:channel_id/read",
            post(api::channels::mark_channel_read),
        )
        .route(
            "/api/v1/channels/:channel_id/messages/:msg_id/cancel",
            post(api::messages::cancel_message),
        )
        // ── Per-channel sessions: primary + other (docs/arch/SESSION_MODEL.md) ─
        .route(
            "/api/v1/channels/:channel_id/bots/:bot_id/sessions",
            get(api::session_control::list_sessions).post(api::session_control::create_session),
        )
        .route(
            "/api/v1/channels/:channel_id/bots/:bot_id/sessions/:session_id",
            axum::routing::delete(api::session_control::close_session),
        )
        .route(
            "/api/v1/channels/:channel_id/bots/:bot_id/session-controls",
            get(api::session_control::session_controls),
        )
        .route(
            "/api/v1/channels/:channel_id/bots/:bot_id/sessions/:session_id/mode",
            post(api::session_control::set_session_mode),
        )
        .route(
            "/api/v1/channels/:channel_id/bots/:bot_id/sessions/:session_id/config-option",
            post(api::session_control::set_session_config_option),
        )
        .route(
            "/api/v1/channels/:channel_id/bots/:bot_id/sessions/:session_id/workspace",
            put(api::session_control::set_session_workspace),
        )
        .route(
            "/api/v1/channels/:channel_id/bots/:bot_id/sessions/:session_id/primary",
            post(api::session_control::set_primary_session),
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
        // ── Durable agent-trace timeline (docs/arch/TRACE_PERSISTENCE.md) ─────
        .route(
            "/api/v1/channels/:channel_id/messages/:msg_id/trace",
            get(api::approval::list_message_trace),
        )
        .route(
            "/api/v1/channels/:channel_id/traces",
            get(api::approval::list_channel_trace),
        )
        .route(
            "/api/v1/bots/:bot_id/approvers",
            get(api::approval::list_approvers).post(api::approval::grant_approver),
        )
        .route(
            "/api/v1/bots/:bot_id/approvers/:user_id",
            delete(api::approval::revoke_approver),
        )
        // ── Axis B: per-operation permission rules (owner matrix) ────────────
        .route(
            "/api/v1/bots/:bot_id/permissions",
            get(api::bot_permission::list_permissions),
        )
        .route(
            "/api/v1/bots/:bot_id/permissions/posture",
            put(api::bot_permission::set_posture),
        )
        .route(
            "/api/v1/bots/:bot_id/permissions/config-option",
            put(api::bot_permission::set_config_option),
        )
        // ── Event-access matrix (INITIATE / SEE / RESPOND) ───────────────────
        .route(
            "/api/v1/bots/:bot_id/event-access",
            get(api::bot_permission::list_event_access)
                .put(api::bot_permission::upsert_event_rule)
                .delete(api::bot_permission::delete_event_rule),
        )
        // ── Bot-to-bot grants (dispatch / workspace_read; bot-subject rules) ──
        .route(
            "/api/v1/bots/:bot_id/bot-grants",
            get(api::bot_permission::list_bot_grants)
                .put(api::bot_permission::upsert_bot_grant)
                .delete(api::bot_permission::delete_bot_grant),
        )
        .route(
            "/api/v1/bots/:bot_id/acp-events",
            get(api::bot_permission::list_acp_events),
        )
        .route(
            "/api/v1/bots",
            get(api::bots::list_bots).post(api::bots::create_bot),
        )
        .route(
            "/api/v1/bots/:bot_id/status",
            get(api::bots::get_bot_status),
        )
        .route(
            "/api/v1/bots/:bot_id/status/refresh",
            post(api::bots::refresh_bot_status),
        )
        .route(
            "/api/v1/bots/:bot_id/connection-events",
            get(api::bots::list_connection_events),
        )
        .route(
            "/api/v1/bots/:bot_id/profile",
            patch(api::bots::update_bot_profile),
        )
        .route("/api/v1/bots/:bot_id/test", post(api::bots::test_bot))
        .route("/api/v1/bots/:bot_id/disable", post(api::bots::disable_bot))
        .route("/api/v1/bots/:bot_id/enable", post(api::bots::enable_bot))
        .route("/api/v1/bots/:bot_id", delete(api::bots::delete_bot))
        .route(
            "/api/v1/bots/:bot_id/token",
            post(api::bots::issue_bot_token),
        )
        // ── Bot onboarding: one-time enrollment codes + connector config ─────
        .route(
            "/api/v1/bots/:bot_id/enrollment",
            post(api::enrollment::mint_enrollment_code)
                .delete(api::enrollment::revoke_enrollment_codes),
        )
        .route(
            "/api/v1/bots/:bot_id/connector-config",
            get(api::enrollment::get_connector_config),
        )
        .route(
            "/api/v1/ops/connector-discovery",
            get(api::enrollment::connector_discovery),
        )
        .route(
            "/api/v1/enrollment/guidance",
            get(api::enrollment::guidance),
        )
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
        // Avatar upload (authed; serving is public — see build_public_routes).
        .route(
            "/api/v1/users/me/avatar",
            post(api::avatars::upload_user_avatar),
        )
        .route(
            "/api/v1/bots/:bot_id/avatar",
            post(api::avatars::upload_bot_avatar),
        )
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
        .route(
            "/api/v1/files/:file_id/transcribe",
            post(api::files::transcribe_file),
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
        // 只读 git 可见性(远程工作区的 status/diff/log,绝不改动仓库)
        .route(
            "/api/v1/channels/:channel_id/workspace/git/status",
            get(api::workspace::get_git_status),
        )
        .route(
            "/api/v1/channels/:channel_id/workspace/git/diff",
            get(api::workspace::get_git_diff),
        )
        .route(
            "/api/v1/channels/:channel_id/workspace/git/log",
            get(api::workspace::get_git_log),
        )
        .route(
            "/api/v1/channels/:channel_id/workspace/git/show",
            get(api::workspace::get_git_show),
        )
        .route(
            "/api/v1/channels/:channel_id/workspace/git/commit-files",
            get(api::workspace::get_git_commit_files),
        )
        // 工作区策略元数据(allowed_roots / default_cwd / git 开关),给根目录选择器用
        .route(
            "/api/v1/channels/:channel_id/workspace/meta",
            get(api::workspace::get_workspace_meta),
        )
        // 频道内各 session 的工作目录,给根目录选择器提供"从 session workdir 里选"
        .route(
            "/api/v1/channels/:channel_id/workspace/session-workdirs",
            get(api::workspace::get_session_workdirs),
        )
        // 远程工作区实时监听:start/stop 连接器的文件变更 watcher
        .route(
            "/api/v1/channels/:channel_id/workspace/watch",
            post(api::workspace::watch_workspace),
        )
        .route(
            "/api/v1/channels/:channel_id/workspace/unwatch",
            post(api::workspace::unwatch_workspace),
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
        .route(
            "/api/v1/friends/requests",
            get(api::friends::list_friend_requests),
        )
        .route(
            "/api/v1/friends/requests/:user_id/accept",
            post(api::friends::accept_friend),
        )
        .route("/api/v1/friends/blocks", get(api::friends::list_blocks))
        .route("/api/v1/friends/block", post(api::friends::block_user))
        .route("/api/v1/friends/unblock", post(api::friends::unblock_user))
        // Account: self-service password change + server-side logout (token revocation).
        .route(
            "/api/v1/auth/change-password",
            post(api::auth::change_password),
        )
        .route("/api/v1/auth/logout", post(api::auth::logout))
        // Self-service profile: the caller's own identity + status line ("information"
        // is the bio). Static `/me` segment must precede `/:user_id`.
        .route(
            "/api/v1/users/me",
            get(api::users::get_me).patch(api::users::update_me),
        )
        // Admin user provisioning: list / create / soft-delete.
        .route(
            "/api/v1/users",
            get(api::users::list_users).post(api::users::create_user),
        )
        .route("/api/v1/users/:user_id", delete(api::users::delete_user))
        .route(
            "/api/v1/users/:user_id/suspend",
            post(api::users::suspend_user),
        )
        .route(
            "/api/v1/users/:user_id/unsuspend",
            post(api::users::unsuspend_user),
        )
        // Admin instance settings: speech-to-text endpoint (runtime, hot-reloaded).
        .route(
            "/api/v1/admin/settings/stt",
            get(api::stt_settings::get_settings).put(api::stt_settings::put_settings),
        )
        .route(
            "/api/v1/admin/settings/stt/test",
            post(api::stt_settings::test_settings),
        )
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
        // Public self-service sign-up (gated by config.open_registration): request an
        // email verification code, then register with it.
        .route(
            "/api/v1/auth/register/request-code",
            post(api::auth::register_request_code),
        )
        .route("/api/v1/auth/register", post(api::auth::register))
        // Public password-reset flow: request a one-time code, then set a new password.
        .route(
            "/api/v1/auth/forgot-password",
            post(api::auth::forgot_password),
        )
        .route(
            "/api/v1/auth/reset-password",
            post(api::auth::reset_password),
        )
        // Public, code-authenticated: a host redeems a one-time enrollment code
        // for a freshly rotated bot token + connector config. No JWT — the code
        // IS the credential (rate-limited + single-use + short TTL).
        .route(
            "/api/v1/enrollment/redeem",
            post(api::enrollment::redeem_enrollment_code),
        )
        // Public invite-link preview for the landing page: the visitor usually has
        // no account yet. Read-only + rate-limited; workspace details come back
        // only while the link is live.
        .route(
            "/api/v1/invite-links/:token",
            get(api::invite_links::preview_invite_link),
        )
        // Public, no secrets: the mode-2 connector installer, served with the
        // API base baked in (reachable via the existing nginx /api proxy).
        .route("/api/v1/install.sh", get(api::enrollment::install_script))
        // Public: same-origin proxy for the prebuilt connector binaries — for hosts
        // that can reach this gateway but not GitHub (install.sh tries this first).
        .route(
            "/api/v1/connector/download/:asset",
            get(api::enrollment::connector_download),
        )
        // Bot self-status: authenticated by the bot's Agent Bridge token (Bearer),
        // not a user JWT — the connector calls this to write the bot's own status
        // (ad-hoc or after a scheduled `status_update_prompt` run). No JWT layer.
        .route(
            "/api/v1/bots/:bot_id/self-status",
            post(api::bots::bot_self_status),
        )
        // Avatar images: public so an `<img src>` (no auth header) resolves. The
        // path is uuid-versioned + validated; the bytes aren't sensitive.
        .route(
            "/api/v1/users/:user_id/avatar/:file",
            get(api::avatars::get_user_avatar),
        )
        .route(
            "/api/v1/bots/:bot_id/avatar/:file",
            get(api::avatars::get_bot_avatar),
        )
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
