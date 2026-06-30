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
pub const SUBJECT_GROUP: &str = "group"; // dynamic group: friends | channel:<id> | workspace:<id>
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

/// Pure resolution. Most-specific-wins; within each scope the precedence is
/// **user ▸ group ▸ role ▸ ∗**, and a channel-specific scope beats the bot-wide one:
/// `(chan,user)▸(chan,group)▸(chan,role)▸(chan,*)▸(bot,user)▸(bot,group)▸(bot,role)▸(bot,*)`
/// ▸ membership default. `matched_groups` are the group refs THIS user belongs to
/// (resolved by the caller); among matching group rules at a scope **deny wins**.
/// Side-effect-free for unit testing.
pub fn resolve_access(
    rules: &[Rule],
    channel_id: &str,
    user_id: &str,
    role: &str,
    matched_groups: &[String],
    event_class: &str,
    capability: Capability,
) -> bool {
    let cap = capability.as_str();
    let one = |ch: &str, sk: &str, sid: &str| {
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
    // Group tier at a scope: deny-wins across all groups the user belongs to.
    let group_at = |ch: &str| {
        let mut found = false;
        let mut all_allow = true;
        for r in rules.iter().filter(|r| {
            r.channel_id == ch
                && r.subject_kind == SUBJECT_GROUP
                && r.event_class == event_class
                && r.capability == cap
                && matched_groups.iter().any(|g| g == &r.subject_id)
        }) {
            found = true;
            all_allow &= r.allow;
        }
        found.then_some(all_allow)
    };
    one(channel_id, SUBJECT_USER, user_id)
        .or_else(|| group_at(channel_id))
        .or_else(|| one(channel_id, SUBJECT_ROLE, role))
        .or_else(|| one(channel_id, SUBJECT_ROLE, ANY_SUBJECT))
        .or_else(|| one(BOT_WIDE, SUBJECT_USER, user_id))
        .or_else(|| group_at(BOT_WIDE))
        .or_else(|| one(BOT_WIDE, SUBJECT_ROLE, role))
        .or_else(|| one(BOT_WIDE, SUBJECT_ROLE, ANY_SUBJECT))
        .unwrap_or_else(|| default_access(capability))
}

// ── Dynamic group membership (friends | channel:<id> | workspace:<id>) ──────

/// The group refs (from `rules`) that `user_id` currently belongs to. Only checks
/// groups that actually have a rule, so it's cheap. Dynamic: friends = the bot
/// owner's accepted friends; `channel:<id>`/`workspace:<id>` = current membership.
pub async fn matched_groups(
    db: &PgPool,
    bot_id: &str,
    user_id: &str,
    rules: &[Rule],
) -> Vec<String> {
    use std::collections::HashSet;
    let refs: HashSet<&str> = rules
        .iter()
        .filter(|r| r.subject_kind == SUBJECT_GROUP)
        .map(|r| r.subject_id.as_str())
        .collect();
    if refs.is_empty() {
        return Vec::new();
    }
    let mut owner: Option<Option<String>> = None;
    let mut out = Vec::new();
    for g in refs {
        let belongs = if g == "friends" {
            let oid = match &owner {
                Some(o) => o.clone(),
                None => {
                    let v = bot_owner_id(db, bot_id).await;
                    owner = Some(v.clone());
                    v
                }
            };
            match oid {
                Some(o) => is_friend(db, &o, user_id).await,
                None => false,
            }
        } else if let Some(cid) = g.strip_prefix("channel:") {
            is_channel_member(db, cid, user_id).await
        } else if let Some(wid) = g.strip_prefix("workspace:") {
            is_workspace_member(db, wid, user_id).await
        } else {
            false
        };
        if belongs {
            out.push(g.to_string());
        }
    }
    out
}

async fn bot_owner_id(db: &PgPool, bot_id: &str) -> Option<String> {
    sqlx::query("SELECT created_by FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<Option<String>, _>("created_by").ok().flatten())
}

async fn is_friend(db: &PgPool, a: &str, b: &str) -> bool {
    if a == b {
        return false;
    }
    let pair = if a <= b { format!("{a}:{b}") } else { format!("{b}:{a}") };
    sqlx::query(
        "SELECT EXISTS(SELECT 1 FROM friendships WHERE pair_key = $1 AND status = 'accepted') AS ok",
    )
    .bind(pair)
    .fetch_one(db)
    .await
    .ok()
    .and_then(|r| r.try_get::<bool, _>("ok").ok())
    .unwrap_or(false)
}

async fn is_channel_member(db: &PgPool, channel_id: &str, user_id: &str) -> bool {
    sqlx::query(
        "SELECT EXISTS(SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user') AS ok",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(db)
    .await
    .ok()
    .and_then(|r| r.try_get::<bool, _>("ok").ok())
    .unwrap_or(false)
}

async fn is_workspace_member(db: &PgPool, workspace_id: &str, user_id: &str) -> bool {
    sqlx::query(
        "SELECT EXISTS(SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2 AND status = 'active') AS ok",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_one(db)
    .await
    .ok()
    .and_then(|r| r.try_get::<bool, _>("ok").ok())
    .unwrap_or(false)
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
    let groups = matched_groups(db, bot_id, user_id, &rules).await;
    Ok(resolve_access(
        &rules,
        channel_id,
        user_id,
        role,
        &groups,
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

    /// Test helper: resolve with no group memberships.
    fn allows(rules: &[Rule], ch: &str, user: &str, role: &str, ec: &str, cap: Capability) -> bool {
        resolve_access(rules, ch, user, role, &[], ec, cap)
    }

    #[test]
    fn defaults_layer_on_membership() {
        // No rules: members may initiate + see, but not respond.
        assert!(allows(&[], "c1", "u1", "member", EV_PROMPT, Capability::Initiate));
        assert!(allows(&[], "c1", "u1", "member", EV_TOOL_CALL, Capability::See));
        assert!(!allows(&[], "c1", "u1", "member", EV_PERMISSION_REQUEST, Capability::Respond));
    }

    #[test]
    fn role_deny_overrides_default() {
        let rules = vec![rule("c1", SUBJECT_ROLE, "member", EV_TOOL_CALL, Capability::See, false)];
        assert!(!allows(&rules, "c1", "u1", "member", EV_TOOL_CALL, Capability::See));
        assert!(allows(&rules, "c1", "u9", "admin", EV_TOOL_CALL, Capability::See));
    }

    #[test]
    fn user_override_beats_role() {
        let rules = vec![
            rule("c1", SUBJECT_ROLE, "member", EV_PROMPT, Capability::Initiate, false),
            rule("c1", SUBJECT_USER, "u1", EV_PROMPT, Capability::Initiate, true),
        ];
        assert!(allows(&rules, "c1", "u1", "member", EV_PROMPT, Capability::Initiate));
        assert!(!allows(&rules, "c1", "u2", "member", EV_PROMPT, Capability::Initiate));
    }

    #[test]
    fn channel_specific_beats_bot_wide() {
        let rules = vec![
            rule(BOT_WIDE, SUBJECT_ROLE, ANY_SUBJECT, EV_PROMPT, Capability::Initiate, false),
            rule("c1", SUBJECT_ROLE, ANY_SUBJECT, EV_PROMPT, Capability::Initiate, true),
        ];
        assert!(allows(&rules, "c1", "u1", "member", EV_PROMPT, Capability::Initiate));
        assert!(!allows(&rules, "c9", "u1", "member", EV_PROMPT, Capability::Initiate));
    }

    #[test]
    fn respond_grant_for_member() {
        let rules = vec![rule("c1", SUBJECT_USER, "u1", EV_PERMISSION_REQUEST, Capability::Respond, true)];
        assert!(allows(&rules, "c1", "u1", "member", EV_PERMISSION_REQUEST, Capability::Respond));
        assert!(!allows(&rules, "c1", "u2", "member", EV_PERMISSION_REQUEST, Capability::Respond));
    }

    #[test]
    fn group_tier_and_precedence() {
        // friends group is granted RESPOND; role default denies it.
        let rules = vec![
            rule("c1", SUBJECT_GROUP, "friends", EV_PERMISSION_REQUEST, Capability::Respond, true),
            rule("c1", SUBJECT_USER, "u2", EV_PERMISSION_REQUEST, Capability::Respond, false),
        ];
        let friends = vec!["friends".to_string()];
        // u1 is a friend → group allow beats the deny default.
        assert!(resolve_access(&rules, "c1", "u1", "member", &friends, EV_PERMISSION_REQUEST, Capability::Respond));
        // u2 is a friend too, but the per-USER deny beats the group allow (user ▸ group).
        assert!(!resolve_access(&rules, "c1", "u2", "member", &friends, EV_PERMISSION_REQUEST, Capability::Respond));
        // u3 is NOT a friend → no group match → falls to the respond deny default.
        assert!(!resolve_access(&rules, "c1", "u3", "member", &[], EV_PERMISSION_REQUEST, Capability::Respond));
    }

    #[test]
    fn group_deny_wins_on_tie() {
        // two groups the user belongs to disagree → deny wins.
        let rules = vec![
            rule("c1", SUBJECT_GROUP, "friends", EV_TOOL_CALL, Capability::See, true),
            rule("c1", SUBJECT_GROUP, "workspace:w1", EV_TOOL_CALL, Capability::See, false),
        ];
        let both = vec!["friends".to_string(), "workspace:w1".to_string()];
        assert!(!resolve_access(&rules, "c1", "u1", "member", &both, EV_TOOL_CALL, Capability::See));
    }

    #[test]
    fn capability_parse_roundtrip() {
        for c in [Capability::Initiate, Capability::See, Capability::Respond] {
            assert_eq!(Capability::parse(c.as_str()), Some(c));
        }
        assert_eq!(Capability::parse("bogus"), None);
    }
}
