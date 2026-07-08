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

pub async fn handle_write(
    db: &PgPool,
    principal: &Principal,
    params: &Value,
) -> ResourceResult {
    // Bot-only: the verb writes the CALLER's own card. Users edit bot profiles
    // through the authed REST profile editor (owner/admin-gated), not here.
    if principal.principal_type != PrincipalType::Bot {
        return Err(resource_error(
            "PERMISSION_DENIED",
            "bot.status.write is only available to bots (it writes the caller's own card)",
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

    // Same cap as the REST /self-status path.
    if status_text
        .as_deref()
        .is_some_and(|s| s.chars().count() > 140)
    {
        return Err(resource_error(
            "INVALID_PARAMS",
            "status_text too long (≤140 chars)",
        ));
    }

    crate::api::bots::persist_bot_self_status(
        db,
        &principal.principal_id.to_string(),
        &status_text,
        &status_emoji,
        info_provided,
        &info,
    )
    .await
    .map_err(db_err("bot.status.write"))?;

    Ok(json!({
        "bot_id": principal.principal_id.to_string(),
        "status_text": status_text,
        "status_emoji": status_emoji,
        "updated": true,
    }))
}
