//! Single policy chokepoint (docs/arch/ACP_EVENT_TAXONOMY.md, Phase 2).
//!
//! Callers pass the **ACP event name** (a method, or `session/update:<subtype>`) and
//! the capability they're asking about (INITIATE / SEE / RESPOND). This maps the
//! name → its `event_class` via the [`acp_events`] registry and delegates the
//! decision to the per-user [`bot_event_policy`] matrix. One place knows the
//! name→class mapping, so every gate (prompt, permission resolve, …) goes through
//! the same brain.

use sqlx::{PgConnection, PgPool};

use crate::domain::{
    acp_events,
    bot_event_policy::{self, Capability},
};
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
    if acp_events::classify(acp_event_name)
        .and_then(|e| e.event_class)
        .is_none()
    {
        return Ok(true);
    }
    let mut connection = db.acquire().await?;
    allows_with_connection(
        &mut connection,
        bot_id,
        channel_id,
        user_id,
        role,
        acp_event_name,
        cap,
    )
    .await
}

/// The same gate on the caller's connection, including a transaction connection.
/// Rule and dynamic-group reads must succeed before a decision can be returned.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn allows_with_connection(
    connection: &mut PgConnection,
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
    let rules = bot_event_policy::load_rules_with_executor(&mut *connection, bot_id).await?;
    let groups =
        bot_event_policy::matched_groups_with_connection(connection, bot_id, user_id, &rules)
            .await?;
    Ok(bot_event_policy::resolve_access(
        &rules, channel_id, user_id, role, &groups, class, cap,
    ))
}

/// In-memory twin of [`allows`]: same name→class mapping and gate, but resolves
/// against already-loaded `rules` + the requester's precomputed `matched_groups`
/// instead of hitting the DB. Lets a caller batch-load a bot's rules/groups ONCE
/// (via [`bot_event_policy::load_rules`] + [`bot_event_policy::matched_groups`])
/// and then decide many rows for that bot with zero further round-trips. The
/// decision is identical to `allows` for the same inputs — unmodeled events are
/// not gated here either (`true`).
#[allow(clippy::too_many_arguments)]
pub fn allows_with_rules(
    rules: &[bot_event_policy::Rule],
    channel_id: &str,
    user_id: &str,
    role: &str,
    matched_groups: &[String],
    acp_event_name: &str,
    cap: Capability,
) -> bool {
    let Some(class) = acp_events::classify(acp_event_name).and_then(|e| e.event_class) else {
        return true;
    };
    bot_event_policy::resolve_access(rules, channel_id, user_id, role, matched_groups, class, cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn modeled_policy_failure_is_not_an_allow_but_unmodeled_events_need_no_db() {
        let db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused_policy_test")
            .unwrap();
        db.close().await;
        let result = allows(
            &db,
            "bot",
            "channel",
            "user",
            "member",
            "session/prompt",
            Capability::Initiate,
        )
        .await;
        assert!(matches!(result, Err(AppError::Db(sqlx::Error::PoolClosed))));
        assert!(allows(
            &db,
            "bot",
            "channel",
            "user",
            "member",
            "session/nonexistent",
            Capability::Initiate,
        )
        .await
        .unwrap());
    }
}
