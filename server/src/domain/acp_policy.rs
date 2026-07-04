//! Single policy chokepoint (docs/arch/ACP_EVENT_TAXONOMY.md, Phase 2).
//!
//! Callers pass the **ACP event name** (a method, or `session/update:<subtype>`) and
//! the capability they're asking about (INITIATE / SEE / RESPOND). This maps the
//! name → its `event_class` via the [`acp_events`] registry and delegates the
//! decision to the per-user [`bot_event_policy`] matrix. One place knows the
//! name→class mapping, so every gate (prompt, permission resolve, …) goes through
//! the same brain.

use sqlx::PgPool;

use crate::domain::{acp_events, bot_event_policy::Capability};
use crate::errors::AppError;

/// May `(user_id, role)` perform ACP event `acp_event_name` for `(bot, channel)`
/// under capability `cap`? Events the registry doesn't model with an `event_class`
/// are **not gated here** (they're agent/connector-owned) → returns `true`.
pub async fn allows(
    db: &PgPool,
    bot_id: &str,
    channel_id: &str,
    user_id: &str,
    role: &str,
    acp_event_name: &str,
    cap: Capability,
) -> Result<bool, AppError> {
    let Some(class) = acp_events::classify(acp_event_name).and_then(|e| e.event_class) else {
        return Ok(true);
    };
    crate::domain::bot_event_policy::resolve(db, bot_id, channel_id, user_id, role, class, cap)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure mapping sanity: an unmodeled event is never gated (returns Ok(true)
    // without touching the DB — classify() returns None first).
    #[tokio::test]
    async fn unmodeled_event_is_not_gated() {
        // A bogus name has no registry class → allowed regardless of DB.
        // (We can't build a PgPool here, so assert the classify() short-circuit
        // directly: an unknown name has no event_class.)
        assert!(acp_events::classify("session/nonexistent").is_none());
    }
}
