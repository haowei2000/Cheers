//! Owner API for bot permissions (docs/arch/ACP_EVENT_TAXONOMY.md):
//! - posture (the agent's session mode) — `GET /permissions`, `PUT /permissions/posture`;
//! - the event-access matrix (INITIATE / SEE / RESPOND) — `…/event-access`.
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
        bot_event_policy::{self, Capability, BOT_WIDE},
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

// ── GET /bots/:bot_id/permissions ───────────────────────────────────────────

pub async fn list_permissions(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let (agent_type, current) = load_posture(&state, &bot_id).await?;
    let (default_mode, allowed) = connector_config::posture_preset(&agent_type);
    let permission_mode = current.or_else(|| default_mode.map(str::to_string));
    Ok(Json(json!({
        // Posture: the agent's session mode + the L0-allowed choices.
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

// ── Event-access matrix (INITIATE / SEE / RESPOND) ──────────────────────────
// docs/arch/ACP_EVENT_TAXONOMY.md — the per-(subject × event-class × capability)
// authorization keyed on channel role with per-user overrides.

fn parse_capability(raw: &str) -> Result<Capability, AppError> {
    Capability::parse(raw)
        .ok_or_else(|| AppError::BadRequest(format!("capability must be initiate|see|respond, got {raw:?}")))
}

/// GET /bots/:bot_id/event-access — owner/admin: the rules + the event vocabulary.
pub async fn list_event_access(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let rules = bot_event_policy::list_rules_json(&state.db, &bot_id).await?;
    Ok(Json(json!({
        "rules": rules,
        "initiate_events": bot_event_policy::INITIATE_EVENTS,
        "see_events": bot_event_policy::SEE_EVENTS,
        "respond_events": bot_event_policy::RESPOND_EVENTS,
    })))
}

#[derive(Deserialize)]
pub struct UpsertEventRuleRequest {
    pub channel_id: Option<String>,
    pub subject_kind: String, // "role" | "user"
    pub subject_id: String,   // role name | user_id | "*"
    pub event_class: String,
    pub capability: String,   // initiate | see | respond
    pub decision: String,     // allow | deny
}

/// PUT /bots/:bot_id/event-access — owner/admin upsert one rule.
pub async fn upsert_event_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Json(body): Json<UpsertEventRuleRequest>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let subject_kind = match body.subject_kind.trim() {
        k @ ("role" | "user") => k,
        other => return Err(AppError::BadRequest(format!("subject_kind must be role|user, got {other:?}"))),
    };
    let event_class = body.event_class.trim();
    if event_class.is_empty() {
        return Err(AppError::BadRequest("event_class required".into()));
    }
    let capability = parse_capability(body.capability.trim())?;
    let allow = match body.decision.trim() {
        "allow" => true,
        "deny" => false,
        other => return Err(AppError::BadRequest(format!("decision must be allow|deny, got {other:?}"))),
    };
    let subject_id = body.subject_id.trim();
    if subject_id.is_empty() {
        return Err(AppError::BadRequest("subject_id required".into()));
    }
    let channel = normalize_channel(body.channel_id);
    bot_event_policy::upsert_rule(
        &state.db, &bot_id, &channel, subject_kind, subject_id, event_class, capability, allow,
        &claims.sub,
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct DeleteEventRuleQuery {
    pub channel_id: Option<String>,
    pub subject_kind: String,
    pub subject_id: String,
    pub event_class: String,
    pub capability: String,
}

/// DELETE /bots/:bot_id/event-access — owner/admin remove one rule.
pub async fn delete_event_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Query(q): Query<DeleteEventRuleQuery>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let capability = parse_capability(q.capability.trim())?;
    let channel = normalize_channel(q.channel_id);
    let removed = bot_event_policy::delete_rule(
        &state.db, &bot_id, &channel, q.subject_kind.trim(), q.subject_id.trim(),
        q.event_class.trim(), capability,
    )
    .await?;
    if !removed {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}
