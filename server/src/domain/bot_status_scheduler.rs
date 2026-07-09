//! Scheduled bot self-status refresh (audit item 6).
//!
//! A bot's owner can opt it into periodic self-status updates
//! (`bot_accounts.status_auto_update = true`, every
//! `status_update_interval_minutes`). The UI exposes this toggle, but nothing on
//! the backend ever acted on it — the loop was a dormant no-op. This module is
//! that loop.
//!
//! Each due bot is nudged exactly the way the manual "update status now" button
//! works (`api::bots::refresh_bot_status`): post the bot's `status_update_prompt`
//! (or a default) into the owner↔bot DM, mentioning the bot, so the agent runs
//! and writes its own card back via the `set_status` tool / `/self-status`.
//!
//! NOTE: historically this scheduled loop was meant to live in the *connector*
//! (see migration 0040's comment: "the connector re-runs `status_update_prompt`
//! every N minutes"), but no connector ships an implementation, so the gateway
//! owns it. TODO: if a connector-side loop is ever added, guard against
//! double-posting (e.g. a per-bot "scheduler owner" flag) — today the gateway is
//! the sole driver.

use crate::app_state::AppState;
use crate::domain::messages::{create_message, CreateMessageParams};
use uuid::Uuid;

/// Fallback prompt when a bot has no `status_update_prompt` configured, so the
/// scheduled refresh works out of the box.
// mirrors api::bots::DEFAULT_STATUS_REFRESH_PROMPT
const DEFAULT_STATUS_REFRESH_PROMPT: &str =
    "Update your status: call your `set_status` tool with a short status_text (and \
     optional status_emoji) reflecting what you're currently working on. If your \
     info line is stale, refresh it too via the same tool.";

/// Background loop: every ~60s, find bots whose auto-update interval has elapsed
/// and nudge each one. Never panics — a per-tick or per-bot failure is logged and
/// the loop continues.
pub async fn run(state: AppState) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
    // Skip missed ticks rather than bursting to catch up after a slow tick.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tracing::info!("bot status scheduler started (60s cadence)");
    loop {
        ticker.tick().await;
        if let Err(err) = tick(&state).await {
            tracing::warn!(error = %err, "bot status scheduler tick failed");
        }
    }
}

/// One scan: select every due bot, then prompt each. A DB failure on the scan
/// bubbles up (logged by `run`); a per-bot failure is contained so one bad bot
/// never blocks the rest.
async fn tick(state: &AppState) -> Result<(), sqlx::Error> {
    // Due = opted in, not disabled, has an owner, and either never refreshed or
    // its interval has elapsed. GREATEST(..,1) floors a null/0 interval at 1 min
    // so a misconfigured bot can't be prompted every single tick.
    let due: Vec<(String, String)> = sqlx::query_as(
        "SELECT bot_id, created_by FROM bot_accounts
         WHERE status_auto_update = TRUE
           AND is_disabled = FALSE
           AND created_by IS NOT NULL
           AND (status_last_auto_update_at IS NULL
                OR status_last_auto_update_at
                   < NOW() - make_interval(mins => GREATEST(status_update_interval_minutes, 1)))",
    )
    .fetch_all(&state.db)
    .await?;

    for (bot_id, owner) in due {
        if let Err(err) = prompt_one(state, &bot_id, &owner).await {
            tracing::warn!(bot_id = %bot_id, error = %err, "scheduled status refresh failed for bot");
        }
    }
    Ok(())
}

/// Prompt one due bot to refresh its status, then mark it attempted. Mirrors the
/// manual `api::bots::refresh_bot_status` path: post into the owner↔bot DM so the
/// (manager-only) prompt never leaks into a shared room, mention the bot to wake
/// it, and let it write its card back through its own `set_status` tool.
async fn prompt_one(state: &AppState, bot_id: &str, owner: &str) -> anyhow::Result<()> {
    let owner_uuid = Uuid::parse_str(owner)?;
    let bot_uuid = Uuid::parse_str(bot_id)?;

    // Find-or-create the owner↔bot DM (race-safe via dm_key), so a refresh works
    // even if the owner never opened one by hand.
    let channel_id = crate::domain::dms::find_or_create_dm(&state.db, owner_uuid, bot_id, true).await?;

    // INITIATE(prompt) gate — the same one `api::bots::refresh_bot_status` checks.
    // `create_message` silently skips waking the bot when this event is denied (it
    // `continue`s the dispatch loop and still returns Ok), so posting anyway would
    // be a no-op that never wakes the agent — AND bumping the clock below would then
    // suppress the retry for a whole interval. Gate up front: when denied, skip both
    // the post and the clock bump so the bot is re-evaluated next tick (a permission
    // change takes effect on its own). Fail-open on a rules error, matching the
    // manual path and create_message.
    let owner_role: String = sqlx::query(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .bind(owner)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|r| {
        use sqlx::Row;
        r.try_get::<Option<String>, _>("role").ok().flatten()
    })
    .unwrap_or_else(|| "member".to_string());
    let may_prompt = crate::domain::acp_policy::allows(
        &state.db,
        bot_id,
        &channel_id.to_string(),
        owner,
        &owner_role,
        "session/prompt",
        crate::domain::bot_event_policy::Capability::Initiate,
    )
    .await
    .unwrap_or(true);
    if !may_prompt {
        tracing::debug!(
            bot_id = %bot_id,
            "scheduled status refresh skipped: prompting this bot is not permitted by policy"
        );
        return Ok(());
    }

    let configured: Option<String> =
        sqlx::query_scalar("SELECT status_update_prompt FROM bot_accounts WHERE bot_id = $1")
            .bind(bot_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let prompt = configured
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STATUS_REFRESH_PROMPT.to_string());

    create_message(
        &state.db,
        &state.fanout,
        &state.stream_registry,
        &state.bot_locator,
        CreateMessageParams {
            user_id: owner_uuid,
            channel_id,
            content: prompt,
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: vec![bot_uuid],
            mention_names: vec![],
            session_id: None,
        },
    )
    .await?;

    // Mark attempted (NOW()) so a non-responding agent isn't re-prompted every
    // tick — the clock resets on the post, not on the agent's reply. A bot that
    // does answer will bump this again via persist_bot_self_status.
    sqlx::query("UPDATE bot_accounts SET status_last_auto_update_at = NOW() WHERE bot_id = $1")
        .bind(bot_id)
        .execute(&state.db)
        .await?;

    Ok(())
}
