//! Axis B of the bot permission model (docs/arch/BOT_PERMISSION_MODEL.md):
//! per-`(bot, channel, operation_kind)` authorization rules, evaluated when an ACP
//! `session/request_permission` is forwarded to the gateway.
//!
//! `operation_kind` is the opaque ACP `toolCall.kind` (the gateway never interprets
//! it). `channel_id == ""` is the bot-wide default; `operation_kind == "*"` is the
//! catch-all. Resolution is **most-specific-wins**, and the safe default for an
//! unmatched request is `Ask` (never a silent allow).

use sqlx::{PgPool, Row};

use crate::errors::AppError;

pub const ANY_KIND: &str = "*";
pub const BOT_WIDE: &str = ""; // channel_id sentinel for "all channels"

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Auto-approve without bothering a human.
    Allow,
    /// Auto-reject.
    Deny,
    /// Route to the channel's approvers (the in-channel permission card).
    Ask,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
            Decision::Ask => "ask",
        }
    }

    /// Parse a stored decision; unknown values fall back to the safe `Ask`.
    pub fn parse(value: &str) -> Decision {
        match value {
            "allow" => Decision::Allow,
            "deny" => Decision::Deny,
            _ => Decision::Ask,
        }
    }
}

/// One stored rule row.
#[derive(Debug, Clone)]
pub struct Rule {
    pub channel_id: String,
    pub operation_kind: String,
    pub decision: Decision,
}

/// Pure resolution: pick the most-specific rule for `(channel_id, kind)`, trying
/// `(chan, kind)` ▸ `(chan, *)` ▸ `("", kind)` ▸ `("", *)`; default `Ask`.
/// Kept side-effect-free so it can be unit-tested without a database.
pub fn resolve_decision(rules: &[Rule], channel_id: &str, kind: &str) -> Decision {
    let find = |ch: &str, k: &str| {
        rules
            .iter()
            .find(|r| r.channel_id == ch && r.operation_kind == k)
            .map(|r| r.decision)
    };
    find(channel_id, kind)
        .or_else(|| find(channel_id, ANY_KIND))
        .or_else(|| find(BOT_WIDE, kind))
        .or_else(|| find(BOT_WIDE, ANY_KIND))
        .unwrap_or(Decision::Ask)
}

/// Load all rules for a bot (cheap; a bot has few rules).
pub async fn load_rules(db: &PgPool, bot_id: &str) -> Result<Vec<Rule>, AppError> {
    let rows = sqlx::query(
        "SELECT channel_id, operation_kind, decision FROM bot_permission_rules WHERE bot_id = $1",
    )
    .bind(bot_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Rule {
            channel_id: r.try_get("channel_id").unwrap_or_default(),
            operation_kind: r
                .try_get("operation_kind")
                .unwrap_or_else(|_| ANY_KIND.to_string()),
            decision: Decision::parse(
                &r.try_get::<String, _>("decision").unwrap_or_else(|_| "ask".into()),
            ),
        })
        .collect())
}

/// Convenience: load + resolve. Returns `Ask` if there are no matching rules.
pub async fn resolve(
    db: &PgPool,
    bot_id: &str,
    channel_id: &str,
    kind: &str,
) -> Result<Decision, AppError> {
    let rules = load_rules(db, bot_id).await?;
    Ok(resolve_decision(&rules, channel_id, kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(ch: &str, kind: &str, d: Decision) -> Rule {
        Rule {
            channel_id: ch.into(),
            operation_kind: kind.into(),
            decision: d,
        }
    }

    #[test]
    fn defaults_to_ask_when_no_rules() {
        assert_eq!(resolve_decision(&[], "c1", "execute"), Decision::Ask);
    }

    #[test]
    fn channel_kind_beats_everything() {
        let rules = vec![
            rule(BOT_WIDE, ANY_KIND, Decision::Deny),
            rule("c1", ANY_KIND, Decision::Ask),
            rule("c1", "read", Decision::Allow),
        ];
        assert_eq!(resolve_decision(&rules, "c1", "read"), Decision::Allow);
    }

    #[test]
    fn channel_catchall_beats_botwide() {
        let rules = vec![
            rule(BOT_WIDE, "read", Decision::Allow),
            rule("c1", ANY_KIND, Decision::Deny),
        ];
        // (c1, read) absent → (c1, '*')=Deny wins over (bot-wide, read)=Allow.
        assert_eq!(resolve_decision(&rules, "c1", "read"), Decision::Deny);
    }

    #[test]
    fn botwide_kind_beats_botwide_catchall() {
        let rules = vec![
            rule(BOT_WIDE, ANY_KIND, Decision::Ask),
            rule(BOT_WIDE, "execute", Decision::Deny),
        ];
        assert_eq!(resolve_decision(&rules, "c9", "execute"), Decision::Deny);
        // a different kind falls through to the bot-wide catch-all.
        assert_eq!(resolve_decision(&rules, "c9", "read"), Decision::Ask);
    }

    #[test]
    fn unknown_decision_parses_as_ask() {
        assert_eq!(Decision::parse("nonsense"), Decision::Ask);
        assert_eq!(Decision::parse("allow"), Decision::Allow);
        assert_eq!(Decision::parse("deny"), Decision::Deny);
    }
}
