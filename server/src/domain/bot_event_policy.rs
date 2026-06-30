//! Event-centric bot permission model (docs/arch/ACP_EVENT_TAXONOMY.md).
//!
//! Cheers governs, per `(subject × event_class × capability)`, what a user may do
//! with a bot's ACP events:
//! - **INITIATE** — may this subject cause a user→agent event (`prompt`/`set_mode`/`cancel`)?
//! - **SEE** — may this subject view an agent→user event (`output`/`tool_call`/`plan`/
//!   `trace`/`permission_request`)?
//! - **RESPOND** — may this subject answer an agent request (`permission_request`)?
//!
//! The subject is a channel **role** (`owner`/`admin`/`member`, or `*`) with optional
//! per-**user** overrides that win over the role. `channel_id == ""` is the bot-wide
//! default. Resolution is most-specific-wins and **layers on channel membership**: the
//! caller only consults this for actual members; rules then narrow (`deny`) or widen
//! (`RESPOND`). Defaults: members may `INITIATE`+`SEE`; `RESPOND` is owner/approver-only.
//!
//! Orthogonal to [`crate::domain::bot_permission`] (the owner's auto-answer policy for
//! `request_permission` per `operation_kind`); the two compose.

use serde_json::{json, Value};
use sqlx::{PgPool, Row};

use crate::errors::AppError;

pub const SUBJECT_ROLE: &str = "role";
pub const SUBJECT_USER: &str = "user";
pub const ANY_SUBJECT: &str = "*"; // role wildcard
pub const BOT_WIDE: &str = ""; // channel_id sentinel for "all channels"

// ── Event-class strings referenced directly by the resolver/filter. The full
//    vocabulary is DERIVED from the acp_events registry (single source of truth)
//    via initiate_events()/see_events()/respond_events() below. ──────────────
pub const EV_PROMPT: &str = "prompt";
pub const EV_TOOL_CALL: &str = "tool_call";
pub const EV_PERMISSION_REQUEST: &str = "permission_request";

/// Distinct event-classes the registry models for a capability, deduped in
/// registry order. `SEE` also includes `respond`-capable classes (you must see a
/// thing to answer it). This is the matrix vocabulary — it can't drift from the
/// registry because it's computed from it.
fn events_for(cap: Capability) -> Vec<&'static str> {
    // Bot-GLOBAL owner settings (the posture endpoint), not per-channel member
    // actions — excluded from the INITIATE matrix so it shows no decorative rows.
    const OWNER_ONLY_INITIATE: &[&str] = &["set_mode", "set_config_option"];
    let mut out: Vec<&'static str> = Vec::new();
    for e in crate::domain::acp_events::REGISTRY {
        let matches = match cap {
            Capability::Initiate => e.capability == Some("initiate"),
            Capability::See => matches!(e.capability, Some("see") | Some("respond")),
            Capability::Respond => e.capability == Some("respond"),
        };
        if matches {
            if let Some(class) = e.event_class {
                if cap == Capability::Initiate && OWNER_ONLY_INITIATE.contains(&class) {
                    continue;
                }
                if !out.contains(&class) {
                    out.push(class);
                }
            }
        }
    }
    out
}

/// Event classes a subject can be authorized to **INITIATE** (user→agent).
pub fn initiate_events() -> Vec<&'static str> {
    events_for(Capability::Initiate)
}
/// Event classes a subject can be authorized to **SEE** (agent→user).
pub fn see_events() -> Vec<&'static str> {
    events_for(Capability::See)
}
/// Event classes a subject can be authorized to **RESPOND** to (agent request).
pub fn respond_events() -> Vec<&'static str> {
    events_for(Capability::Respond)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    Initiate,
    See,
    Respond,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Initiate => "initiate",
            Capability::See => "see",
            Capability::Respond => "respond",
        }
    }

    pub fn parse(value: &str) -> Option<Capability> {
        match value {
            "initiate" => Some(Capability::Initiate),
            "see" => Some(Capability::See),
            "respond" => Some(Capability::Respond),
            _ => None,
        }
    }
}

/// The membership-derived default when no rule matches: members may INITIATE and
/// SEE; RESPOND is denied by default (only the bot owner or an explicit grant).
pub fn default_access(capability: Capability) -> bool {
    !matches!(capability, Capability::Respond)
}

/// One stored access rule.
#[derive(Debug, Clone)]
pub struct Rule {
    pub channel_id: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub event_class: String,
    pub capability: String,
    pub allow: bool,
}

/// Pure resolution. Most-specific-wins, trying in order:
/// `(chan,user)` ▸ `(chan,role)` ▸ `(chan,*)` ▸ `(bot-wide,user)` ▸ `(bot-wide,role)`
/// ▸ `(bot-wide,*)` ▸ the membership default. Side-effect-free for unit testing.
pub fn resolve_access(
    rules: &[Rule],
    channel_id: &str,
    user_id: &str,
    role: &str,
    event_class: &str,
    capability: Capability,
) -> bool {
    let cap = capability.as_str();
    let find = |ch: &str, sk: &str, sid: &str| {
        rules
            .iter()
            .find(|r| {
                r.channel_id == ch
                    && r.subject_kind == sk
                    && r.subject_id == sid
                    && r.event_class == event_class
                    && r.capability == cap
            })
            .map(|r| r.allow)
    };
    find(channel_id, SUBJECT_USER, user_id)
        .or_else(|| find(channel_id, SUBJECT_ROLE, role))
        .or_else(|| find(channel_id, SUBJECT_ROLE, ANY_SUBJECT))
        .or_else(|| find(BOT_WIDE, SUBJECT_USER, user_id))
        .or_else(|| find(BOT_WIDE, SUBJECT_ROLE, role))
        .or_else(|| find(BOT_WIDE, SUBJECT_ROLE, ANY_SUBJECT))
        .unwrap_or_else(|| default_access(capability))
}

/// Load all access rules for a bot (cheap; a bot has few rules).
pub async fn load_rules(db: &PgPool, bot_id: &str) -> Result<Vec<Rule>, AppError> {
    let rows = sqlx::query(
        "SELECT channel_id, subject_kind, subject_id, event_class, capability, decision
         FROM bot_event_access WHERE bot_id = $1",
    )
    .bind(bot_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Rule {
            channel_id: r.try_get("channel_id").unwrap_or_default(),
            subject_kind: r.try_get("subject_kind").unwrap_or_else(|_| SUBJECT_ROLE.into()),
            subject_id: r.try_get("subject_id").unwrap_or_else(|_| ANY_SUBJECT.into()),
            event_class: r.try_get("event_class").unwrap_or_default(),
            capability: r.try_get("capability").unwrap_or_default(),
            allow: r
                .try_get::<String, _>("decision")
                .map(|d| d == "allow")
                .unwrap_or(false),
        })
        .collect())
}

/// Convenience: load + resolve one `(subject, event_class, capability)` query.
pub async fn resolve(
    db: &PgPool,
    bot_id: &str,
    channel_id: &str,
    user_id: &str,
    role: &str,
    event_class: &str,
    capability: Capability,
) -> Result<bool, AppError> {
    let rules = load_rules(db, bot_id).await?;
    Ok(resolve_access(
        &rules,
        channel_id,
        user_id,
        role,
        event_class,
        capability,
    ))
}

/// List a bot's access rules as JSON (for the owner API), newest-touched first.
pub async fn list_rules_json(db: &PgPool, bot_id: &str) -> Result<Vec<Value>, AppError> {
    let rows = sqlx::query(
        "SELECT channel_id, subject_kind, subject_id, event_class, capability, decision,
                updated_by, updated_at
         FROM bot_event_access WHERE bot_id = $1
         ORDER BY updated_at DESC",
    )
    .bind(bot_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "channel_id": r.try_get::<String, _>("channel_id").unwrap_or_default(),
                "subject_kind": r.try_get::<String, _>("subject_kind").unwrap_or_default(),
                "subject_id": r.try_get::<String, _>("subject_id").unwrap_or_default(),
                "event_class": r.try_get::<String, _>("event_class").unwrap_or_default(),
                "capability": r.try_get::<String, _>("capability").unwrap_or_default(),
                "decision": r.try_get::<String, _>("decision").unwrap_or_default(),
                "updated_by": r.try_get::<Option<String>, _>("updated_by").ok().flatten(),
                "updated_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at")
                    .map(|t| t.to_rfc3339()).unwrap_or_default(),
            })
        })
        .collect())
}

/// Upsert one access rule (owner API). `allow=false` stores a `deny`.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_rule(
    db: &PgPool,
    bot_id: &str,
    channel_id: &str,
    subject_kind: &str,
    subject_id: &str,
    event_class: &str,
    capability: Capability,
    allow: bool,
    updated_by: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO bot_event_access
            (bot_id, channel_id, subject_kind, subject_id, event_class, capability,
             decision, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (bot_id, channel_id, subject_kind, subject_id, event_class, capability)
         DO UPDATE SET decision = EXCLUDED.decision,
                       updated_by = EXCLUDED.updated_by, updated_at = NOW()",
    )
    .bind(bot_id)
    .bind(channel_id)
    .bind(subject_kind)
    .bind(subject_id)
    .bind(event_class)
    .bind(capability.as_str())
    .bind(if allow { "allow" } else { "deny" })
    .bind(updated_by)
    .execute(db)
    .await?;
    Ok(())
}

/// Delete one access rule; returns true if a row was removed.
#[allow(clippy::too_many_arguments)]
pub async fn delete_rule(
    db: &PgPool,
    bot_id: &str,
    channel_id: &str,
    subject_kind: &str,
    subject_id: &str,
    event_class: &str,
    capability: Capability,
) -> Result<bool, AppError> {
    let res = sqlx::query(
        "DELETE FROM bot_event_access
         WHERE bot_id = $1 AND channel_id = $2 AND subject_kind = $3
           AND subject_id = $4 AND event_class = $5 AND capability = $6",
    )
    .bind(bot_id)
    .bind(channel_id)
    .bind(subject_kind)
    .bind(subject_id)
    .bind(event_class)
    .bind(capability.as_str())
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(ch: &str, sk: &str, sid: &str, ec: &str, cap: Capability, allow: bool) -> Rule {
        Rule {
            channel_id: ch.into(),
            subject_kind: sk.into(),
            subject_id: sid.into(),
            event_class: ec.into(),
            capability: cap.as_str().into(),
            allow,
        }
    }

    #[test]
    fn defaults_layer_on_membership() {
        // No rules: members may initiate + see, but not respond.
        assert!(resolve_access(&[], "c1", "u1", "member", EV_PROMPT, Capability::Initiate));
        assert!(resolve_access(&[], "c1", "u1", "member", EV_TOOL_CALL, Capability::See));
        assert!(!resolve_access(
            &[],
            "c1",
            "u1",
            "member",
            EV_PERMISSION_REQUEST,
            Capability::Respond
        ));
    }

    #[test]
    fn role_deny_overrides_default() {
        let rules = vec![rule("c1", SUBJECT_ROLE, "member", EV_TOOL_CALL, Capability::See, false)];
        // members can't see tool_call in c1…
        assert!(!resolve_access(&rules, "c1", "u1", "member", EV_TOOL_CALL, Capability::See));
        // …but admins still can (default).
        assert!(resolve_access(&rules, "c1", "u9", "admin", EV_TOOL_CALL, Capability::See));
    }

    #[test]
    fn user_override_beats_role() {
        let rules = vec![
            rule("c1", SUBJECT_ROLE, "member", EV_PROMPT, Capability::Initiate, false),
            rule("c1", SUBJECT_USER, "u1", EV_PROMPT, Capability::Initiate, true),
        ];
        // role denies, but the per-user override re-allows u1.
        assert!(resolve_access(&rules, "c1", "u1", "member", EV_PROMPT, Capability::Initiate));
        // a different member stays denied by the role rule.
        assert!(!resolve_access(&rules, "c1", "u2", "member", EV_PROMPT, Capability::Initiate));
    }

    #[test]
    fn channel_specific_beats_bot_wide() {
        let rules = vec![
            rule(BOT_WIDE, SUBJECT_ROLE, ANY_SUBJECT, EV_PROMPT, Capability::Initiate, false),
            rule("c1", SUBJECT_ROLE, ANY_SUBJECT, EV_PROMPT, Capability::Initiate, true),
        ];
        // bot-wide denies all, but c1 re-allows.
        assert!(resolve_access(&rules, "c1", "u1", "member", EV_PROMPT, Capability::Initiate));
        // a different channel falls back to the bot-wide deny.
        assert!(!resolve_access(&rules, "c9", "u1", "member", EV_PROMPT, Capability::Initiate));
    }

    #[test]
    fn respond_grant_for_member() {
        let rules = vec![rule(
            "c1",
            SUBJECT_USER,
            "u1",
            EV_PERMISSION_REQUEST,
            Capability::Respond,
            true,
        )];
        // u1 was explicitly granted respond; u2 (no grant) keeps the deny default.
        assert!(resolve_access(&rules, "c1", "u1", "member", EV_PERMISSION_REQUEST, Capability::Respond));
        assert!(!resolve_access(&rules, "c1", "u2", "member", EV_PERMISSION_REQUEST, Capability::Respond));
    }

    #[test]
    fn capability_parse_roundtrip() {
        for c in [Capability::Initiate, Capability::See, Capability::Respond] {
            assert_eq!(Capability::parse(c.as_str()), Some(c));
        }
        assert_eq!(Capability::parse("bogus"), None);
    }
}
