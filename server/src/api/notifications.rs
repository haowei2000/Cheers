//! Notification center — the caller's actionable inbox.
//!
//! Pending invitations ARE the notifications (single source of truth — no separate
//! notifications table). The list unions the two consent-gated invite kinds:
//! - `workspace_invite` — a `pending` row in `workspace_memberships` (0025).
//! - `channel_invite`   — a row in `channel_invites` (0042).
//!
//! Each invite is also pushed live over the user-scoped WS the moment it is created
//! (`push_notification`), so an open client updates its badge without polling. The
//! push is best-effort; the DB row is the durable source the list reads back.

use axum::{extract::State, Extension, Json};
use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims, app_state::AppState, errors::AppError,
    gateway::realtime::frame::WireFrame,
};

#[derive(Serialize)]
pub struct NotificationDto {
    /// "workspace_invite" | "channel_invite".
    pub kind: &'static str,
    /// The workspace this invite is about (present for both kinds — channel invites
    /// carry it so the client can group by workspace).
    pub workspace_id: String,
    /// The channel — present only for `channel_invite`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Display label: the workspace name, or the channel name for channel invites.
    pub title: String,
    /// Display name of the inviter (best-effort; None if unknown/deleted).
    pub invited_by: Option<String>,
    /// RFC3339 timestamp of the invite (also the sort key).
    pub invited_at: Option<String>,
    /// The role the invitee will hold once they accept.
    pub role: String,
}

/// Push a live `notification` frame to every browser connection of `user_id`.
/// Best-effort — the invite is durable in the DB regardless (list_notifications
/// reads it back). No-op if `user_id` isn't a UUID or the user has no live socket.
pub async fn push_notification(state: &AppState, user_id: &str, data: Value) {
    if let Ok(uid) = Uuid::parse_str(user_id) {
        state
            .fanout
            .broadcast_user(uid, WireFrame::user("notification", data))
            .await;
    }
}

/// Fire-and-forget `notification` frames to a set of users. The desktop shell
/// consumes `kind: permission_request | mention` from the user-scoped socket
/// (WKWebView has no Push API, so Web Push can't reach it); web clients ignore
/// kinds they don't know. Independent of the Web Push config — this fires even
/// when VAPID is unset. Spawns immediately: never sits on a frame hot path.
pub fn spawn_notify_users_ws(state: &AppState, user_ids: Vec<String>, data: Value) {
    if user_ids.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        for user_id in user_ids {
            push_notification(&state, &user_id, data.clone()).await;
        }
    });
}

/// GET /api/v1/notifications — the caller's pending invitations (workspace + channel),
/// newest first.
pub async fn list_notifications(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<NotificationDto>>, AppError> {
    let me = &claims.sub;

    let ws_rows = sqlx::query(
        "SELECT w.workspace_id, w.name AS title, wm.role,
                COALESCE(iu.display_name, iu.username) AS invited_by,
                wm.invited_at::text AS invited_at
         FROM workspace_memberships wm
         JOIN workspaces w ON w.workspace_id = wm.workspace_id
         LEFT JOIN users iu ON iu.user_id = wm.invited_by
         WHERE wm.user_id = $1 AND wm.status = 'pending'",
    )
    .bind(me)
    .fetch_all(&state.db)
    .await?;

    let ch_rows = sqlx::query(
        "SELECT c.channel_id, c.workspace_id, c.name AS title, ci.role,
                COALESCE(iu.display_name, iu.username) AS invited_by,
                ci.invited_at::text AS invited_at
         FROM channel_invites ci
         JOIN channels c ON c.channel_id = ci.channel_id
         LEFT JOIN users iu ON iu.user_id = ci.invited_by
         WHERE ci.user_id = $1",
    )
    .bind(me)
    .fetch_all(&state.db)
    .await?;

    let mut items: Vec<NotificationDto> = Vec::with_capacity(ws_rows.len() + ch_rows.len());
    for r in ws_rows {
        items.push(NotificationDto {
            kind: "workspace_invite",
            workspace_id: r.try_get("workspace_id").unwrap_or_default(),
            channel_id: None,
            title: r.try_get("title").unwrap_or_default(),
            invited_by: r.try_get("invited_by").ok().flatten(),
            invited_at: r.try_get("invited_at").ok().flatten(),
            role: r.try_get("role").unwrap_or_else(|_| "member".into()),
        });
    }
    for r in ch_rows {
        items.push(NotificationDto {
            kind: "channel_invite",
            workspace_id: r.try_get("workspace_id").unwrap_or_default(),
            channel_id: r.try_get("channel_id").ok(),
            title: r.try_get("title").unwrap_or_default(),
            invited_by: r.try_get("invited_by").ok().flatten(),
            invited_at: r.try_get("invited_at").ok().flatten(),
            role: r.try_get("role").unwrap_or_else(|_| "member".into()),
        });
    }
    // RFC3339 sorts lexicographically in chronological order → newest first.
    items.sort_by(|a, b| b.invited_at.cmp(&a.invited_at));
    Ok(Json(items))
}
