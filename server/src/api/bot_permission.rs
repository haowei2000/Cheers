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
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::{
        bot_permission::{self, Decision, BOT_WIDE},
        connector_config,
    },
    errors::AppError,
};

/// Read a bot's agent type (`bridge_provider`, default "generic") + its persisted
/// posture mode from `binding_config.connector_control.agentNativePermissionMode`.
async fn load_posture(
    state: &AppState,
    bot_id: &str,
) -> Result<(String, Option<String>), AppError> {
    let row = sqlx::query("SELECT bridge_provider, binding_config FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let agent_type = row
        .try_get::<Option<String>, _>("bridge_provider")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "generic".to_string());
    let current = row
        .try_get::<Option<Value>, _>("binding_config")
        .ok()
        .flatten()
        .as_ref()
        .and_then(|b| b.get("connector_control"))
        .and_then(|c| c.get("agentNativePermissionMode"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((agent_type, current))
}

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
    let (agent_type, current) = load_posture(&state, &bot_id).await?;
    let (default_mode, allowed) = connector_config::posture_preset(&agent_type);
    let permission_mode = current.or_else(|| default_mode.map(str::to_string));
    Ok(Json(json!({
        "rules": rules,
        // ACP-standard kinds the UI pre-renders as matrix rows (any kind works).
        "standard_kinds": bot_permission::STANDARD_KINDS,
        // Axis A posture: the agent's session mode + the L0-allowed choices.
        "posture": {
            "agent_type": agent_type,
            "permission_mode": permission_mode,
            "allowed_modes": allowed,
        },
    })))
}

// ── PUT /bots/:bot_id/permissions/posture ───────────────────────────────────

#[derive(Deserialize)]
pub struct PostureRequest {
    /// ACP session modeId (e.g. "default", "plan"). Must be in the agent's
    /// L0 allowed_modes when that list is non-empty.
    pub permission_mode: String,
}

pub async fn set_posture(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Json(body): Json<PostureRequest>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let mode = body.permission_mode.trim().to_string();
    if mode.is_empty() {
        return Err(AppError::BadRequest("permission_mode required".into()));
    }
    let (agent_type, _) = load_posture(&state, &bot_id).await?;
    let (_, allowed) = connector_config::posture_preset(&agent_type);
    // Gateway-side check mirrors the connector's L0 allowed_modes envelope (the
    // connector re-clamps on apply, so this is a friendly early 400, not the gate).
    if !allowed.is_empty() && !allowed.iter().any(|m| *m == mode) {
        return Err(AppError::BadRequest(format!(
            "mode {mode:?} not in allowed_modes {allowed:?} for agent {agent_type:?}"
        )));
    }

    // L1 persist under binding_config.connector_control.agentNativePermissionMode.
    // The inner jsonb_set guarantees connector_control exists as an object before
    // the outer set writes the leaf (jsonb_set can't create intermediate objects).
    sqlx::query(
        "UPDATE bot_accounts SET binding_config = jsonb_set(
            jsonb_set(
                COALESCE(binding_config, '{}'::jsonb),
                '{connector_control}',
                COALESCE(binding_config -> 'connector_control', '{}'::jsonb),
                true),
            '{connector_control,agentNativePermissionMode}',
            to_jsonb($2::text),
            true)
         WHERE bot_id = $1",
    )
    .bind(&bot_id)
    .bind(&mode)
    .execute(&state.db)
    .await?;

    // L2 push to a live connector (best-effort). It re-clamps via L0 (both gates).
    let delivered = match bot_id.parse::<Uuid>() {
        Ok(uuid) => {
            let frame = json!({
                "type": "config_update",
                "v": 1,
                "settings": { "agentNativePermissionMode": mode },
            });
            state.bot_locator.dispatch_task(uuid, frame).await
        }
        Err(_) => false,
    };
    Ok(Json(json!({ "ok": true, "permission_mode": mode, "delivered": delivered })))
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
