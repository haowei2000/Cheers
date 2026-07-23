//! Per-channel session management (docs/arch/SESSION_MODEL.md): a channel has one
//! PRIMARY (default) session per bot plus any number of "other" sessions, each
//! addressed by its `session_id` — topic-free. Channel members may list a bot's
//! sessions and start a new "other" one.

use axum::{
    body::Bytes,
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::{acp_policy, bot_event_policy::Capability, connector_config, sessions, two_factor},
    errors::AppError,
};

/// Channel-member gate (platform admins bypass), mirroring messages.rs.
async fn ensure_channel_member(
    state: &AppState,
    channel_id: Uuid,
    claims: &Claims,
) -> Result<Uuid, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid user_id".into()))?;
    if matches!(claims.role.as_str(), "system_admin" | "admin") {
        return Ok(user_id);
    }
    let ok = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM channel_memberships
            WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'
        ) AS ok",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_one(&state.db)
    .await?
    .try_get::<bool, _>("ok")
    .unwrap_or(false);
    if ok {
        Ok(user_id)
    } else {
        Err(AppError::Forbidden("not a channel member".into()))
    }
}

// ── GET /api/v1/channels/:channel_id/bots/:bot_id/sessions ───────────────────

pub async fn list_sessions(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_member(&state, channel_id, &claims).await?;
    let sessions =
        sessions::list_channel_sessions(&state.db, bot_id, &channel_id.to_string()).await?;
    Ok(Json(json!({ "sessions": sessions })))
}

// ── POST /api/v1/channels/:channel_id/bots/:bot_id/sessions ──────────────────

/// Optional body for creating an "other" session. All fields default so a
/// body-less POST keeps working.
#[derive(Debug, Default, Deserialize)]
pub struct CreateSessionRequest {
    /// The session's primary working directory (ACP `cwd`). MUST be absolute.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Extra roots for the session's effective root set (ACP `additionalDirectories`).
    /// Each MUST be absolute.
    #[serde(default)]
    pub additional_dirs: Option<Vec<String>>,
}

/// Trim + validate an optional workspace `cwd`: empty ⇒ `None`; a non-empty value
/// MUST be absolute (ACP requirement). The connector re-validates against its
/// `allowed_roots`, so this is only a shape check, not an authorization check.
pub(crate) fn normalize_workspace_path(cwd: Option<String>) -> Result<Option<String>, AppError> {
    match cwd.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
        None => Ok(None),
        Some(path) if path.starts_with('/') => Ok(Some(path)),
        Some(path) => Err(AppError::BadRequest(format!(
            "cwd must be an absolute path, got {path:?}"
        ))),
    }
}

/// Normalize the `additional_dirs` list: trim, drop empties, require each to be
/// absolute, and de-duplicate (order-preserving).
pub(crate) fn normalize_additional_dirs(
    dirs: Option<Vec<String>>,
) -> Result<Vec<String>, AppError> {
    let mut out: Vec<String> = Vec::new();
    for raw in dirs.unwrap_or_default() {
        let path = raw.trim().to_string();
        if path.is_empty() {
            continue;
        }
        if !path.starts_with('/') {
            return Err(AppError::BadRequest(format!(
                "additional_dirs entries must be absolute paths, got {path:?}"
            )));
        }
        if !out.contains(&path) {
            out.push(path);
        }
    }
    Ok(out)
}

pub async fn create_session(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(Uuid, Uuid)>,
    body: Bytes,
) -> Result<Json<Value>, AppError> {
    let user_id = ensure_channel_member(&state, channel_id, &claims).await?;
    // Security: remote agent access requires 2FA when the instance is configured for it.
    two_factor::ensure_2fa_for_remote_agent_access(
        &state.db,
        &claims.sub,
        state.config.require_2fa_for_remote_agent_access,
    )
    .await?;
    let role = caller_role(&state, channel_id, user_id).await?;
    gate_initiate(
        &state,
        &claims,
        channel_id,
        bot_id,
        user_id,
        &role,
        "cheers/session_create",
    )
    .await?;

    // Optional per-session ACP root set. A body-less POST (the common "new session,
    // default cwd" case) is accepted as an empty request. `cwd` MUST be absolute
    // (ACP); paths are normalized here and re-validated against the connector's
    // allowed_roots at session start (Phase 2 adds an on-the-spot connector check).
    let req: CreateSessionRequest = if body.is_empty() {
        CreateSessionRequest::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|e| AppError::BadRequest(format!("invalid session body: {e}")))?
    };
    let cwd = normalize_workspace_path(req.cwd)?;
    let additional_dirs = normalize_additional_dirs(req.additional_dirs)?;
    // Phase 2: when a workdir is actually chosen, validate it on the spot against
    // the bot connector's policy (allowed_roots + backend_may_set_cwd + is-dir) and
    // store the connector-canonicalized paths. A default-cwd session needs no
    // round-trip.
    let (cwd, additional_dirs) = if cwd.is_some() || !additional_dirs.is_empty() {
        crate::api::workspace::validate_workspace_paths(&state, bot_id, cwd, additional_dirs)
            .await?
    } else {
        (cwd, additional_dirs)
    };

    let provider_account_id =
        crate::domain::messages::resolve_provider_account_id_for_bot(&state.db, bot_id)
            .await
            .unwrap_or_else(|_| bot_id.to_string());
    let handle = sessions::create_channel_session(
        &state.db,
        bot_id,
        &provider_account_id,
        &channel_id.to_string(),
        "other",
        cwd.as_deref(),
        &additional_dirs,
    )
    .await?;
    Ok(Json(json!({
        "session_id": handle.session_id.to_string(),
        "provider_session_key": handle.provider_session_key,
        "role": "other",
        "cwd": cwd,
        "additional_dirs": additional_dirs,
    })))
}

// ── DELETE /api/v1/channels/:channel_id/bots/:bot_id/sessions/:session_id ─────

pub async fn close_session(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id, session_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    let user_id = ensure_channel_member(&state, channel_id, &claims).await?;
    let role = caller_role(&state, channel_id, user_id).await?;
    gate_initiate(
        &state,
        &claims,
        channel_id,
        bot_id,
        user_id,
        &role,
        "cheers/session_close",
    )
    .await?;
    sessions::close_channel_session(&state.db, &channel_id.to_string(), session_id).await?;
    Ok(Json(
        json!({ "ok": true, "session_id": session_id.to_string() }),
    ))
}

// ── POST /api/v1/channels/:channel_id/bots/:bot_id/sessions/:session_id/primary ─

/// Promote an existing session to the channel's PRIMARY for this bot — the one
/// Auto/mention messages route to. The binding role is the source of truth
/// (domain::sessions::set_primary_session); the demoted session stays addressable
/// as an "other" session. Gated like session_create/close: owner-default +
/// grantable INITIATE, fail-closed.
pub async fn set_primary_session(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id, session_id)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    let user_id = ensure_channel_member(&state, channel_id, &claims).await?;
    let role = caller_role(&state, channel_id, user_id).await?;
    gate_initiate(
        &state,
        &claims,
        channel_id,
        bot_id,
        user_id,
        &role,
        "cheers/session_set_primary",
    )
    .await?;
    // Verify the session is live in this channel and belongs to this bot.
    let (sbot, _key) =
        sessions::resolve_channel_session(&state.db, &channel_id.to_string(), session_id).await?;
    if sbot != bot_id {
        return Err(AppError::BadRequest(
            "session does not belong to this bot".into(),
        ));
    }
    sessions::set_primary_session(&state.db, bot_id, &channel_id.to_string(), session_id).await?;
    Ok(Json(
        json!({ "ok": true, "session_id": session_id.to_string() }),
    ))
}

// ── Delegated session-scoped mode / config changes ───────────────────────────
// set_mode / set_config_option are OWNER-default but GRANTABLE per-subject: a
// channel member with an explicit INITIATE grant may change the mode/config of a
// session in THAT channel. The gate FAILS CLOSED (unlike prompt's fail-open).
// The connector re-clamps every value against its L0 envelope regardless.

/// The caller's channel role, fail-closed on a DB error.
async fn caller_role(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<String, AppError> {
    let role = sqlx::query(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .bind(user_id.to_string())
    .fetch_optional(&state.db)
    .await? // DB error → propagates (no silent 'member' fallback)
    .and_then(|r| r.try_get::<Option<String>, _>("role").ok().flatten())
    .unwrap_or_else(|| "member".to_string());
    Ok(role)
}

/// FAIL-CLOSED INITIATE gate for a session-config change.
async fn gate_initiate(
    state: &AppState,
    claims: &Claims,
    channel_id: Uuid,
    bot_id: Uuid,
    user_id: Uuid,
    role: &str,
    event_name: &str,
) -> Result<(), AppError> {
    // The bot owner / platform admin may always change session config — they own
    // the bot-level default too. Deny-default applies only to OTHER subjects, who
    // need an explicit INITIATE grant.
    if crate::api::bots::ensure_bot_owner_or_admin(state, claims, &bot_id.to_string())
        .await
        .is_ok()
    {
        return Ok(());
    }
    let allowed = acp_policy::allows(
        &state.db,
        &bot_id.to_string(),
        &channel_id.to_string(),
        &user_id.to_string(),
        role,
        event_name,
        Capability::Initiate,
    )
    .await
    .unwrap_or(false); // fail-closed: a rules/DB error denies the mutation
    if allowed {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "you are not authorized to change this agent's session config here".into(),
        ))
    }
}

/// The agent's advertised ACP config options (connector_control.options.options.configOptions),
/// plus a synthesized "model" option for agents that expose models only via the ACP
/// native model-state API (`models` + `session/set_model` — see
/// `connector_config::overlay_model_state`), minus the `mode` option for preset-backed
/// agents (mode is a first-class posture control, changed via set_mode — see
/// `connector_config::dedup_mode_config_options`).
async fn advertised_config_options(state: &AppState, bot_id: Uuid) -> Vec<Value> {
    let snapshot = sqlx::query("SELECT binding_config FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id.to_string())
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|r| {
            r.try_get::<Option<Value>, _>("binding_config")
                .ok()
                .flatten()
        })
        .and_then(|b| {
            b.get("connector_control")?
                .get("options")?
                .get("options")
                .cloned()
        })
        .unwrap_or_else(|| json!({}));
    let options = snapshot
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let options = connector_config::overlay_model_state(&snapshot, options);
    let agent_type = bot_agent_type(state, bot_id).await;
    connector_config::dedup_mode_config_options(&agent_type, options)
}

/// Merge a `session_config` override onto a session's metadata (read-merge-write).
async fn persist_session_override(
    state: &AppState,
    session_id: Uuid,
    set: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Result<(), AppError> {
    let meta = sqlx::query("SELECT metadata FROM cheers_sessions WHERE session_id = $1")
        .bind(session_id.to_string())
        .fetch_optional(&state.db)
        .await?
        .and_then(|r| r.try_get::<Option<Value>, _>("metadata").ok().flatten())
        .unwrap_or_else(|| json!({}));
    let mut sc = meta
        .get("session_config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    set(&mut sc);
    sqlx::query(
        "UPDATE cheers_sessions
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('session_config', $2::jsonb),
             updated_at = NOW()
         WHERE session_id = $1",
    )
    .bind(session_id.to_string())
    .bind(Value::Object(sc))
    .execute(&state.db)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct SetModeRequest {
    pub mode: String,
}

pub async fn set_session_mode(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id, session_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<SetModeRequest>,
) -> Result<Json<Value>, AppError> {
    let user_id = ensure_channel_member(&state, channel_id, &claims).await?;
    let role = caller_role(&state, channel_id, user_id).await?;
    gate_initiate(
        &state,
        &claims,
        channel_id,
        bot_id,
        user_id,
        &role,
        "session/set_mode",
    )
    .await?;

    let mode = body.mode.trim().to_string();
    if mode.is_empty() {
        return Err(AppError::BadRequest("mode required".into()));
    }
    // Fatal pre-validation against the agent's L0 allowed_modes (the connector
    // re-clamps via may_set_mode regardless; this is a friendly 400).
    let agent_type = bot_agent_type(&state, bot_id).await;
    let (_, allowed) = connector_config::posture_preset(&agent_type);
    if !allowed.is_empty() && !allowed.iter().any(|m| *m == mode) {
        return Err(AppError::BadRequest(format!(
            "mode {mode:?} is not in the allowed modes {allowed:?}"
        )));
    }
    // Verify the session is in this channel and resolve its resume key + bot.
    let (sbot, key) =
        sessions::resolve_channel_session(&state.db, &channel_id.to_string(), session_id).await?;
    if sbot != bot_id {
        return Err(AppError::BadRequest(
            "session does not belong to this bot".into(),
        ));
    }

    persist_session_override(&state, session_id, |sc| {
        sc.insert("permission_mode".into(), Value::String(mode.clone()));
    })
    .await?;

    let frame =
        crate::gateway::bridge_frames::mode_set_frame(&Uuid::new_v4().to_string(), &key, &mode);
    let delivered = state.bot_locator.dispatch_task(bot_id, frame).await;
    Ok(Json(
        json!({ "ok": true, "mode": mode, "delivered": delivered }),
    ))
}

#[derive(Deserialize)]
pub struct SetConfigOptionRequest {
    pub config_id: String,
    pub value: String,
}

pub async fn set_session_config_option(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id, session_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<SetConfigOptionRequest>,
) -> Result<Json<Value>, AppError> {
    let user_id = ensure_channel_member(&state, channel_id, &claims).await?;
    let role = caller_role(&state, channel_id, user_id).await?;
    gate_initiate(
        &state,
        &claims,
        channel_id,
        bot_id,
        user_id,
        &role,
        "session/set_config_option",
    )
    .await?;

    let config_id = body.config_id.trim().to_string();
    let value = body.value;
    if config_id.is_empty() {
        return Err(AppError::BadRequest("config_id required".into()));
    }
    // FATAL value validation: the connector's config_option_set checks only the
    // config id, never the value — so the gateway must reject unknown values.
    let advertised = advertised_config_options(&state, bot_id).await;
    if let Some(opt) = advertised
        .iter()
        .find(|o| o.get("id").and_then(Value::as_str) == Some(config_id.as_str()))
    {
        let ok = opt
            .get("options")
            .and_then(Value::as_array)
            .map(|vals| {
                vals.iter()
                    .any(|v| v.get("value").and_then(Value::as_str) == Some(value.as_str()))
            })
            .unwrap_or(false);
        if !ok {
            return Err(AppError::BadRequest(format!(
                "value {value:?} is not an allowed value for config option {config_id:?}"
            )));
        }
    } else if !advertised.is_empty() {
        return Err(AppError::BadRequest(format!(
            "config option {config_id:?} is not advertised by this agent"
        )));
    }
    let (sbot, key) =
        sessions::resolve_channel_session(&state.db, &channel_id.to_string(), session_id).await?;
    if sbot != bot_id {
        return Err(AppError::BadRequest(
            "session does not belong to this bot".into(),
        ));
    }

    persist_session_override(&state, session_id, |sc| {
        let mut opts = sc
            .get("config_options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        opts.insert(config_id.clone(), Value::String(value.clone()));
        sc.insert("config_options".into(), Value::Object(opts));
    })
    .await?;

    let frame = crate::gateway::bridge_frames::config_option_set_frame(
        &Uuid::new_v4().to_string(),
        &key,
        &config_id,
        &value,
    );
    let delivered = state.bot_locator.dispatch_task(bot_id, frame).await;
    Ok(Json(
        json!({ "ok": true, "config_id": config_id, "value": value, "delivered": delivered }),
    ))
}

#[derive(Deserialize)]
pub struct SetWorkspaceRequest {
    /// The new accessible-root set (ACP `additionalDirectories`). Replaces the whole
    /// list. Each MUST be absolute; `cwd` is immutable and NOT editable here.
    pub additional_dirs: Vec<String>,
}

/// PUT .../sessions/:session_id/workspace — edit a session's ACP
/// `additionalDirectories` (the mutable root-set lever;
/// docs/arch/SESSION_WORKDIR_ROOTSET.md). `cwd` is immutable, so only the extra
/// roots change; the new set takes effect on the session's next interaction (the
/// connector resends the full list at the next `session/new`/`load`). Gated like
/// set_config_option (owner-default + grantable); each dir is validated on the
/// spot against the bot connector's `allowed_roots`.
pub async fn set_session_workspace(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id, session_id)): Path<(Uuid, Uuid, Uuid)>,
    Json(body): Json<SetWorkspaceRequest>,
) -> Result<Json<Value>, AppError> {
    let user_id = ensure_channel_member(&state, channel_id, &claims).await?;
    let role = caller_role(&state, channel_id, user_id).await?;
    gate_initiate(
        &state,
        &claims,
        channel_id,
        bot_id,
        user_id,
        &role,
        "session/set_config_option",
    )
    .await?;

    let (sbot, _key) =
        sessions::resolve_channel_session(&state.db, &channel_id.to_string(), session_id).await?;
    if sbot != bot_id {
        return Err(AppError::BadRequest(
            "session does not belong to this bot".into(),
        ));
    }

    let additional_dirs = normalize_additional_dirs(Some(body.additional_dirs))?;
    // Validate each dir against the bot connector's policy; store canonical paths.
    let (_no_cwd, additional_dirs) =
        crate::api::workspace::validate_workspace_paths(&state, bot_id, None, additional_dirs)
            .await?;
    sessions::set_session_additional_dirs(&state.db, bot_id, session_id, &additional_dirs).await?;
    Ok(Json(
        json!({ "ok": true, "additional_dirs": additional_dirs }),
    ))
}

/// GET .../session-controls — the CALLER's resolved grants + the agent's
/// advertised vocabulary. Never leaks other subjects' rules.
pub async fn session_controls(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>, AppError> {
    let user_id = ensure_channel_member(&state, channel_id, &claims).await?;
    let role = caller_role(&state, channel_id, user_id).await?;
    // Bot owner / platform admin always have it (deny-default applies only to others).
    let privileged =
        crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id.to_string())
            .await
            .is_ok();
    let can_set_mode = privileged
        || acp_policy::allows(
            &state.db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &user_id.to_string(),
            &role,
            "session/set_mode",
            Capability::Initiate,
        )
        .await
        .unwrap_or(false);
    let can_set_config_option = privileged
        || acp_policy::allows(
            &state.db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &user_id.to_string(),
            &role,
            "session/set_config_option",
            Capability::Initiate,
        )
        .await
        .unwrap_or(false);
    let can_create_session = privileged
        || acp_policy::allows(
            &state.db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &user_id.to_string(),
            &role,
            "cheers/session_create",
            Capability::Initiate,
        )
        .await
        .unwrap_or(false);
    let can_close_session = privileged
        || acp_policy::allows(
            &state.db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &user_id.to_string(),
            &role,
            "cheers/session_close",
            Capability::Initiate,
        )
        .await
        .unwrap_or(false);
    let can_set_primary = privileged
        || acp_policy::allows(
            &state.db,
            &bot_id.to_string(),
            &channel_id.to_string(),
            &user_id.to_string(),
            &role,
            "cheers/session_set_primary",
            Capability::Initiate,
        )
        .await
        .unwrap_or(false);
    let agent_type = bot_agent_type(&state, bot_id).await;
    let (default_mode, allowed_modes) = connector_config::posture_preset(&agent_type);
    Ok(Json(json!({
        "can_set_mode": can_set_mode,
        "can_set_config_option": can_set_config_option,
        "can_create_session": can_create_session,
        "can_close_session": can_close_session,
        "can_set_primary": can_set_primary,
        "allowed_modes": allowed_modes,
        // The agent's preset mode — the session's effective mode when no per-session
        // override is set. Lets the UI show the current mode read-only even without a
        // set_mode grant. Per-session overrides come from each session's session_config.
        "current_mode": default_mode.unwrap_or(""),
        "config_options": advertised_config_options(&state, bot_id).await,
    })))
}

async fn bot_agent_type(state: &AppState, bot_id: Uuid) -> String {
    sqlx::query("SELECT bridge_provider FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id.to_string())
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .and_then(|r| {
            r.try_get::<Option<String>, _>("bridge_provider")
                .ok()
                .flatten()
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "generic".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_workspace_path_maps_empty_to_none() {
        assert_eq!(normalize_workspace_path(None).unwrap(), None);
        assert_eq!(normalize_workspace_path(Some("   ".into())).unwrap(), None);
    }

    #[test]
    fn normalize_workspace_path_trims_absolute() {
        assert_eq!(
            normalize_workspace_path(Some("  /repo/service  ".into())).unwrap(),
            Some("/repo/service".to_string())
        );
    }

    #[test]
    fn normalize_workspace_path_rejects_relative() {
        assert!(normalize_workspace_path(Some("repo/service".into())).is_err());
        assert!(normalize_workspace_path(Some("./x".into())).is_err());
    }

    #[test]
    fn normalize_additional_dirs_dedups_and_drops_empty() {
        let got = normalize_additional_dirs(Some(vec![
            "/a".into(),
            "  ".into(),
            "/b".into(),
            "/a".into(),
        ]))
        .unwrap();
        assert_eq!(got, vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn normalize_additional_dirs_rejects_relative_entry() {
        assert!(normalize_additional_dirs(Some(vec!["/a".into(), "rel".into()])).is_err());
    }
}
