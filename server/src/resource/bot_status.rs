//! `bot.status.write` — an agent updates ITS OWN member card: `status_text` /
//! `status_emoji`, plus optionally its `info` line (`bot_accounts.description`,
//! the field `list_members` exposes as `info`).
//!
//! This is the write path behind the cheers-mcp-server `set_status` tool. The
//! REST twin (`POST /bots/{id}/self-status`) authenticates by the bot TOKEN,
//! which agents deliberately never see (only the connector holds it) — so the
//! agent-side write rides the already-authenticated Agent Bridge connection:
//! the resource Principal IS the bot, no extra credential involved. Persistence
//! is shared with the REST path (`api::bots::persist_bot_self_status`), and the
//! live `member_updated` broadcast is emitted at the WS boundary
//! (agent_bridge.rs), which holds the fanout — same pattern as
//! channel.messages.create.

use serde_json::{json, Value};
use sqlx::PgPool;

use super::{db_err, resource_error, Principal, PrincipalType, ResourceResult};

pub async fn handle_write(db: &PgPool, principal: &Principal, params: &Value) -> ResourceResult {
    // Bot-only: the verb writes the CALLER's own card. Users edit bot profiles
    // through the authed REST profile editor (owner/admin-gated), not here.
    if principal.principal_type != PrincipalType::Bot {
        return Err(resource_error(
            "PERMISSION_DENIED",
            "bot.status.write is only available to bots (it writes the caller's own card)",
        ));
    }

    // ── policy seam (audit item 9) ──────────────────────────────────────────
    // This is the single per-caller gate for the resource-verb write path: the
    // Principal is already resolved to exactly this bot. A future per-caller
    // policy check (e.g. an ACP capability gate, or an admin kill-switch on
    // self-status writes) would slot in HERE, before persistence — no global
    // dispatch refactor needed. Today the only gate is the throttle below.

    // Rate-limit per bot (audit item 2), same 5s floor as the REST /self-status
    // path (shared limiter keyed by bot_id) so a runaway agent can't storm the
    // member_updated broadcast. THROTTLED is the resource-layer twin of HTTP 429.
    // `peek` only — committed (`record`) after a successful persist below, so an
    // over-cap payload rejected with INVALID_PARAMS doesn't burn the 5s budget.
    let bot_id = principal.principal_id.to_string();
    if crate::infra::ratelimit::bot_status_limiter()
        .peek(&bot_id)
        .is_err()
    {
        return Err(resource_error(
            "THROTTLED",
            "status writes are rate-limited (min 5s between updates)",
        ));
    }

    let norm = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let status_text = norm("status_text");
    let status_emoji = norm("status_emoji");
    // Absent `info` keeps the current description (mirrors the REST contract
    // where an omitted `description` field is "no change").
    let info_provided = params.get("info").is_some_and(|v| !v.is_null());
    let info = norm("info");

    // Input caps (status_text ≤140, status_emoji ≤32, info/description ≤1000 chars)
    // live inside persist_bot_self_status — the choke point shared with the REST
    // /self-status path (audit item 1) — so both write paths validate identically.
    crate::api::bots::persist_bot_self_status(
        db,
        &bot_id,
        &status_text,
        &status_emoji,
        info_provided,
        &info,
    )
    .await
    .map_err(|e| match e {
        crate::api::bots::PersistStatusError::Invalid(msg) => resource_error("INVALID_PARAMS", msg),
        crate::api::bots::PersistStatusError::Db(e) => db_err("bot.status.write")(e),
    })?;

    // Persist succeeded — commit the rate-limit interval (see `peek` above).
    crate::infra::ratelimit::bot_status_limiter().record(&bot_id);

    Ok(json!({
        "bot_id": bot_id,
        "status_text": status_text,
        "status_emoji": status_emoji,
        "updated": true,
    }))
}
