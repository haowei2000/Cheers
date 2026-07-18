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
    let row =
        sqlx::query("SELECT bridge_provider, binding_config FROM bot_accounts WHERE bot_id = $1")
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
    let cc = load_connector_control(&state, &bot_id).await?;
    // Mode is a first-class posture control for preset-backed agents, so drop the
    // duplicate `mode` config option the agent also advertises (see connector_config).
    let advertised = advertised_options(&cc)
        .map(|opts| connector_config::dedup_mode_config_options(&agent_type, opts))
        .map(Value::Array)
        .unwrap_or_else(|| json!([]));
    Ok(Json(json!({
        // Posture: the agent's session mode + the L0-allowed choices.
        "posture": {
            "agent_type": agent_type,
            "permission_mode": permission_mode,
            "allowed_modes": allowed,
        },
        // Session config options: what the agent advertised (live, reported by the
        // connector) + the owner's desired overrides (applied per-session).
        "config_options": {
            "advertised": advertised,
            "desired": cc.get("configOptions").cloned().unwrap_or_else(|| json!({})),
        },
    })))
}

/// Read the bot's `connector_control` object — advertised options (reported by the
/// connector under `options`) + desired overrides (`configOptions`) live here.
async fn load_connector_control(state: &AppState, bot_id: &str) -> Result<Value, AppError> {
    let row = sqlx::query("SELECT binding_config FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(row
        .try_get::<Option<Value>, _>("binding_config")
        .ok()
        .flatten()
        .and_then(|b| b.get("connector_control").cloned())
        .unwrap_or_else(|| json!({})))
}

/// The agent's advertised ACP config options array, as last reported by the
/// connector. The connector stores a composite session snapshot at
/// `connector_control.options.options`; the ACP `configOptions` array lives inside
/// it (sibling to `modes`/`models`/`availableCommands`). Agents that expose models
/// only via the native model-state API (`models` + `session/set_model`, e.g. older
/// codex-acp) get a synthesized "model" select option overlaid. `None` if the agent
/// advertises nothing at all — callers then skip the friendly pre-validation (the
/// connector re-validates regardless).
fn advertised_options(cc: &Value) -> Option<Vec<Value>> {
    let snapshot = cc.get("options").and_then(|o| o.get("options"))?;
    let base = snapshot
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned();
    let had_config_options = base.is_some();
    let merged = connector_config::overlay_model_state(snapshot, base.unwrap_or_default());
    if merged.is_empty() && !had_config_options {
        return None;
    }
    Some(merged)
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
            let frame = crate::gateway::bridge_frames::config_update_frame(
                cheers_bridge_protocol::ConnectorControlSettings {
                    agent_native_permission_mode: Some(mode.clone()),
                    ..Default::default()
                },
            );
            state.bot_locator.dispatch_task(uuid, frame).await
        }
        Err(_) => false,
    };
    Ok(Json(
        json!({ "ok": true, "permission_mode": mode, "delivered": delivered }),
    ))
}

// ── PUT /bots/:bot_id/permissions/config-option ──────────────────────────────
// Set an ACP session config option (model / reasoning level / mode-as-config…).
// Owner/admin-only, like posture: `set_config_option` is owner-sovereign (it's in
// OWNER_ONLY_INITIATE — not a per-subject grant). Persisted as a bot-level desired
// override + pushed to the live connector, which applies it per-session via ACP
// `session/set_config_option` and re-clamps against its L0 allowed_config_options.

#[derive(Deserialize)]
pub struct ConfigOptionRequest {
    /// The advertised option's `id` (e.g. "model", "thought_level").
    pub config_id: String,
    /// One of that option's advertised `value`s. Opaque to Cheers (ACP-generic).
    pub value: String,
}

pub async fn set_config_option(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Json(body): Json<ConfigOptionRequest>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let config_id = body.config_id.trim().to_string();
    let value = body.value;
    if config_id.is_empty() {
        return Err(AppError::BadRequest("config_id required".into()));
    }

    let cc = load_connector_control(&state, &bot_id).await?;
    // Friendly early validation against the agent's advertised options (the
    // connector + agent re-validate on apply — this is a nicer 400, not the gate).
    if let Some(adv) = advertised_options(&cc) {
        match adv
            .iter()
            .find(|o| o.get("id").and_then(Value::as_str) == Some(config_id.as_str()))
        {
            Some(opt) => {
                let value_ok = opt
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|vals| {
                        vals.iter()
                            .any(|v| v.get("value").and_then(Value::as_str) == Some(value.as_str()))
                    })
                    .unwrap_or(true);
                if !value_ok {
                    return Err(AppError::BadRequest(format!(
                        "value {value:?} is not an allowed value for config option {config_id:?}"
                    )));
                }
            }
            None => {
                return Err(AppError::BadRequest(format!(
                    "config option {config_id:?} is not advertised by this agent"
                )))
            }
        }
    }

    // Merge into the desired map so the connector receives the COMPLETE set
    // (apply_settings replaces, not merges, the stored config_options).
    let mut desired = cc
        .get("configOptions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    desired.insert(config_id.clone(), Value::String(value.clone()));
    let desired = Value::Object(desired);

    // L1 persist under binding_config.connector_control.configOptions (the inner
    // jsonb_set guarantees connector_control exists before the leaf is written).
    sqlx::query(
        "UPDATE bot_accounts SET binding_config = jsonb_set(
            jsonb_set(
                COALESCE(binding_config, '{}'::jsonb),
                '{connector_control}',
                COALESCE(binding_config -> 'connector_control', '{}'::jsonb),
                true),
            '{connector_control,configOptions}',
            $2::jsonb,
            true)
         WHERE bot_id = $1",
    )
    .bind(&bot_id)
    .bind(&desired)
    .execute(&state.db)
    .await?;

    // L2 push to a live connector (best-effort): full desired map. It re-clamps
    // via L0 allowed_config_options and applies per-session.
    let delivered = match bot_id.parse::<Uuid>() {
        Ok(uuid) => {
            let frame = crate::gateway::bridge_frames::config_update_frame(
                cheers_bridge_protocol::ConnectorControlSettings {
                    config_options: Some(desired.clone()),
                    ..Default::default()
                },
            );
            state.bot_locator.dispatch_task(uuid, frame).await
        }
        Err(_) => false,
    };
    Ok(Json(
        json!({ "ok": true, "config_id": config_id, "value": value, "delivered": delivered }),
    ))
}

// ── Event-access matrix (INITIATE / SEE / RESPOND) ──────────────────────────
// docs/arch/ACP_EVENT_TAXONOMY.md — the per-(subject × event-class × capability)
// authorization keyed on channel role with per-user overrides.

fn parse_capability(raw: &str) -> Result<Capability, AppError> {
    let cap = Capability::parse(raw).ok_or_else(|| {
        AppError::BadRequest(format!(
            "capability must be initiate|see|respond, got {raw:?}"
        ))
    })?;
    // DISPATCH governs bot→bot dispatch and is keyed on a `subject_kind='bot'`
    // subject, which this owner endpoint does not accept (role|user|group only).
    // Letting `dispatch` through here would let a client save a role/user/group
    // dispatch rule that returns {ok:true} but is silently ignored by the dispatch
    // resolver, while the only effective (bot) rule can't be created here at all.
    // Keep it out of the human INITIATE/SEE/RESPOND matrix; dispatch rules get a
    // dedicated management path (docs/design/BOT_DISPATCH.md D2).
    if matches!(cap, Capability::Dispatch) {
        return Err(AppError::BadRequest(
            "capability must be initiate|see|respond; dispatch is managed separately".into(),
        ));
    }
    Ok(cap)
}

/// The dynamic-group subjects selectable for this bot: the owner's friends, plus
/// every channel the bot is in and those channels' workspaces (ref + display label).
async fn group_catalog(state: &AppState, bot_id: &str) -> Vec<Value> {
    let mut out = vec![json!({ "ref": "friends", "label": "Owner's friends" })];
    let mut seen_ws: Vec<String> = Vec::new();
    if let Ok(rows) = sqlx::query(
        "SELECT c.channel_id, c.name AS cname, w.workspace_id AS wid, w.name AS wname
         FROM channel_memberships cm
         JOIN channels c ON c.channel_id = cm.channel_id
         JOIN workspaces w ON w.workspace_id = c.workspace_id
         WHERE cm.member_id = $1 AND cm.member_type = 'bot'",
    )
    .bind(bot_id)
    .fetch_all(&state.db)
    .await
    {
        for r in rows {
            let cid: String = r.try_get("channel_id").unwrap_or_default();
            let cname: String = r.try_get("cname").unwrap_or_default();
            out.push(
                json!({ "ref": format!("channel:{cid}"), "label": format!("#{cname} members") }),
            );
            let wid: String = r.try_get("wid").unwrap_or_default();
            if !wid.is_empty() && !seen_ws.contains(&wid) {
                seen_ws.push(wid.clone());
                let wname: String = r.try_get("wname").unwrap_or_default();
                out.push(json!({ "ref": format!("workspace:{wid}"), "label": format!("{wname} members") }));
            }
        }
    }
    out
}

/// GET /bots/:bot_id/event-access — owner/admin: the rules + the event vocabulary.
pub async fn list_event_access(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let rules = bot_event_policy::list_rules_json(&state.db, &bot_id).await?;
    // Same rules, typed, to compute the effective bot-wide baseline matrix.
    let rule_set = bot_event_policy::load_rules(&state.db, &bot_id).await?;
    let owner_id = bot_event_policy::bot_owner_id(&state.db, &bot_id).await;
    let groups = group_catalog(&state, &bot_id).await;
    Ok(Json(json!({
        "rules": rules,
        // Read-only baseline: the effective decision per (capability × event × role)
        // at bot-wide scope, so defaults (not just overrides) are visible in the UI.
        // Each cell also carries the bot owner's own decision ("you" column).
        "effective": bot_event_policy::effective_matrix(&rule_set, owner_id.as_deref()),
        "initiate_events": bot_event_policy::initiate_events(),
        "see_events": bot_event_policy::see_events(),
        "respond_events": bot_event_policy::respond_events(),
        // Selectable dynamic-group subjects (ref + label) for the per-subject overrides.
        "groups": groups,
    })))
}

#[derive(Deserialize)]
pub struct UpsertEventRuleRequest {
    pub channel_id: Option<String>,
    pub subject_kind: String, // "role" | "user"
    pub subject_id: String,   // role name | user_id | "*"
    pub event_class: String,
    pub capability: String, // initiate | see | respond
    pub decision: String,   // allow | deny
    /// Optional expiry (RFC3339, must be in the future). Absent/null = permanent.
    /// Past `expires_at` the rule stops matching (load_rules filters it) and shows
    /// as `expired` in the list until deleted or re-upserted with a new expiry.
    pub expires_at: Option<String>,
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
        k @ ("role" | "user" | "group") => k,
        other => {
            return Err(AppError::BadRequest(format!(
                "subject_kind must be role|user|group, got {other:?}"
            )))
        }
    };
    let event_class = body.event_class.trim();
    if event_class.is_empty() {
        return Err(AppError::BadRequest("event_class required".into()));
    }
    let capability = parse_capability(body.capability.trim())?;
    let allow = match body.decision.trim() {
        "allow" => true,
        "deny" => false,
        other => {
            return Err(AppError::BadRequest(format!(
                "decision must be allow|deny, got {other:?}"
            )))
        }
    };
    let subject_id = body.subject_id.trim();
    if subject_id.is_empty() {
        return Err(AppError::BadRequest("subject_id required".into()));
    }
    let expires_at = parse_future_rfc3339(body.expires_at.as_deref())?;
    let channel = normalize_channel(body.channel_id);
    bot_event_policy::upsert_rule(
        &state.db,
        &bot_id,
        &channel,
        subject_kind,
        subject_id,
        event_class,
        capability,
        allow,
        &claims.sub,
        expires_at,
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
        &state.db,
        &bot_id,
        &channel,
        q.subject_kind.trim(),
        q.subject_id.trim(),
        q.event_class.trim(),
        capability,
    )
    .await?;
    if !removed {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

// ── Bot-to-bot grants (dispatch / workspace_read) ───────────────────────────
// The dedicated management path the human INITIATE/SEE/RESPOND matrix intentionally
// excludes: rules keyed on a `subject_kind='bot'` subject, which the resolver
// (`resolve_dispatch_opt` / `resolve_bot_workspace_read_opt`) is hardwired to read.
// Two owner-facing grant kinds, each mapping to a distinct (event_class, capability):
//   - `dispatch`       → (prompt, Dispatch)         — which bot may @mention/command me
//   - `workspace_read` → (workspace_read, Initiate) — which bot may read my workspace
// Both default member-allow with deny-override (docs/design/RESOURCE_CONTEXT.md §4,
// docs/design/BOT_DISPATCH.md D2). Owner/admin gated like the rest of this module.

/// Map an owner-facing grant kind to its `bot_event_access` `(event_class, capability)`
/// key. The two bot-subject capabilities live on different keys, so the endpoint speaks
/// the stable grant name and translates here.
fn bot_grant_key(kind: &str) -> Result<(&'static str, Capability), AppError> {
    match kind {
        "dispatch" => Ok((bot_event_policy::EV_PROMPT, Capability::Dispatch)),
        "workspace_read" => Ok((bot_event_policy::EV_WORKSPACE_READ, Capability::Initiate)),
        other => Err(AppError::BadRequest(format!(
            "grant must be dispatch|workspace_read, got {other:?}"
        ))),
    }
}

/// Reverse of [`bot_grant_key`]: recover the grant name from a stored rule's
/// `(event_class, capability)`, or `None` if the rule isn't a bot-subject grant.
fn bot_grant_kind(event_class: &str, capability: &str) -> Option<&'static str> {
    match (event_class, capability) {
        (bot_event_policy::EV_PROMPT, "dispatch") => Some("dispatch"),
        (bot_event_policy::EV_WORKSPACE_READ, "initiate") => Some("workspace_read"),
        _ => None,
    }
}

/// The bots an owner can name as a grant subject: every OTHER bot that shares a
/// channel with this bot (id + display label + which channel surfaced it). Plus the
/// `*` wildcard ("any bot") is always available client-side.
async fn bot_subject_catalog(state: &AppState, bot_id: &str) -> Vec<Value> {
    let rows = sqlx::query(
        "SELECT DISTINCT b.bot_id, b.username, b.display_name
         FROM channel_memberships mine
         JOIN channel_memberships theirs ON theirs.channel_id = mine.channel_id
         JOIN bot_accounts b ON b.bot_id = theirs.member_id
         WHERE mine.member_id = $1 AND mine.member_type = 'bot'
           AND theirs.member_type = 'bot' AND theirs.member_id <> $1",
    )
    .bind(bot_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    rows.into_iter()
        .map(|r| {
            let id: String = r.try_get("bot_id").unwrap_or_default();
            let username: String = r.try_get("username").unwrap_or_default();
            let display: Option<String> = r.try_get("display_name").ok().flatten();
            json!({
                "bot_id": id,
                "label": display.filter(|s| !s.trim().is_empty()).unwrap_or(username),
            })
        })
        .collect()
}

/// GET /bots/:bot_id/bot-grants — owner/admin: the bot-subject rules + vocabulary.
pub async fn list_bot_grants(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    // Filter the full rule list to bot-subject grants, tagging each with its grant kind.
    let grants: Vec<Value> = bot_event_policy::list_rules_json(&state.db, &bot_id)
        .await?
        .into_iter()
        .filter_map(|mut r| {
            let ec = r.get("event_class").and_then(Value::as_str).unwrap_or("");
            let cap = r.get("capability").and_then(Value::as_str).unwrap_or("");
            let subject = r.get("subject_kind").and_then(Value::as_str).unwrap_or("");
            if subject != bot_event_policy::SUBJECT_BOT {
                return None;
            }
            let kind = bot_grant_kind(ec, cap)?;
            if let Some(obj) = r.as_object_mut() {
                obj.insert("grant".into(), json!(kind));
            }
            Some(r)
        })
        .collect();
    Ok(Json(json!({
        "grants": grants,
        // The two manageable grant kinds. `label` is the user-friendly name shown by
        // default; `tech` is the raw (event_class · capability) key, surfaced only in
        // the UI's hover tooltip. `default` = the member-allow baseline.
        "grant_kinds": [
            { "kind": "dispatch", "label": "Command this bot",
              "tech": "prompt · dispatch (bot subject)", "default": "allow" },
            { "kind": "workspace_read", "label": "Read this bot's workspace",
              "tech": "workspace_read · initiate (bot subject)", "default": "allow" }
        ],
        "subjects": bot_subject_catalog(&state, &bot_id).await,
    })))
}

#[derive(Deserialize)]
pub struct UpsertBotGrantRequest {
    pub channel_id: Option<String>,
    /// Subject bot id, or `"*"` for "any bot".
    pub subject_id: String,
    /// `dispatch` | `workspace_read`.
    pub grant: String,
    pub decision: String, // allow | deny
    /// Optional RFC3339 expiry (must be in the future); absent/null = permanent.
    pub expires_at: Option<String>,
}

/// PUT /bots/:bot_id/bot-grants — owner/admin upsert one bot-subject grant.
pub async fn upsert_bot_grant(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Json(body): Json<UpsertBotGrantRequest>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let (event_class, capability) = bot_grant_key(body.grant.trim())?;
    let allow = match body.decision.trim() {
        "allow" => true,
        "deny" => false,
        other => {
            return Err(AppError::BadRequest(format!(
                "decision must be allow|deny, got {other:?}"
            )))
        }
    };
    let subject_id = body.subject_id.trim();
    if subject_id.is_empty() {
        return Err(AppError::BadRequest("subject_id required".into()));
    }
    // A subject that names a concrete bot must be a real bot id (a Uuid). "*" is the
    // wildcard escape hatch. This rejects typos that would silently never match.
    if subject_id != bot_event_policy::ANY_SUBJECT && Uuid::parse_str(subject_id).is_err() {
        return Err(AppError::BadRequest(
            "subject_id must be a bot id (uuid) or \"*\"".into(),
        ));
    }
    let expires_at = parse_future_rfc3339(body.expires_at.as_deref())?;
    let channel = normalize_channel(body.channel_id);
    bot_event_policy::upsert_rule(
        &state.db,
        &bot_id,
        &channel,
        bot_event_policy::SUBJECT_BOT,
        subject_id,
        event_class,
        capability,
        allow,
        &claims.sub,
        expires_at,
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct DeleteBotGrantQuery {
    pub channel_id: Option<String>,
    pub subject_id: String,
    pub grant: String,
}

/// DELETE /bots/:bot_id/bot-grants — owner/admin remove one bot-subject grant.
pub async fn delete_bot_grant(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Query(q): Query<DeleteBotGrantQuery>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let (event_class, capability) = bot_grant_key(q.grant.trim())?;
    let channel = normalize_channel(q.channel_id);
    let removed = bot_event_policy::delete_rule(
        &state.db,
        &bot_id,
        &channel,
        bot_event_policy::SUBJECT_BOT,
        q.subject_id.trim(),
        event_class,
        capability,
    )
    .await?;
    if !removed {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// Parse an optional RFC3339 timestamp that must lie in the future (shared by the
/// event-rule and bot-grant upserts). `None`/empty → `None` (permanent).
fn parse_future_rfc3339(
    raw: Option<&str>,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, AppError> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(raw) => {
            let t = chrono::DateTime::parse_from_rfc3339(raw)
                .map_err(|e| AppError::BadRequest(format!("invalid expires_at: {e}")))?
                .with_timezone(&chrono::Utc);
            if t <= chrono::Utc::now() {
                return Err(AppError::BadRequest(
                    "expires_at must be in the future".into(),
                ));
            }
            Ok(Some(t))
        }
    }
}

// ── GET /bots/:bot_id/acp-events — the complete ACP event timeline ──────────
// docs/arch/ACP_EVENT_TAXONOMY.md Phase 5: read the acp_event_log the passthrough
// populates, so the owner can see *everything the bot did* (classified by home).

#[derive(Deserialize)]
pub struct AcpEventsQuery {
    #[serde(default = "default_event_limit")]
    pub limit: i64,
}

fn default_event_limit() -> i64 {
    100
}

pub async fn list_acp_events(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Query(q): Query<AcpEventsQuery>,
) -> Result<Json<Value>, AppError> {
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let limit = q.limit.clamp(1, 500);
    let rows = sqlx::query(
        "SELECT name, home, channel_id, session_id, payload, created_at
         FROM acp_event_log WHERE bot_id = $1
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(&bot_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let events: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "home": r.try_get::<String, _>("home").unwrap_or_default(),
                "channel_id": r.try_get::<Option<String>, _>("channel_id").ok().flatten(),
                "session_id": r.try_get::<Option<String>, _>("session_id").ok().flatten(),
                "payload": r.try_get::<Option<Value>, _>("payload").ok().flatten(),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                    .map(|t| t.to_rfc3339()).unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({ "events": events })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_capability_accepts_human_matrix_caps() {
        for raw in ["initiate", "see", "respond"] {
            assert!(parse_capability(raw).is_ok(), "{raw} should parse");
        }
    }

    #[test]
    fn parse_capability_rejects_dispatch_on_human_endpoint() {
        // dispatch is bot-subject only and managed separately; the human
        // event-access endpoints must not accept it (else a role/user/group
        // dispatch rule saves ok but is silently ignored by the resolver).
        let err = parse_capability("dispatch").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn parse_capability_rejects_unknown() {
        assert!(parse_capability("bogus").is_err());
    }

    #[test]
    fn bot_grant_key_maps_the_two_grant_kinds() {
        // The endpoint speaks stable grant names; each maps to a DISTINCT
        // (event_class, capability) key — mixing them up would author a rule the
        // resolver never reads. Dispatch: (prompt, Dispatch); read: (workspace_read,
        // Initiate).
        let (ec, cap) = bot_grant_key("dispatch").unwrap();
        assert_eq!(ec, bot_event_policy::EV_PROMPT);
        assert_eq!(cap, Capability::Dispatch);
        let (ec, cap) = bot_grant_key("workspace_read").unwrap();
        assert_eq!(ec, bot_event_policy::EV_WORKSPACE_READ);
        assert_eq!(cap, Capability::Initiate);
        assert!(
            bot_grant_key("see").is_err(),
            "human caps are not bot grants"
        );
        assert!(bot_grant_key("bogus").is_err());
    }

    #[test]
    fn bot_grant_kind_round_trips_and_ignores_others() {
        // Reverse mapping must recover exactly the two grants and reject anything
        // else — e.g. a human INITIATE·prompt rule must NOT read back as a grant.
        assert_eq!(
            bot_grant_kind(bot_event_policy::EV_PROMPT, "dispatch"),
            Some("dispatch")
        );
        assert_eq!(
            bot_grant_kind(bot_event_policy::EV_WORKSPACE_READ, "initiate"),
            Some("workspace_read")
        );
        assert_eq!(
            bot_grant_kind(bot_event_policy::EV_PROMPT, "initiate"),
            None
        );
        assert_eq!(bot_grant_kind("see", "see"), None);
    }
}
