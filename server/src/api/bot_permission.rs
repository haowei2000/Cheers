//! Owner API for Axis B of the bot permission model
//! (docs/arch/BOT_PERMISSION_MODEL.md): per-`(bot, channel, operation_kind)`
//! authorization rules (`allow` / `deny` / `ask`). The "who approves an ask"
//! half lives in the kind-aware approvers API (api/approval.rs).
//!
//! All routes are owner-or-admin gated (`bots::ensure_bot_owner_or_admin`).

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::bot_permission::{self, Decision, BOT_WIDE},
    errors::AppError,
};

/// `channel_id = ""` / absent means the bot-wide default rule.
fn normalize_channel(raw: Option<String>) -> String {
    match raw {
        Some(c) if !c.trim().is_empty() => c,
        _ => BOT_WIDE.to_string(),
    }
}

fn parse_decision_strict(raw: &str) -> Result<Decision, AppError> {
    match raw {
        "allow" => Ok(Decision::Allow),
        "deny" => Ok(Decision::Deny),
        "ask" => Ok(Decision::Ask),
        other => Err(AppError::BadRequest(format!(
            "decision must be allow|deny|ask, got {other:?}"
        ))),
    }
}

// ── GET /bots/:bot_id/permissions ───────────────────────────────────────────

pub async fn list_permissions(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let rules = bot_permission::list_rules_json(&state.db, &bot_id).await?;
    Ok(Json(json!({
        "rules": rules,
        // ACP-standard kinds the UI pre-renders as matrix rows (any kind works).
        "standard_kinds": bot_permission::STANDARD_KINDS,
    })))
}

// ── PUT /bots/:bot_id/permissions/rules ─────────────────────────────────────

#[derive(Deserialize)]
pub struct UpsertRuleRequest {
    /// Channel UUID string; absent/empty = the bot-wide default.
    pub channel_id: Option<String>,
    /// ACP toolCall.kind; `*` = catch-all.
    pub operation_kind: String,
    /// `allow` | `deny` | `ask`.
    pub decision: String,
}

pub async fn upsert_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Json(body): Json<UpsertRuleRequest>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let kind = body.operation_kind.trim();
    if kind.is_empty() {
        return Err(AppError::BadRequest("operation_kind required".into()));
    }
    let decision = parse_decision_strict(body.decision.trim())?;
    let channel = normalize_channel(body.channel_id);
    bot_permission::upsert_rule(&state.db, &bot_id, &channel, kind, decision, &claims.sub).await?;
    Ok(Json(json!({ "ok": true })))
}

// ── DELETE /bots/:bot_id/permissions/rules?channel_id=&operation_kind= ───────

#[derive(Deserialize)]
pub struct DeleteRuleQuery {
    pub channel_id: Option<String>,
    pub operation_kind: String,
}

pub async fn delete_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Query(q): Query<DeleteRuleQuery>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let channel = normalize_channel(q.channel_id);
    let removed = bot_permission::delete_rule(&state.db, &bot_id, &channel, &q.operation_kind).await?;
    if !removed {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}
