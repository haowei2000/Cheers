//! Attach a session that started in another app (docs: SESSION_MODEL.md).
//!
//! The pasted string is parsed by the shared `session_ref` parser, routed to
//! the caller's online bots whose Agent can load that app's sessions, and
//! looked up by each connector in the Agent's own `session/list`; attach then
//! binds it to a new "other" session and has the connector `session/load` it.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use cheers_bridge_protocol as proto;
use cheers_bridge_protocol::session_ref::{
    parse_session_ref, AttachMode, SessionRef, SessionRefError, SessionSource,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    api::{middleware::Claims, session_control::ensure_channel_member},
    app_state::AppState,
    domain::{sessions, two_factor},
    errors::AppError,
    gateway::bridge_frames::runtime_session_control_frame,
};

/// `session/load` replays the whole history before answering, so a long
/// thread can take a while; past this the attach is abandoned and undone.
const ATTACH_ACK_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
pub struct ResolveSessionRequest {
    /// The pasted reference, e.g. `codex://threads/<uuid>`.
    #[serde(rename = "ref")]
    pub reference: String,
    /// Names the app for a bare id: the bot whose Agent the user means.
    #[serde(default)]
    pub bot_id: Option<Uuid>,
}

/// Sources a bot's connector advertised in `ready`
/// (`connector_control.capabilities.session_attach.sources`).
fn advertised_sources(binding_config: Option<&Value>) -> Vec<SessionSource> {
    binding_config
        .and_then(|config| config.pointer("/connector_control/capabilities/session_attach/sources"))
        .and_then(|sources| serde_json::from_value(sources.clone()).ok())
        .unwrap_or_default()
}

async fn bot_sources(state: &AppState, bot_id: &str) -> Result<Vec<SessionSource>, AppError> {
    let binding_config = sqlx::query!(
        "SELECT binding_config FROM bot_accounts WHERE bot_id = $1",
        bot_id,
    )
    .fetch_optional(&state.db)
    .await?
    .and_then(|row| row.binding_config);
    Ok(advertised_sources(binding_config.as_ref()))
}

/// Parse a pasted reference that must name a live (loadable) session.
fn live_reference(raw: &str, hint: Option<SessionSource>) -> Result<SessionRef, AppError> {
    let reference = parse_session_ref(raw, hint)
        .map_err(|error: SessionRefError| AppError::BadRequest(error.to_string()))?;
    if reference.mode == AttachMode::Import {
        return Err(AppError::BadRequest(
            "importing a transcript from this app is not supported yet".into(),
        ));
    }
    Ok(reference)
}

/// Ask `bot_id`'s connector to find `reference` in its Agent's session list.
async fn resolve_on_bot(
    state: &AppState,
    bot_id: Uuid,
    reference: &SessionRef,
) -> Result<Value, AppError> {
    crate::api::workspace::workspace_call(
        state,
        bot_id,
        "session_resolve",
        "",
        None,
        json!({ "session_ref": reference }),
        None,
        &[],
    )
    .await
}

// ── POST /api/v1/channels/:channel_id/sessions/resolve ─────────────────────────

/// Steps 1–4: parse the reference, pick the channel's online bots that the
/// caller owns and whose Agent can load that app's sessions (one active host
/// each), and ask each connector to find the session. Read-only: returns
/// metadata (cwd, title, last activity), never transcript content.
pub async fn resolve_session(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(channel_id): Path<Uuid>,
    Json(req): Json<ResolveSessionRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_member(&state, channel_id, &claims).await?;

    let hint = match req.bot_id {
        Some(bot_id) => bot_sources(&state, &bot_id.to_string())
            .await?
            .into_iter()
            .next(),
        None => None,
    };
    let reference = live_reference(&req.reference, hint)?;

    let rows = sqlx::query!(
        r#"SELECT b.bot_id, b.username, b.display_name, h.device_name AS "device_name?", h.host_id AS "host_id?"
         FROM channel_memberships m
         JOIN bot_accounts b ON b.bot_id = m.member_id
         LEFT JOIN connector_hosts h
                ON h.bot_id = b.bot_id
               AND h.status = 'active'
               AND h.revoked_at IS NULL
         WHERE m.channel_id = $1 AND m.member_type = 'bot'
         ORDER BY b.username"#,
        channel_id.to_string(),
    )
    .map(|row| (row.bot_id, row.username, row.display_name, row.device_name, row.host_id))
    .fetch_all(&state.db)
    .await
    .map_err(AppError::Db)?;

    let mut checked = 0usize;
    let mut matches = Vec::new();
    for (bot_id, username, display_name, device_name, host_id) in rows {
        let Ok(parsed) = Uuid::parse_str(&bot_id) else {
            continue;
        };
        if req.bot_id.is_some_and(|wanted| wanted != parsed) {
            continue;
        }
        // Attaching exposes everything the owner did in a terminal on that
        // machine, so only the bot's owner (or an admin) may look sessions up.
        if crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id)
            .await
            .is_err()
            || !state.bot_locator.is_online(parsed).await
            || !bot_sources(&state, &bot_id)
                .await?
                .contains(&reference.source)
        {
            continue;
        }
        checked += 1;
        match resolve_on_bot(&state, parsed, &reference).await {
            Ok(session) => matches.push(json!({
                "bot_id": bot_id,
                "username": username,
                "display_name": display_name,
                "host_id": host_id,
                "device_name": device_name,
                "session": session,
            })),
            Err(error) => {
                tracing::debug!(%bot_id, %error, "session_resolve found no match on this bot");
            }
        }
    }

    if checked == 0 {
        return Err(AppError::BadRequest(
            "none of your online bots in this channel can attach sessions from this app".into(),
        ));
    }
    if matches.is_empty() {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({
        "ref": reference,
        "created_at_ms": reference.created_at_ms(),
        "checked": checked,
        "matches": matches,
    })))
}

#[derive(Deserialize)]
pub struct AttachSessionRequest {
    /// The pasted reference, e.g. `codex://threads/<uuid>`.
    #[serde(rename = "ref")]
    pub reference: String,
}

// ── POST /api/v1/channels/:channel_id/bots/:bot_id/sessions/attach ─────────────

/// Step 5: re-resolve the reference on this bot (never trusting a client cwd),
/// create an "other" session, and have the connector bind and `session/load`
/// the Agent's existing session. Waits for the connector's ack; on any failure
/// the new session is closed, so an unattached session can never silently
/// start a fresh Agent context on its first message.
pub async fn attach_session(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((channel_id, bot_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<AttachSessionRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_channel_member(&state, channel_id, &claims).await?;
    two_factor::ensure_2fa_for_remote_agent_access(
        &state.db,
        &claims.sub,
        state.config.require_2fa_for_remote_agent_access,
    )
    .await?;
    // Owner-only, like the resolve candidates: the session holds whatever the
    // owner did on that machine.
    crate::api::bots::ensure_bot_owner_or_admin(&state, &claims, &bot_id.to_string()).await?;

    let sources = bot_sources(&state, &bot_id.to_string()).await?;
    let reference = live_reference(&req.reference, sources.first().copied())?;
    if !sources.contains(&reference.source) {
        return Err(AppError::BadRequest(
            "this bot's agent cannot attach sessions from that app".into(),
        ));
    }
    let found = resolve_on_bot(&state, bot_id, &reference).await?;
    if found.get("cwd_allowed").and_then(Value::as_bool) != Some(true) {
        let reason = found
            .get("cwd_error")
            .and_then(Value::as_str)
            .unwrap_or("the session's folder is not allowed on this host");
        return Err(AppError::BadRequest(format!(
            "cannot attach this session: {reason}"
        )));
    }
    let cwd = found
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let additional_dirs: Vec<String> = found
        .get("additional_directories")
        .and_then(Value::as_array)
        .map(|dirs| {
            dirs.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

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
        Some(&cwd),
        &additional_dirs,
    )
    .await?;
    let control_session = proto::RuntimeSessionControlSession {
        id: handle.session_id.to_string(),
        provider_session_key: handle.provider_session_key.clone(),
        primary_scope_type: Some(sessions::SESSION_SCOPE_CHANNEL.to_string()),
        primary_scope_id: Some(channel_id.to_string()),
        task_scope_id: None,
        cwd: Some(cwd.clone()),
        additional_dirs: additional_dirs.clone(),
        session_config: None,
        provider_session_id: Some(reference.native_id.clone()),
        extra: Default::default(),
    };

    let request_id = Uuid::new_v4().to_string();
    let ack_rx = state.session_control_acks.register(request_id.clone());
    let frame = runtime_session_control_frame(&request_id, "attach", control_session.clone(), None);
    let ack = if state.bot_locator.dispatch_task(bot_id, frame).await {
        tokio::time::timeout(ATTACH_ACK_TIMEOUT, ack_rx)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    state.session_control_acks.cancel(&request_id);

    if ack
        .as_ref()
        .and_then(|ack| ack.get("ok"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        if ack.is_none() {
            // A late success would still bind the connector's key; terminate
            // queues behind the attach on the connector's control loop.
            let terminate = runtime_session_control_frame(
                &Uuid::new_v4().to_string(),
                "terminate",
                control_session,
                Some("attach timed out"),
            );
            state.bot_locator.dispatch_task(bot_id, terminate).await;
        }
        sessions::close_channel_session(&state.db, &channel_id.to_string(), handle.session_id)
            .await?;
        let reason = ack
            .as_ref()
            .and_then(|ack| ack.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("the connector did not confirm the attach in time");
        return Err(AppError::BadRequest(format!(
            "could not attach the session: {reason}"
        )));
    }

    Ok(Json(json!({
        "session_id": handle.session_id.to_string(),
        "provider_session_key": handle.provider_session_key,
        "provider_session_id": reference.native_id,
        "role": "other",
        "cwd": cwd,
        "additional_dirs": additional_dirs,
        "title": found.get("title").cloned().unwrap_or(Value::Null),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_sources_reads_the_ready_capability() {
        let config = json!({"connector_control": {"capabilities": {
            "session_attach": {"sources": ["codex", "claude_code"]}
        }}});
        assert_eq!(
            advertised_sources(Some(&config)),
            vec![SessionSource::Codex, SessionSource::ClaudeCode]
        );
        // Older connectors advertise nothing: never a candidate.
        assert!(advertised_sources(Some(&json!({}))).is_empty());
        assert!(advertised_sources(None).is_empty());
    }
}
