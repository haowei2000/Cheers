//! OS push notifications (docs/arch/MOBILE_APP_DESIGN.md §5).
//!
//! This module is the push side of the notification story; the live in-app side
//! stays where it is (`Fanout` user/channel frames — the realtime layer remains
//! a dumb pipe). Policy lives HERE: which events push, with what priority and
//! collapse behavior, and with minimized payloads (ids + generic text — never
//! message bodies or command contents; the app fetches full content on tap).
//!
//! Taxonomy (§5.3): permission_request always pushes (time-sensitive, with
//! Approve/Deny action ids so the notification is actionable); DMs, mentions
//! and invites push at default priority; regular channel traffic never pushes.
//! The server always sends — a foregrounded client suppresses display itself
//! (server-side "socket open" suppression would let a desktop tab eat the
//! phone's approval push).

pub mod apns;
pub mod relay;

use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::app_state::AppState;

/// The push-transport seam (docs/arch/MOBILE_APP_DESIGN.md §5.1). Closed set →
/// enum dispatch: `Apns` is the store app's direct connection (we own the
/// binary and its credentials); `Relay` lets a self-hosted gateway deliver via
/// an official Cheers relay that holds the APNs key — self-hosters can't obtain
/// APNs credentials for a bundle id they don't own.
pub enum PushTransport {
    Apns(apns::ApnsClient),
    Relay(relay::RelayClient),
}

impl PushTransport {
    /// Direct APNs when the key is configured, else the relay, else disabled.
    pub fn from_env() -> Option<Self> {
        if let Some(client) = apns::ApnsClient::from_env() {
            tracing::info!("push transport: direct APNs");
            return Some(Self::Apns(client));
        }
        if let Some(client) = relay::RelayClient::from_env() {
            tracing::info!("push transport: relay");
            return Some(Self::Relay(client));
        }
        None
    }

    pub async fn send(
        &self,
        device_token: &str,
        payload: &Value,
        collapse_id: &str,
    ) -> Result<(), apns::ApnsError> {
        match self {
            Self::Apns(client) => client.send(device_token, payload, collapse_id).await,
            Self::Relay(client) => client.send(device_token, payload, collapse_id).await,
        }
    }
}

/// A push-worthy event, already reduced to the minimal payload the app needs.
#[derive(Debug, Clone)]
pub enum PushKind {
    /// An agent hit a permission gate — the killer mobile use case. Carries the
    /// default allow/reject option ids so the notification's Approve/Deny
    /// actions can resolve without opening the app.
    PermissionRequest {
        channel_id: Uuid,
        request_id: String,
        bot_name: String,
        title: String,
        approve_option_id: Option<String>,
        reject_option_id: Option<String>,
    },
    /// A direct message (from a person or a bot).
    DirectMessage { channel_id: Uuid, sender_name: String },
    /// The user was @-mentioned in a channel.
    Mention { channel_id: Uuid, sender_name: String, channel_name: String },
    /// A workspace/channel invite (mirrors the in-app notification inbox).
    Invite { title: String },
}

impl PushKind {
    /// APNs alert title/body — deliberately generic (payload minimization).
    fn alert(&self) -> (String, String) {
        match self {
            Self::PermissionRequest { bot_name, title, .. } => {
                (format!("{bot_name} requests permission"), title.clone())
            }
            Self::DirectMessage { sender_name, .. } => {
                (sender_name.clone(), "New direct message".into())
            }
            Self::Mention { sender_name, channel_name, .. } => {
                (format!("#{channel_name}"), format!("{sender_name} mentioned you"))
            }
            Self::Invite { title } => ("Invitation".into(), format!("You're invited to {title}")),
        }
    }

    /// Collapse id (APNs `apns-collapse-id`): later pushes replace earlier ones
    /// with the same id, so a busy DM shows one banner, and a resolved approval
    /// can be replaced server-side later.
    fn collapse_id(&self) -> String {
        match self {
            Self::PermissionRequest { request_id, .. } => format!("perm:{request_id}"),
            Self::DirectMessage { channel_id, .. } => format!("dm:{channel_id}"),
            Self::Mention { channel_id, .. } => format!("mention:{channel_id}"),
            Self::Invite { title } => format!("invite:{title}"),
        }
    }

    fn is_time_sensitive(&self) -> bool {
        matches!(self, Self::PermissionRequest { .. })
    }

    /// The custom payload the app routes on (deep link + action ids).
    fn custom(&self) -> Value {
        match self {
            Self::PermissionRequest {
                channel_id,
                request_id,
                approve_option_id,
                reject_option_id,
                ..
            } => json!({
                "type": "permission_request",
                "channel_id": channel_id,
                "request_id": request_id,
                "approve_option_id": approve_option_id,
                "reject_option_id": reject_option_id,
            }),
            Self::DirectMessage { channel_id, .. } => {
                json!({ "type": "dm", "channel_id": channel_id })
            }
            Self::Mention { channel_id, .. } => {
                json!({ "type": "mention", "channel_id": channel_id })
            }
            Self::Invite { .. } => json!({ "type": "invite" }),
        }
    }

    /// Notification category — the iOS app registers ACP_APPROVAL with
    /// Approve/Deny actions.
    fn category(&self) -> Option<&'static str> {
        match self {
            Self::PermissionRequest { .. } => Some("ACP_APPROVAL"),
            _ => None,
        }
    }

    fn thread_id(&self) -> Option<String> {
        match self {
            Self::PermissionRequest { channel_id, .. }
            | Self::DirectMessage { channel_id, .. }
            | Self::Mention { channel_id, .. } => Some(channel_id.to_string()),
            Self::Invite { .. } => None,
        }
    }
}

/// Fire-and-forget push to every registered device of `user_id`. Never blocks
/// the caller's hot path: DB lookup + HTTP happen on a spawned task, and every
/// failure is a log line, not an error.
pub fn push_to_user(state: &AppState, user_id: Uuid, kind: PushKind) {
    let Some(transport) = state.push.clone() else {
        return; // push not configured — in-app WS frames still deliver
    };
    let db = state.db.clone();
    tokio::spawn(async move {
        let tokens = device_tokens(&db, user_id).await;
        if tokens.is_empty() {
            return;
        }
        let (title, body) = kind.alert();
        let payload = build_payload(&kind, &title, &body);
        let collapse = kind.collapse_id();
        for token in tokens {
            match transport.send(&token, &payload, &collapse).await {
                Ok(()) => {}
                Err(apns::ApnsError::TokenDead) => {
                    // Prune tokens Apple reports as gone (uninstall / expiry).
                    let _ = sqlx::query("DELETE FROM user_devices WHERE push_token = $1")
                        .bind(&token)
                        .execute(&db)
                        .await;
                }
                Err(err) => {
                    tracing::warn!(%user_id, error = %err, "apns push failed");
                }
            }
        }
    });
}

fn build_payload(kind: &PushKind, title: &str, body: &str) -> Value {
    let mut aps = json!({
        "alert": { "title": title, "body": body },
        "sound": "default",
        "mutable-content": 1,
    });
    if let Some(category) = kind.category() {
        aps["category"] = json!(category);
    }
    if let Some(thread) = kind.thread_id() {
        aps["thread-id"] = json!(thread);
    }
    if kind.is_time_sensitive() {
        // Requires the time-sensitive entitlement on the app; APNs silently
        // downgrades to active if the entitlement is absent.
        aps["interruption-level"] = json!("time-sensitive");
    }
    json!({ "aps": aps, "cheers": kind.custom() })
}

/// Push fan-out for a freshly posted user message: DM partners get a
/// DirectMessage push, @-mentioned users get a Mention push. Regular channel
/// traffic never pushes (§5.3). Everything happens on a spawned task; the send
/// hot path is untouched.
pub fn push_message_fanout(
    state: &AppState,
    channel_id: Uuid,
    sender_user_id: Uuid,
    mention_ids: Vec<Uuid>,
) {
    if state.push.is_none() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let Ok(channel) = sqlx::query(
            "SELECT type::text AS channel_type, name FROM channels WHERE channel_id = $1",
        )
        .bind(channel_id.to_string())
        .fetch_one(&state.db)
        .await
        else {
            return;
        };
        let channel_type: String = channel.try_get("channel_type").unwrap_or_default();
        let channel_name: String = channel.try_get("name").unwrap_or_default();

        let sender_name = sqlx::query(
            "SELECT COALESCE(display_name, username) AS name FROM users WHERE user_id = $1",
        )
        .bind(sender_user_id.to_string())
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("name").ok())
        .unwrap_or_else(|| "Someone".into());

        if channel_type == "dm" {
            // Every human member except the sender (1:1 today, robust to group DMs).
            if let Ok(rows) = sqlx::query(
                "SELECT member_id FROM channel_memberships
                 WHERE channel_id = $1 AND member_type = 'user' AND member_id <> $2",
            )
            .bind(channel_id.to_string())
            .bind(sender_user_id.to_string())
            .fetch_all(&state.db)
            .await
            {
                for row in rows {
                    if let Some(uid) = row
                        .try_get::<String, _>("member_id")
                        .ok()
                        .and_then(|s| s.parse::<Uuid>().ok())
                    {
                        push_to_user(
                            &state,
                            uid,
                            PushKind::DirectMessage {
                                channel_id,
                                sender_name: sender_name.clone(),
                            },
                        );
                    }
                }
            }
            return;
        }

        // Channel: only @-mentioned USERS push (bots are routed, not notified).
        for target in mention_ids {
            if target == sender_user_id {
                continue;
            }
            let is_user = sqlx::query("SELECT 1 AS one FROM users WHERE user_id = $1")
                .bind(target.to_string())
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .is_some();
            if is_user {
                push_to_user(
                    &state,
                    target,
                    PushKind::Mention {
                        channel_id,
                        sender_name: sender_name.clone(),
                        channel_name: channel_name.clone(),
                    },
                );
            }
        }
    });
}

/// Pull the first allow/reject option ids out of a permission card's options
/// array so the push notification's Approve/Deny actions can resolve directly.
pub fn approval_option_ids(options: &Value) -> (Option<String>, Option<String>) {
    let list = options.as_array().cloned().unwrap_or_default();
    let find = |prefix: &str| {
        list.iter().find_map(|o| {
            let kind = o.get("kind").and_then(Value::as_str).unwrap_or_default();
            if kind.starts_with(prefix) {
                o.get("option_id")
                    .or_else(|| o.get("optionId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            }
        })
    };
    (find("allow"), find("reject"))
}

async fn device_tokens(db: &PgPool, user_id: Uuid) -> Vec<String> {
    sqlx::query("SELECT push_token FROM user_devices WHERE user_id = $1")
        .bind(user_id.to_string())
        .fetch_all(db)
        .await
        .map(|rows| {
            rows.into_iter()
                .filter_map(|r| r.try_get::<String, _>("push_token").ok())
                .collect()
        })
        .unwrap_or_default()
}
