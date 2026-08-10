//! OS push notifications (docs/arch/MOBILE_APP_DESIGN.md §5).
//!
//! This module is the push side of the notification story; the live in-app side
//! stays where it is (`Fanout` user/channel frames — the realtime layer remains
//! a dumb pipe). Policy lives HERE: which events push, with what priority and
//! collapse behavior, and with minimized payloads (ids + generic text — never
//! message bodies or command contents; the app fetches full content on tap).
//!
//! Taxonomy (§5.3): permission_request always pushes (time-sensitive, with
//! Approve/Deny action ids so the notification is actionable); DMs, mentions,
//! bot-reply (user-triggered agent turn finished), and invites push at default
//! priority; regular channel traffic never pushes.
//! The server always sends — a foregrounded client suppresses display itself
//! (server-side "socket open" suppression would let a desktop tab eat the
//! phone's approval push).
//!
//! BotReply is a **push kind only** — not a DB `msg_type` and not ordinary
//! `reply_to` semantics. Treating every threaded reply as notifiable would
//! spam human↔human replies; a dedicated kind fires only when the agent turn
//! the user triggered finalizes.

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
    DirectMessage {
        channel_id: Uuid,
        sender_name: String,
    },
    /// The user was @-mentioned in a channel.
    Mention {
        channel_id: Uuid,
        sender_name: String,
        channel_name: String,
    },
    /// A bot turn the user triggered just finalized (stream `done`). Push
    /// taxonomy only — not a chat `msg_type`. Skipped when that user was also
    /// @-mentioned on the same message (Mention already covers them).
    BotReply {
        channel_id: Uuid,
        bot_name: String,
        channel_name: String,
    },
    /// A durable actionable Activity item (friend/workspace/channel/bot invite).
    Activity {
        notification_id: String,
        title: String,
        body: String,
    },
}

impl PushKind {
    fn channel_id_for_mute(&self) -> Option<Uuid> {
        match self {
            Self::DirectMessage { channel_id, .. }
            | Self::Mention { channel_id, .. }
            | Self::BotReply { channel_id, .. } => Some(*channel_id),
            Self::PermissionRequest { .. } | Self::Activity { .. } => None,
        }
    }
    /// APNs alert title/body — deliberately generic (payload minimization).
    fn alert(&self) -> (String, String) {
        match self {
            Self::PermissionRequest {
                bot_name, title, ..
            } => (
                "Remote action needs approval".into(),
                format!("{bot_name}: {title}. Approve only if you recognize this request."),
            ),
            Self::DirectMessage { sender_name, .. } => {
                (sender_name.clone(), "New direct message".into())
            }
            Self::Mention {
                sender_name,
                channel_name,
                ..
            } => (
                format!("#{channel_name}"),
                format!("{sender_name} mentioned you"),
            ),
            Self::BotReply {
                bot_name,
                channel_name,
                ..
            } => {
                if channel_name.is_empty() {
                    (bot_name.clone(), "Replied".into())
                } else {
                    (format!("#{channel_name}"), format!("{bot_name} replied"))
                }
            }
            Self::Activity { title, body, .. } => (title.clone(), body.clone()),
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
            Self::BotReply { channel_id, .. } => format!("bot-reply:{channel_id}"),
            Self::Activity {
                notification_id, ..
            } => {
                let raw = format!("activity:{notification_id}");
                if raw.len() <= 64 {
                    raw
                } else {
                    // APNs rejects collapse identifiers longer than 64 bytes.
                    // Keep the full notification id in `custom()` for routing,
                    // and use a deterministic digest only for transport dedupe.
                    format!(
                        "activity:{}",
                        &crate::infra::crypto::sha256_hex(notification_id)[..48]
                    )
                }
            }
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
            } => {
                // Omit null option ids — iOS userInfo turns JSON null into
                // NSNull, which breaks `as? String` and silently disables
                // Approve/Deny handlers.
                let mut payload = json!({
                    "type": "permission_request",
                    "channel_id": channel_id,
                    "request_id": request_id,
                });
                if let Some(id) = approve_option_id {
                    payload["approve_option_id"] = json!(id);
                }
                if let Some(id) = reject_option_id {
                    payload["reject_option_id"] = json!(id);
                }
                payload
            }
            Self::DirectMessage { channel_id, .. } => {
                json!({ "type": "dm", "channel_id": channel_id })
            }
            Self::Mention { channel_id, .. } => {
                json!({ "type": "mention", "channel_id": channel_id })
            }
            Self::BotReply { channel_id, .. } => {
                json!({ "type": "bot_reply", "channel_id": channel_id })
            }
            Self::Activity {
                notification_id, ..
            } => json!({ "type": "activity", "notification_id": notification_id }),
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
            | Self::Mention { channel_id, .. }
            | Self::BotReply { channel_id, .. } => Some(channel_id.to_string()),
            Self::Activity { .. } => None,
        }
    }

    fn kind_label(&self) -> &'static str {
        match self {
            Self::PermissionRequest { .. } => "permission_request",
            Self::DirectMessage { .. } => "dm",
            Self::Mention { .. } => "mention",
            Self::BotReply { .. } => "bot_reply",
            Self::Activity { .. } => "activity",
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
        let kind_label = kind.kind_label();
        if let Some(channel_id) = kind.channel_id_for_mute() {
            if is_channel_muted(&db, user_id, channel_id).await {
                tracing::debug!(%user_id, %channel_id, kind = kind_label, "apns skipped: channel muted");
                return;
            }
        }
        let tokens = active_device_tokens(&db, user_id).await;
        if tokens.is_empty() {
            tracing::debug!(%user_id, kind = kind_label, "apns skipped: no device tokens");
            return;
        }
        let (title, body) = kind.alert();
        let payload = build_payload(&kind, &title, &body);
        let collapse = kind.collapse_id();
        for token in tokens {
            match transport.send(&token, &payload, &collapse).await {
                Ok(()) => {
                    tracing::info!(%user_id, kind = kind_label, %collapse, "apns push sent");
                }
                Err(apns::ApnsError::TokenDead) => {
                    // Prune tokens Apple reports as gone (uninstall / expiry).
                    tracing::info!(%user_id, kind = kind_label, "apns token dead; pruning");
                    let _ = sqlx::query("DELETE FROM user_devices WHERE push_token = $1")
                        .bind(&token)
                        .execute(&db)
                        .await;
                }
                Err(err) => {
                    tracing::warn!(%user_id, kind = kind_label, error = %err, "apns push failed");
                }
            }
        }
    });
}

/// APNs for humans @-mentioned by a bot (parity with REST `push_message_fanout`).
/// In-app WS / Web Push remain the caller's responsibility — this only covers
/// the OS push path that bot mention hooks historically skipped.
pub fn push_bot_mentions_apns(
    state: &AppState,
    channel_id: Uuid,
    bot_id: Uuid,
    mentioned_user_ids: Vec<Uuid>,
) {
    if mentioned_user_ids.is_empty() || state.push.is_none() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        let channel_name: String =
            sqlx::query_scalar("SELECT COALESCE(name, '') FROM channels WHERE channel_id = $1")
                .bind(channel_id.to_string())
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
        let sender_name: String = sqlx::query_scalar(
            "SELECT COALESCE(display_name, username) FROM bot_accounts WHERE bot_id = $1",
        )
        .bind(bot_id.to_string())
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "Bot".into());
        for uid in mentioned_user_ids {
            push_to_user(
                &state,
                uid,
                PushKind::Mention {
                    channel_id,
                    sender_name: sender_name.clone(),
                    channel_name: channel_name.clone(),
                },
            );
        }
    });
}

/// Notify the human who triggered a bot turn when that turn finalizes.
/// No-op when the trigger was another bot (bot@bot hop) or the trigger user
/// was already @-mentioned on `reply_msg_id` (Mention wins).
pub fn push_bot_reply_apns(
    state: &AppState,
    channel_id: Uuid,
    bot_id: Uuid,
    trigger_msg_id: Uuid,
    reply_msg_id: Uuid,
) {
    if state.push.is_none() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        #[derive(Debug, sqlx::FromRow)]
        struct TriggerRow {
            sender_type: String,
            sender_id: Option<String>,
        }
        let Ok(Some(trigger)) = sqlx::query_as::<_, TriggerRow>(
            "SELECT sender_type, sender_id FROM messages WHERE msg_id = $1",
        )
        .bind(trigger_msg_id.to_string())
        .fetch_optional(&state.db)
        .await
        else {
            return;
        };
        if trigger.sender_type != "user" {
            return;
        }
        let Some(user_id) = trigger
            .sender_id
            .as_deref()
            .and_then(|s| s.parse::<Uuid>().ok())
        else {
            return;
        };

        // Mention already notifies this user for the same reply — don't double-push.
        let already_mentioned: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM message_mentions
                WHERE msg_id = $1 AND member_type = 'user' AND member_id = $2
             )",
        )
        .bind(reply_msg_id.to_string())
        .bind(user_id.to_string())
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);
        if already_mentioned {
            return;
        }

        let channel_name: String =
            sqlx::query_scalar("SELECT COALESCE(name, '') FROM channels WHERE channel_id = $1")
                .bind(channel_id.to_string())
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
        let bot_name: String = sqlx::query_scalar(
            "SELECT COALESCE(display_name, username) FROM bot_accounts WHERE bot_id = $1",
        )
        .bind(bot_id.to_string())
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "Bot".into());

        push_to_user(
            &state,
            user_id,
            PushKind::BotReply {
                channel_id,
                bot_name,
                channel_name,
            },
        );
    });
}

async fn is_channel_muted(db: &PgPool, user_id: Uuid, channel_id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT muted FROM channel_notification_preferences WHERE user_id = $1 AND channel_id = $2",
    )
    .bind(user_id.to_string())
    .bind(channel_id.to_string())
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .unwrap_or(false)
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

/// Pull allow/reject option ids out of a permission card's options array so the
/// iOS notification's Approve once / Deny actions can resolve directly.
/// Prefers `allow_once` (matches the fixed iOS action title) over other allow*.
pub fn approval_option_ids(options: &Value) -> (Option<String>, Option<String>) {
    let list = options.as_array().cloned().unwrap_or_default();
    let option_id = |o: &Value| {
        o.get("option_id")
            .or_else(|| o.get("optionId"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let find_kind = |prefix: &str| {
        list.iter().find_map(|o| {
            let kind = o.get("kind").and_then(Value::as_str).unwrap_or_default();
            if kind.starts_with(prefix) {
                option_id(o)
            } else {
                None
            }
        })
    };
    let find_exact_kind = |exact: &str| {
        list.iter().find_map(|o| {
            let kind = o.get("kind").and_then(Value::as_str).unwrap_or_default();
            if kind == exact {
                option_id(o)
            } else {
                None
            }
        })
    };
    // Prefer option_id == allow_once when kind is missing but ids follow ACP defaults.
    let find_exact_id = |exact: &str| {
        list.iter().find_map(|o| {
            let id = option_id(o)?;
            (id == exact).then_some(id)
        })
    };
    let approve = find_exact_kind("allow_once")
        .or_else(|| find_exact_id("allow_once"))
        .or_else(|| find_kind("allow"));
    let reject = find_kind("reject").or_else(|| find_exact_id("reject_once"));
    (approve, reject)
}

#[doc(hidden)]
pub async fn active_device_tokens(db: &PgPool, user_id: Uuid) -> Vec<String> {
    sqlx::query(
        "SELECT d.push_token
         FROM user_devices d
         JOIN users u ON u.user_id = d.user_id
         WHERE d.user_id = $1
           AND u.is_suspended = FALSE
           AND u.is_deleted = FALSE",
    )
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

/// Revoke every native push registration owned by a user. Call this whenever
/// all sessions are invalidated so lost or offline devices stop receiving APNs.
pub async fn revoke_user_devices(db: &PgPool, user_id: &str) {
    match sqlx::query("DELETE FROM user_devices WHERE user_id = $1")
        .bind(user_id)
        .execute(db)
        .await
    {
        Ok(result) if result.rows_affected() > 0 => {
            tracing::info!(
                user_id,
                devices = result.rows_affected(),
                "native push devices revoked"
            );
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(user_id, %error, "failed to revoke native push devices");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_reply_alert_and_collapse() {
        let channel_id = Uuid::new_v4();
        let kind = PushKind::BotReply {
            channel_id,
            bot_name: "codex".into(),
            channel_name: "general".into(),
        };
        assert_eq!(kind.alert(), ("#general".into(), "codex replied".into()));
        assert_eq!(kind.collapse_id(), format!("bot-reply:{channel_id}"));
        assert_eq!(kind.custom()["type"], "bot_reply");
        assert_eq!(kind.channel_id_for_mute(), Some(channel_id));
        assert!(!kind.is_time_sensitive());
    }

    #[test]
    fn bot_reply_dm_style_when_channel_unnamed() {
        let kind = PushKind::BotReply {
            channel_id: Uuid::new_v4(),
            bot_name: "codex".into(),
            channel_name: String::new(),
        };
        assert_eq!(kind.alert(), ("codex".into(), "Replied".into()));
    }

    #[test]
    fn mention_still_distinct_from_bot_reply() {
        let channel_id = Uuid::new_v4();
        let mention = PushKind::Mention {
            channel_id,
            sender_name: "codex".into(),
            channel_name: "general".into(),
        };
        let reply = PushKind::BotReply {
            channel_id,
            bot_name: "codex".into(),
            channel_name: "general".into(),
        };
        assert_ne!(mention.collapse_id(), reply.collapse_id());
        assert_eq!(mention.custom()["type"], "mention");
        assert_eq!(reply.custom()["type"], "bot_reply");
    }

    #[test]
    fn approval_option_ids_prefer_allow_once() {
        let options = json!([
            {"option_id": "allow_always", "kind": "allow_always"},
            {"option_id": "allow_once", "kind": "allow_once"},
            {"option_id": "reject_once", "kind": "reject_once"},
        ]);
        let (approve, reject) = approval_option_ids(&options);
        assert_eq!(approve.as_deref(), Some("allow_once"));
        assert_eq!(reject.as_deref(), Some("reject_once"));
    }

    #[test]
    fn permission_custom_omits_null_option_ids() {
        let kind = PushKind::PermissionRequest {
            channel_id: Uuid::new_v4(),
            request_id: "req-1".into(),
            bot_name: "codex".into(),
            title: "run".into(),
            approve_option_id: Some("allow_once".into()),
            reject_option_id: None,
        };
        let custom = kind.custom();
        assert_eq!(custom["approve_option_id"], "allow_once");
        assert!(custom.get("reject_option_id").is_none());
        assert_eq!(kind.category(), Some("ACP_APPROVAL"));
    }

    #[test]
    fn activity_uses_notification_identity_not_display_title() {
        let first = PushKind::Activity {
            notification_id: "friend:one".into(),
            title: "New invitation".into(),
            body: "Open Activity".into(),
        };
        let second = PushKind::Activity {
            notification_id: "friend:two".into(),
            title: "New invitation".into(),
            body: "Open Activity".into(),
        };
        assert_ne!(first.collapse_id(), second.collapse_id());
        assert_eq!(first.custom()["type"], "activity");
        assert_eq!(first.custom()["notification_id"], "friend:one");
        assert_eq!(first.kind_label(), "activity");
    }

    #[test]
    fn long_activity_identity_uses_apns_safe_collapse_id() {
        let notification_id = format!("bot-channel:{}:{}", Uuid::new_v4(), Uuid::new_v4());
        let kind = PushKind::Activity {
            notification_id: notification_id.clone(),
            title: "Bot invitation".into(),
            body: "Open Activity".into(),
        };

        assert!(kind.collapse_id().len() <= 64);
        assert_eq!(kind.custom()["notification_id"], notification_id);
    }
}
