//! Durable actionable Activity inbox and user-scoped notification delivery.
//!
//! Invitation rows remain the source of truth.  There is deliberately no
//! second notifications table to synchronize: polling and live delivery both
//! serialize the same [`NotificationDto`].

use axum::{extract::State, Extension, Json};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims, app_state::AppState, errors::AppError,
    gateway::realtime::frame::WireFrame,
};

#[derive(Debug, Clone, Serialize)]
pub struct NotificationDto {
    pub id: String,
    /// friend_request | workspace_invite | channel_invite | bot_channel_invite
    pub kind: String,
    pub title: String,
    pub actor_id: Option<String>,
    pub actor_name: Option<String>,
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub friendship_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requester_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requested_additional_dirs: Vec<String>,
}

/// User-scoped WS only.  Mentions and permission nudges call this helper and
/// choose their own Web Push/APNs kind separately; this prevents the historical
/// bug where every payload passed through `push_notification` became an APNs
/// invitation.
pub async fn broadcast_user_notification(state: &AppState, user_id: &str, data: Value) {
    if let Ok(uid) = Uuid::parse_str(user_id) {
        state
            .fanout
            .broadcast_user(uid, WireFrame::user("notification", data))
            .await;
    }
}

/// Backwards-compatible name for frame-hot-path callers.  Semantics are now
/// intentionally WS-only; Activity delivery uses [`deliver_activity`].
pub async fn push_notification(state: &AppState, user_id: &str, data: Value) {
    broadcast_user_notification(state, user_id, data).await;
}

pub fn spawn_notify_users_ws(state: &AppState, user_ids: Vec<String>, data: Value) {
    if user_ids.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        for user_id in user_ids {
            broadcast_user_notification(&state, &user_id, data.clone()).await;
        }
    });
}

fn activity_push_copy(item: &NotificationDto) -> (&'static str, String) {
    match item.kind.as_str() {
        "friend_request" => ("New friend request", "Open Activity to respond".into()),
        "bot_channel_invite" => (
            "Bot invitation needs approval",
            format!(
                "Review the request for {}",
                item.bot_name.as_deref().unwrap_or("your bot")
            ),
        ),
        "channel_invite" => (
            "Channel invitation",
            format!("You're invited to #{}", item.title),
        ),
        _ => (
            "Workspace invitation",
            format!("You're invited to {}", item.title),
        ),
    }
}

/// Deliver one already-durable Activity item over all configured transports.
pub async fn deliver_activity(state: &AppState, user_id: &str, item: &NotificationDto) {
    let Ok(uid) = Uuid::parse_str(user_id) else {
        return;
    };
    let (title, body) = activity_push_copy(item);
    crate::notify::push_to_user(
        state,
        uid,
        crate::notify::PushKind::Activity {
            notification_id: item.id.clone(),
            title: title.into(),
            body: body.clone(),
        },
    );
    crate::infra::web_push::spawn_push_to_users(
        state,
        vec![user_id.to_string()],
        json!({
            "kind": "activity",
            "notification_id": item.id,
            "title": title,
            "body": body,
        }),
    );
    state
        .fanout
        .broadcast_user(
            uid,
            WireFrame::user(
                "notification",
                serde_json::to_value(item).unwrap_or(Value::Null),
            ),
        )
        .await;
}

pub async fn resolve_notification(state: &AppState, user_id: &str, notification_id: &str) {
    if let Ok(uid) = Uuid::parse_str(user_id) {
        state
            .fanout
            .broadcast_user(
                uid,
                WireFrame::user("notification_resolved", json!({ "id": notification_id })),
            )
            .await;
    }
}

pub async fn deliver_notification_by_id(
    state: &AppState,
    user_id: &str,
    notification_id: &str,
) -> Result<(), AppError> {
    if let Some(item) = load_notifications(&state.db, user_id)
        .await?
        .into_iter()
        .find(|item| item.id == notification_id)
    {
        deliver_activity(state, user_id, &item).await;
    }
    Ok(())
}

/// Called whenever a pending workspace membership becomes active. Queued
/// private-channel invitations become visible only now.
pub async fn deliver_unlocked_channel_invites(
    state: &AppState,
    user_id: &str,
    workspace_id: &str,
) -> Result<(), AppError> {
    let items = load_notifications(&state.db, user_id).await?;
    for item in items.into_iter().filter(|item| {
        item.kind == "channel_invite" && item.workspace_id.as_deref() == Some(workspace_id)
    }) {
        deliver_activity(state, user_id, &item).await;
    }
    Ok(())
}

/// Build the canonical durable Activity snapshot. Keeping this at the database
/// seam lets integration tests verify the same DTOs used by REST, WS, Web Push,
/// and APNs rather than reproducing their joins in test-only code.
pub async fn load_notifications(
    db: &sqlx::PgPool,
    user_id: &str,
) -> Result<Vec<NotificationDto>, AppError> {
    let friend_rows = sqlx::query(
        "SELECT f.friendship_id, f.user_id AS actor_id,
                COALESCE(u.display_name, u.username) AS actor_name,
                f.created_at::text AS created_at
         FROM friendships f
         JOIN users u ON u.user_id = f.user_id
         WHERE f.friend_id = $1 AND f.status = 'pending'",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    let workspace_rows = sqlx::query(
        "SELECT w.workspace_id, w.name AS title, wm.role, wm.invited_by AS actor_id,
                COALESCE(iu.display_name, iu.username) AS actor_name,
                wm.invited_at::text AS created_at
         FROM workspace_memberships wm
         JOIN workspaces w ON w.workspace_id = wm.workspace_id
         LEFT JOIN users iu ON iu.user_id = wm.invited_by
         WHERE wm.user_id = $1 AND wm.status = 'pending'",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    // Queued two-stage invitations are intentionally hidden until the target
    // has accepted the workspace invitation.
    let channel_rows = sqlx::query(
        "SELECT c.channel_id, c.workspace_id, c.name AS title, ci.role,
                ci.invited_by AS actor_id,
                COALESCE(iu.display_name, iu.username) AS actor_name,
                ci.invited_at::text AS created_at
         FROM channel_invites ci
         JOIN channels c ON c.channel_id = ci.channel_id
         JOIN workspace_memberships wm
           ON wm.workspace_id = c.workspace_id
          AND wm.user_id = ci.user_id AND wm.status = 'active'
         LEFT JOIN users iu ON iu.user_id = ci.invited_by
         WHERE ci.user_id = $1",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    let bot_rows = sqlx::query(
        "SELECT bci.channel_id, c.workspace_id, c.name AS title, bci.bot_id,
                COALESCE(b.display_name, b.username) AS bot_name, bci.role,
                bci.invited_by AS actor_id,
                COALESCE(iu.display_name, iu.username) AS actor_name,
                bci.cwd, bci.additional_dirs, bci.invited_at::text AS created_at
         FROM bot_channel_invites bci
         JOIN channels c ON c.channel_id = bci.channel_id
         JOIN bot_accounts b ON b.bot_id = bci.bot_id
         LEFT JOIN users iu ON iu.user_id = bci.invited_by
         WHERE bci.owner_user_id = $1",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    let mut items = Vec::with_capacity(
        friend_rows.len() + workspace_rows.len() + channel_rows.len() + bot_rows.len(),
    );
    for row in friend_rows {
        let friendship_id: String = row.try_get("friendship_id").unwrap_or_default();
        let actor_id: String = row.try_get("actor_id").unwrap_or_default();
        items.push(NotificationDto {
            id: format!("friend:{friendship_id}"),
            kind: "friend_request".into(),
            title: row
                .try_get("actor_name")
                .unwrap_or_else(|_| "Someone".into()),
            actor_id: Some(actor_id.clone()),
            actor_name: row.try_get("actor_name").ok(),
            created_at: row.try_get("created_at").ok(),
            friendship_id: Some(friendship_id),
            workspace_id: None,
            channel_id: None,
            requester_user_id: Some(actor_id),
            bot_id: None,
            bot_name: None,
            role: None,
            requested_cwd: None,
            requested_additional_dirs: Vec::new(),
        });
    }
    for row in workspace_rows {
        let workspace_id: String = row.try_get("workspace_id").unwrap_or_default();
        items.push(NotificationDto {
            id: format!("workspace:{workspace_id}"),
            kind: "workspace_invite".into(),
            title: row.try_get("title").unwrap_or_default(),
            actor_id: row.try_get("actor_id").ok(),
            actor_name: row.try_get("actor_name").ok(),
            created_at: row.try_get("created_at").ok(),
            friendship_id: None,
            workspace_id: Some(workspace_id),
            channel_id: None,
            requester_user_id: None,
            bot_id: None,
            bot_name: None,
            role: row.try_get("role").ok(),
            requested_cwd: None,
            requested_additional_dirs: Vec::new(),
        });
    }
    for row in channel_rows {
        let channel_id: String = row.try_get("channel_id").unwrap_or_default();
        items.push(NotificationDto {
            id: format!("channel:{channel_id}"),
            kind: "channel_invite".into(),
            title: row.try_get("title").unwrap_or_default(),
            actor_id: row.try_get("actor_id").ok(),
            actor_name: row.try_get("actor_name").ok(),
            created_at: row.try_get("created_at").ok(),
            friendship_id: None,
            workspace_id: row.try_get("workspace_id").ok(),
            channel_id: Some(channel_id),
            requester_user_id: None,
            bot_id: None,
            bot_name: None,
            role: row.try_get("role").ok(),
            requested_cwd: None,
            requested_additional_dirs: Vec::new(),
        });
    }
    for row in bot_rows {
        let channel_id: String = row.try_get("channel_id").unwrap_or_default();
        let bot_id: String = row.try_get("bot_id").unwrap_or_default();
        let dirs: Value = row.try_get("additional_dirs").unwrap_or_else(|_| json!([]));
        items.push(NotificationDto {
            id: format!("bot-channel:{channel_id}:{bot_id}"),
            kind: "bot_channel_invite".into(),
            title: row.try_get("title").unwrap_or_default(),
            actor_id: row.try_get("actor_id").ok(),
            actor_name: row.try_get("actor_name").ok(),
            created_at: row.try_get("created_at").ok(),
            friendship_id: None,
            workspace_id: row.try_get("workspace_id").ok(),
            channel_id: Some(channel_id),
            requester_user_id: None,
            bot_id: Some(bot_id),
            bot_name: row.try_get("bot_name").ok(),
            role: row.try_get("role").ok(),
            requested_cwd: row.try_get("cwd").ok(),
            requested_additional_dirs: dirs
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

pub async fn list_notifications(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<NotificationDto>>, AppError> {
    Ok(Json(load_notifications(&state.db, &claims.sub).await?))
}
