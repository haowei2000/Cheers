use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::{
        messages::{self, CreateMessageParams},
        two_factor,
    },
    errors::AppError,
    gateway::realtime::frame::WireFrame,
    infra::crypto::{generate_bot_token, hash_bot_token},
};

#[derive(Deserialize)]
pub struct BotAcpSecurityConfig {
    pub enabled: bool,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub algorithm: Option<String>,
    #[serde(default)]
    pub allow_plaintext_fallback: Option<bool>,
    #[serde(default)]
    pub require_capability: Option<bool>,
}

#[derive(Deserialize)]
pub struct BotCreateRequest {
    pub username: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub model_id: Option<String>,
    pub template_id: Option<String>,
    pub custom_system_prompt: Option<String>,
    pub scope: Option<String>,
    pub intro: Option<String>,
    pub avatar_url: Option<String>,
    pub binding_type: Option<String>,
    pub bridge_provider: Option<String>,
    pub binding_config: Option<Value>,
    pub acp_security: Option<BotAcpSecurityConfig>,
    #[serde(default)]
    pub external_processor: bool,
    pub processor_name: Option<String>,
    pub processor_privacy_url: Option<String>,
    pub processor_data_use: Option<String>,
    pub processor_policy_version: Option<String>,
}

/// Per-user cap on bot creation for non-admins (resource-abuse bound, audit H1).
const MAX_BOTS_PER_USER: i64 = 50;

pub(crate) fn is_admin(claims: &Claims) -> bool {
    matches!(claims.role.as_str(), "system_admin" | "admin")
}

/// Fetch a bot's `created_by` owner; NotFound if the bot doesn't exist.
async fn bot_owner(state: &AppState, bot_id: &str) -> Result<Option<String>, AppError> {
    let row = sqlx::query("SELECT created_by FROM bot_accounts WHERE bot_id = $1")
        .bind(bot_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(row
        .try_get::<Option<String>, _>("created_by")
        .ok()
        .flatten())
}

/// Authorize a privileged bot op (issue token, edit/delete): admin or the bot's
/// creator. A legacy bot with `created_by = NULL` is admin-only (never matches a
/// caller), so consolidating callers onto this helper can't open an authz bypass.
pub(crate) async fn ensure_bot_owner_or_admin(
    state: &AppState,
    claims: &Claims,
    bot_id: &str,
) -> Result<(), AppError> {
    let owner = bot_owner(state, bot_id).await?;
    if is_admin(claims) || owner.as_deref() == Some(claims.sub.as_str()) {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "only the bot owner or an admin may do this".into(),
        ))
    }
}

/// Whether `claims` may see a bot: admin, owner, or a member of a channel the
/// bot is in. Gates non-destructive reads (status/test). Returns NotFound for
/// both missing and forbidden so it isn't an existence oracle.
async fn ensure_bot_visible(
    state: &AppState,
    claims: &Claims,
    bot_id: &str,
) -> Result<(), AppError> {
    if is_admin(claims) {
        bot_owner(state, bot_id).await?; // existence → correct 404
        return Ok(());
    }
    let visible: bool = sqlx::query(
        "SELECT EXISTS(
            SELECT 1 FROM bot_accounts b
            WHERE b.bot_id = $1 AND (
                b.created_by = $2
                OR EXISTS (
                    SELECT 1 FROM channel_memberships bcm
                    JOIN channel_memberships ucm ON ucm.channel_id = bcm.channel_id
                    WHERE bcm.member_id = b.bot_id AND bcm.member_type = 'bot'
                      AND ucm.member_id = $2 AND ucm.member_type = 'user'
                )
            )
        ) AS ok",
    )
    .bind(bot_id)
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?
    .try_get("ok")
    .unwrap_or(false);
    if visible {
        Ok(())
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn list_bots(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Value>>, AppError> {
    // IDOR fix (audit H2): scope to bots the caller owns or shares a channel
    // with (admins see all). binding_config (connector wiring) is redacted for
    // non-owners even when the bot is visible via a shared channel.
    let admin = is_admin(&claims);
    let rows = sqlx::query(
        "SELECT bot_id, username, display_name, description, avatar_url, is_disabled, scope,
                binding_type, bridge_provider, model_id, template_id, intro, binding_config,
                created_by, status_text, status_emoji, status_updated_at,
                status_auto_update, status_update_prompt, status_update_interval_minutes,
                external_processor, processor_name, processor_privacy_url,
                processor_data_use, processor_policy_version
         FROM bot_accounts b
         WHERE $1
            OR b.created_by = $2
            OR EXISTS (
                SELECT 1 FROM channel_memberships bcm
                JOIN channel_memberships ucm ON ucm.channel_id = bcm.channel_id
                WHERE bcm.member_id = b.bot_id AND bcm.member_type = 'bot'
                  AND ucm.member_id = $2 AND ucm.member_type = 'user'
            )
         ORDER BY username",
    )
    .bind(admin)
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;
    let mut bots = Vec::with_capacity(rows.len());
    for r in rows {
        let created_by = r.try_get::<Option<String>, _>("created_by").ok().flatten();
        let is_owner = created_by.as_deref() == Some(claims.sub.as_str());
        let can_manage = admin || is_owner;
        let binding_config = if can_manage {
            r.try_get::<Value, _>("binding_config").ok()
        } else {
            None
        };
        // The auto-update prompt/config is only meaningful to a manager, and the
        // prompt may embed private instructions — redact for channel-mates.
        let status_update_prompt = if can_manage {
            r.try_get::<Option<String>, _>("status_update_prompt")
                .ok()
                .flatten()
        } else {
            None
        };
        // LIVE connectivity from the connection registry — the only honest "online"
        // signal. `status` is a persisted enable flag that's set 'online' at creation
        // and never flipped, so it can't tell a connected bot from a dead one. All
        // bots dispatch through the WS bridge (see gateway::dispatcher), so the
        // registry is authoritative for every binding type.
        let bot_id = r.try_get::<String, _>("bot_id").unwrap_or_default();
        let is_online = match Uuid::parse_str(&bot_id) {
            Ok(id) => state.bot_locator.is_online(id).await,
            Err(_) => false,
        };
        bots.push(json!({
            "bot_id": bot_id,
            "username": r.try_get::<String, _>("username").unwrap_or_default(),
            "display_name": r.try_get::<String, _>("display_name").ok(),
            "description": r.try_get::<String, _>("description").ok(),
            "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
            "is_disabled": r.try_get::<bool, _>("is_disabled").unwrap_or(false),
            "can_manage": can_manage,
            "is_online": is_online,
            "status_text": r.try_get::<Option<String>, _>("status_text").ok().flatten(),
            "status_emoji": r.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
            "status_updated_at": r
                .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("status_updated_at")
                .ok()
                .flatten()
                .map(|t| t.to_rfc3339()),
            "status_auto_update": r.try_get::<bool, _>("status_auto_update").unwrap_or(false),
            "status_update_interval_minutes": r
                .try_get::<Option<i32>, _>("status_update_interval_minutes")
                .ok()
                .flatten(),
            "status_update_prompt": status_update_prompt,
            "scope": r.try_get::<String, _>("scope").unwrap_or_else(|_| "friend".into()),
            "binding_type": r.try_get::<String, _>("binding_type").unwrap_or_else(|_| "http".into()),
            "bridge_provider": r.try_get::<String, _>("bridge_provider").unwrap_or_else(|_| "generic".into()),
            "model_id": r.try_get::<String, _>("model_id").ok(),
            "template_id": r.try_get::<String, _>("template_id").ok(),
            "intro": r.try_get::<String, _>("intro").ok(),
            "binding_config": binding_config,
            "external_processor": r.try_get::<bool, _>("external_processor").unwrap_or(false),
            "processor_name": r.try_get::<Option<String>, _>("processor_name").ok().flatten(),
            "processor_privacy_url": r.try_get::<Option<String>, _>("processor_privacy_url").ok().flatten(),
            "processor_data_use": r.try_get::<Option<String>, _>("processor_data_use").ok().flatten(),
            "processor_policy_version": r.try_get::<String, _>("processor_policy_version").unwrap_or_else(|_| "1".into()),
        }));
    }
    Ok(Json(bots))
}

pub async fn create_bot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<BotCreateRequest>,
) -> Result<Json<Value>, AppError> {
    if body.username.trim().is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }
    if body.external_processor {
        let valid_url = body
            .processor_privacy_url
            .as_deref()
            .and_then(|value| reqwest::Url::parse(value).ok())
            .is_some_and(|url| url.scheme() == "https");
        if body
            .processor_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
            || body
                .processor_data_use
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .is_none()
            || !valid_url
        {
            return Err(AppError::BadRequest(
                "external processors require a provider name, data-use disclosure, and HTTPS privacy URL".into(),
            ));
        }
    }
    // Security: remote agent creation requires 2FA when the instance is configured for it.
    two_factor::ensure_2fa_for_remote_agent_access(
        &state.db,
        &claims.sub,
        state.config.require_2fa_for_remote_agent_access,
    )
    .await?;
    // Resource-abuse bound (audit H1): cap how many bots a non-admin can own.
    if !is_admin(&claims) {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM bot_accounts WHERE created_by = $1")
                .bind(&claims.sub)
                .fetch_one(&state.db)
                .await?;
        if count >= MAX_BOTS_PER_USER {
            return Err(AppError::Forbidden(format!(
                "bot limit reached ({MAX_BOTS_PER_USER} per user)"
            )));
        }
    }
    let binding_config = normalize_binding_config(body.binding_config, body.acp_security)?;
    // Always server-generate the id (audit H1): a client-supplied bot_id allowed
    // ID squatting and collision-as-existence-oracle.
    let bot_id = Uuid::new_v4().to_string();
    let scope = body.scope.unwrap_or_else(|| "friend".into());
    let binding_type = body.binding_type.unwrap_or_else(|| "http".into());
    let bridge_provider = body.bridge_provider.unwrap_or_else(|| "generic".into());
    let row = sqlx::query(
        "INSERT INTO bot_accounts
         (bot_id, username, display_name, description, avatar_url, model_id, template_id,
             custom_system_prompt, scope, intro, binding_type, bridge_provider,
             binding_config, created_by, external_processor, processor_name,
             processor_privacy_url, processor_data_use, processor_policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING bot_id, username, display_name, description, avatar_url, is_disabled, scope,
                   binding_type, bridge_provider, model_id, template_id, intro, binding_config,
                   external_processor, processor_name, processor_privacy_url, processor_data_use, processor_policy_version",
    )
    .bind(&bot_id)
    .bind(body.username.trim())
    .bind(body.display_name)
    .bind(body.description)
    .bind(body.avatar_url)
    .bind(body.model_id)
    .bind(body.template_id)
    .bind(body.custom_system_prompt)
    .bind(scope)
    .bind(body.intro)
    .bind(binding_type)
    .bind(bridge_provider)
    .bind(binding_config)
    .bind(&claims.sub)
    .bind(body.external_processor)
    .bind(body.processor_name)
    .bind(body.processor_privacy_url)
    .bind(body.processor_data_use)
    .bind(body.processor_policy_version.unwrap_or_else(|| "1".into()))
    .fetch_one(&state.db)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(de) if de.is_unique_violation() => AppError::Conflict(format!(
            "bot username '{}' is already taken — choose another name, or switch to Existing bot",
            body.username.trim()
        )),
        _ => AppError::Db(e),
    })?;
    Ok(Json(json!({
        "bot_id": row.try_get::<String, _>("bot_id").unwrap_or_default(),
        "username": row.try_get::<String, _>("username").unwrap_or_default(),
        "display_name": row.try_get::<String, _>("display_name").ok(),
        "description": row.try_get::<String, _>("description").ok(),
        "avatar_url": row.try_get::<String, _>("avatar_url").ok(),
        "is_disabled": row.try_get::<bool, _>("is_disabled").unwrap_or(false),
        "can_manage": true,
        "scope": row.try_get::<String, _>("scope").unwrap_or_else(|_| "friend".into()),
        "binding_type": row.try_get::<String, _>("binding_type").unwrap_or_else(|_| "http".into()),
        "bridge_provider": row.try_get::<String, _>("bridge_provider").unwrap_or_else(|_| "generic".into()),
        "model_id": row.try_get::<String, _>("model_id").ok(),
        "template_id": row.try_get::<String, _>("template_id").ok(),
        "intro": row.try_get::<String, _>("intro").ok(),
        "binding_config": row.try_get::<Value, _>("binding_config").ok(),
        "external_processor": row.try_get::<bool, _>("external_processor").unwrap_or(false),
        "processor_name": row.try_get::<Option<String>, _>("processor_name").ok().flatten(),
        "processor_privacy_url": row.try_get::<Option<String>, _>("processor_privacy_url").ok().flatten(),
        "processor_data_use": row.try_get::<Option<String>, _>("processor_data_use").ok().flatten(),
        "processor_policy_version": row.try_get::<String, _>("processor_policy_version").unwrap_or_else(|_| "1".into()),
    })))
}

fn normalize_binding_config(
    binding_config: Option<Value>,
    acp_security: Option<BotAcpSecurityConfig>,
) -> Result<Option<Value>, AppError> {
    let mut merged = match binding_config {
        Some(Value::Object(map)) => map,
        Some(Value::Null) => Map::new(),
        Some(_) => {
            return Err(AppError::BadRequest(
                "binding_config must be a JSON object".into(),
            ));
        }
        None => Map::new(),
    };

    if let Some(sec) = acp_security {
        let algorithm = sec.algorithm.unwrap_or_else(|| "AES-256-GCM".into());
        let mode = sec.mode.unwrap_or_else(|| "X25519-ECDH".into());
        let mut sec_obj = Map::new();
        sec_obj.insert("enabled".into(), Value::Bool(sec.enabled));
        sec_obj.insert("mode".into(), Value::String(mode));
        sec_obj.insert("algorithm".into(), Value::String(algorithm));

        if let Some(allow_plaintext_fallback) = sec.allow_plaintext_fallback {
            sec_obj.insert(
                "allow_plaintext_fallback".into(),
                Value::Bool(allow_plaintext_fallback),
            );
        }

        sec_obj.insert(
            "require_capability".into(),
            Value::Bool(sec.require_capability.unwrap_or(false)),
        );

        merged.insert("acp_security".into(), Value::Object(sec_obj));
    }

    if merged.is_empty() {
        return Ok(None);
    }

    Ok(Some(Value::Object(merged)))
}

pub async fn get_bot_status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_visible(&state, &claims, &bot_id).await?;
    let row = sqlx::query(
        "SELECT bot_id, is_disabled, binding_type, created_by,
                status_text, status_emoji, status_updated_at,
                binding_config->'connector_control'->>'connector_version' AS connector_version
         FROM bot_accounts WHERE bot_id = $1",
    )
    .bind(&bot_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let is_disabled: bool = row.try_get("is_disabled").unwrap_or(false);

    // bridge_connected is the LIVE truth from the connection registry (a control
    // + data WS are bound right now), distinct from the persisted `status` flag.
    // A bot can be status="online" (eligible to connect) yet have no live bridge.
    let bridge_connected = match Uuid::parse_str(&bot_id) {
        Ok(id) => state.bot_locator.is_online(id).await,
        Err(_) => false,
    };

    // Live enrollment-code count is owner/admin-only: it reveals pending onboarding
    // secrets' existence, which a channel-mate (visible-but-not-owner) shouldn't see.
    let owner = row
        .try_get::<Option<String>, _>("created_by")
        .ok()
        .flatten();
    let is_owner_or_admin = is_admin(&claims) || owner.as_deref() == Some(claims.sub.as_str());
    let live_codes: Option<i64> = if is_owner_or_admin {
        Some(
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM enrollment_codes
                 WHERE bot_id = $1 AND redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()",
            )
            .bind(&bot_id)
            .fetch_one(&state.db)
            .await?,
        )
    } else {
        None
    };

    // Recent control-bridge history: when the connector last attached/detached.
    // Complements the live flag with a minimal timeline anchor (full history via
    // GET /bots/:bot_id/connection-events).
    let (last_connected_at, last_disconnected_at) = sqlx::query_as::<
        _,
        (
            Option<chrono::DateTime<chrono::Utc>>,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        "SELECT MAX(created_at) FILTER (WHERE event = 'connected'),
                MAX(created_at) FILTER (WHERE event = 'disconnected')
         FROM bot_connection_events
         WHERE bot_id = $1 AND stream = 'control'",
    )
    .bind(&bot_id)
    .fetch_one(&state.db)
    .await?;

    // Version pair for the settings UI: what the connector reported at its last
    // `ready` vs. the release this gateway serves. `update_available` only turns
    // true on a strict semver-triple increase, so a pinned-back gateway doesn't
    // nag newer connectors to "update" downward.
    let connector_version = row
        .try_get::<Option<String>, _>("connector_version")
        .ok()
        .flatten();
    let latest_version = state.config.connector_release_version.clone();
    let update_available = match (connector_version.as_deref(), latest_version.as_deref()) {
        (Some(cur), Some(latest)) => version_is_newer(latest, cur),
        _ => false,
    };

    Ok(Json(json!({
        "bot_id": row.try_get::<String, _>("bot_id").unwrap_or(bot_id),
        "is_disabled": is_disabled,
        "binding_type": row.try_get::<String, _>("binding_type").unwrap_or_else(|_| "http".into()),
        // `connection_status`/`is_online` are LIVE (bridge bound right now); `is_disabled`
        // is the separate admin enable flag. Don't conflate them — a bot can be enabled
        // yet have no live connector.
        "connection_status": if bridge_connected { "online" } else { "offline" },
        "is_online": bridge_connected,
        "bridge_connected": bridge_connected,
        "last_connected_at": last_connected_at.map(|t| t.to_rfc3339()),
        "last_disconnected_at": last_disconnected_at.map(|t| t.to_rfc3339()),
        "live_enrollment_codes": live_codes,
        "connector_version": connector_version,
        "latest_connector_version": latest_version,
        "update_available": update_available,
        "status_text": row.try_get::<Option<String>, _>("status_text").ok().flatten(),
        "status_emoji": row.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
        "status_updated_at": row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("status_updated_at")
            .ok()
            .flatten()
            .map(|t| t.to_rfc3339()),
    })))
}

#[derive(Deserialize)]
pub struct ConnectionEventsQuery {
    pub limit: Option<i64>,
}

/// GET /api/v1/bots/{bot_id}/connection-events — recent bridge connect/disconnect
/// history (newest first). Presence frames only carry the current state; this is
/// the persisted timeline behind it, including WHY a connector went away
/// (closed / superseded / idle_timeout / protocol_error / write_failed / unbound).
pub async fn list_connection_events(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Query(params): Query<ConnectionEventsQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_visible(&state, &claims, &bot_id).await?;
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let rows = sqlx::query(
        "SELECT stream, event, reason, connection_id, created_at
         FROM bot_connection_events
         WHERE bot_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2",
    )
    .bind(&bot_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let events: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "stream": r.try_get::<String, _>("stream").unwrap_or_default(),
                "event": r.try_get::<String, _>("event").unwrap_or_default(),
                "reason": r.try_get::<Option<String>, _>("reason").ok().flatten(),
                "connection_id": r.try_get::<Option<String>, _>("connection_id").ok().flatten(),
                "created_at": r
                    .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({ "bot_id": bot_id, "events": events })))
}

/// POST /api/v1/bots/{bot_id}/disable — admin/owner kill-switch. Sets is_disabled
/// and kicks any live connector (closes its bridge); the connect gate then blocks
/// reconnect until re-enabled.
pub async fn disable_bot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    set_bot_disabled(&state, &claims, &bot_id, true).await
}

/// POST /api/v1/bots/{bot_id}/enable — lift a disable (admin/owner).
pub async fn enable_bot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    set_bot_disabled(&state, &claims, &bot_id, false).await
}

async fn set_bot_disabled(
    state: &AppState,
    claims: &Claims,
    bot_id: &str,
    disabled: bool,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(state, claims, bot_id).await?;
    let res = sqlx::query("UPDATE bot_accounts SET is_disabled = $2 WHERE bot_id = $1")
        .bind(bot_id)
        .bind(disabled)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    // Disabling must take effect now: drop the live session so the connector is
    // disconnected and no further tasks dispatch (the connect gate blocks reconnect).
    if disabled {
        if let Ok(id) = Uuid::parse_str(bot_id) {
            state.bot_registry.kick(id);
        }
    }
    Ok(Json(json!({ "bot_id": bot_id, "is_disabled": disabled })))
}

/// DELETE /api/v1/bots/{bot_id} — hard-delete a bot (admin/owner). Kicks the live
/// connector, removes its channel memberships, and deletes the account row; FK
/// `ON DELETE CASCADE` clears its sessions/bindings, enrollment codes, permission
/// rules, approvals, capability delegations and event-access rules. Irreversible.
pub async fn delete_bot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    // Disconnect the live connector first so nothing dispatches mid-delete.
    if let Ok(id) = Uuid::parse_str(&bot_id) {
        state.bot_registry.kick(id);
    }
    let mut tx = state.db.begin().await?;
    // channel_memberships.member_id has no FK (generic user|bot id) → delete by hand.
    sqlx::query("DELETE FROM channel_memberships WHERE member_id = $1 AND member_type = 'bot'")
        .bind(&bot_id)
        .execute(&mut *tx)
        .await?;
    let res = sqlx::query("DELETE FROM bot_accounts WHERE bot_id = $1")
        .bind(&bot_id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    tx.commit().await?;
    Ok(Json(json!({ "bot_id": bot_id, "deleted": true })))
}

pub async fn test_bot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_visible(&state, &claims, &bot_id).await?;
    let exists = sqlx::query("SELECT EXISTS(SELECT 1 FROM bot_accounts WHERE bot_id = $1) AS ok")
        .bind(&bot_id)
        .fetch_one(&state.db)
        .await?
        .try_get::<bool, _>("ok")
        .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound);
    }
    Ok(Json(
        json!({"bot_id": bot_id, "ok": true, "message": "bot configuration is readable"}),
    ))
}

/// Mint (or rotate) a bot's Agent Bridge token. Returns `(plaintext, prefix)`;
/// only the SHA-256 is persisted, and the control/data WS authenticates by
/// matching that hash. This is the **single** token-mint path — `issue_bot_token`
/// (manual rotate) and `enrollment::redeem` (one-time onboarding) both call here
/// so a rotated token can never come from two divergent code paths. Authorization
/// is the caller's responsibility (see `ensure_bot_owner_or_admin` / the
/// single-use enrollment code). NotFound if the bot row is gone.
pub async fn mint_bot_token(state: &AppState, bot_id: &str) -> Result<(String, String), AppError> {
    let token = generate_bot_token();
    let token_hash = hash_bot_token(&token);
    let token_prefix = token[..token.len().min(12)].to_string();

    let updated = sqlx::query(
        "UPDATE bot_accounts
         SET bot_token_hash = $1, bot_token_prefix = $2, bot_token_rotated_at = NOW()
         WHERE bot_id = $3",
    )
    .bind(&token_hash)
    .bind(&token_prefix)
    .bind(bot_id)
    .execute(&state.db)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    // Rotation revokes the OLD token NOW: kick any live connector that
    // authenticated with it (same seam as the disable kill-switch), forcing a
    // reconnect that the connect gate only accepts with the new token. No-op
    // when the bot has no live session (e.g. first mint via enrollment).
    if let Ok(id) = Uuid::parse_str(bot_id) {
        state.bot_registry.kick(id);
    }
    Ok((token, token_prefix))
}

/// POST /api/v1/bots/{bot_id}/token — issue (or rotate) the bot's Agent Bridge
/// token. The plaintext is returned **once**; only its SHA-256 is persisted, and
/// the Agent Bridge control/data WS authenticates by matching that hash.
pub async fn issue_bot_token(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    // The token grants the connector authority to act as this bot, so only the
    // bot's creator or an admin may issue/rotate it.
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;

    let (token, token_prefix) = mint_bot_token(&state, &bot_id).await?;

    Ok(Json(json!({
        "bot_id": bot_id,
        "token": token,
        "token_prefix": token_prefix,
        "note": "Store this token now — it is shown only once and replaces any previous token.",
    })))
}

// ── Status + information (identity metadata a manager or the bot itself edits) ──

/// One patch field: absent (leave unchanged) vs present (set; empty string → NULL).
/// Reading the raw JSON object lets an omitted key differ from an explicit `null`.
struct BotPatchField {
    provided: bool,
    value: Option<String>,
}

impl BotPatchField {
    fn read(obj: &Map<String, Value>, key: &str) -> Self {
        match obj.get(key) {
            Some(v) => BotPatchField {
                provided: true,
                value: v
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            },
            None => BotPatchField {
                provided: false,
                value: None,
            },
        }
    }
}

/// PATCH /api/v1/bots/{bot_id}/profile — the bot's manager (owner/admin) edits its
/// identity + status + scheduled-self-update config. Every field is optional;
/// omitted keys are untouched, empty strings clear to NULL. Distinct from
/// self-status (which the bot writes with its own token): this is the human editing
/// the bot, including turning the auto-refresh schedule on/off and its prompt.
pub async fn update_bot_profile(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let obj = body
        .as_object()
        .ok_or_else(|| AppError::BadRequest("request body must be a JSON object".into()))?;

    let display_name = BotPatchField::read(obj, "display_name");
    let description = BotPatchField::read(obj, "description");
    let intro = BotPatchField::read(obj, "intro");
    let status_text = BotPatchField::read(obj, "status_text");
    let status_emoji = BotPatchField::read(obj, "status_emoji");
    let status_prompt = BotPatchField::read(obj, "status_update_prompt");
    let processor_name = BotPatchField::read(obj, "processor_name");
    let processor_privacy_url = BotPatchField::read(obj, "processor_privacy_url");
    let processor_data_use = BotPatchField::read(obj, "processor_data_use");
    let processor_policy_version = BotPatchField::read(obj, "processor_policy_version");
    let external_processor_provided = obj.contains_key("external_processor");
    let external_processor = obj
        .get("external_processor")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if external_processor_provided && external_processor {
        let valid_url = processor_privacy_url
            .value
            .as_deref()
            .and_then(|value| reqwest::Url::parse(value).ok())
            .is_some_and(|url| url.scheme() == "https");
        if processor_name.value.is_none() || processor_data_use.value.is_none() || !valid_url {
            return Err(AppError::BadRequest(
                "external processors require a provider name, data-use disclosure, and HTTPS privacy URL".into(),
            ));
        }
    }

    if status_text
        .value
        .as_deref()
        .is_some_and(|s| s.chars().count() > 140)
    {
        return Err(AppError::BadRequest(
            "status_text too long (≤140 chars)".into(),
        ));
    }
    if status_emoji
        .value
        .as_deref()
        .is_some_and(|s| s.chars().count() > 32)
    {
        return Err(AppError::BadRequest("status_emoji too long".into()));
    }

    // Schedule toggles: auto_update (bool) + interval (minutes, clamped sane).
    let auto_update_provided = obj.contains_key("status_auto_update");
    let auto_update = obj
        .get("status_auto_update")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let interval_provided = obj.contains_key("status_update_interval_minutes");
    let interval: Option<i32> = match obj.get("status_update_interval_minutes") {
        Some(Value::Null) | None => None,
        Some(v) => {
            let n = v
                .as_i64()
                .ok_or_else(|| AppError::BadRequest("interval must be an integer".into()))?;
            // Floor at 5 min so a runaway schedule can't hammer the agent; cap at a week.
            Some(n.clamp(5, 10_080) as i32)
        }
    };
    // Guard against enabling a schedule with no prompt to run.
    if auto_update_provided && auto_update {
        let has_prompt = status_prompt.value.is_some()
            || (!status_prompt.provided
                && sqlx::query_scalar::<_, Option<String>>(
                    "SELECT status_update_prompt FROM bot_accounts WHERE bot_id = $1",
                )
                .bind(&bot_id)
                .fetch_optional(&state.db)
                .await?
                .flatten()
                .is_some());
        if !has_prompt {
            return Err(AppError::BadRequest(
                "status_update_prompt is required to enable scheduled self-update".into(),
            ));
        }
    }

    let touched_status = status_text.provided || status_emoji.provided;

    let res = sqlx::query(
        "UPDATE bot_accounts SET
            display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
            description  = CASE WHEN $4 THEN $5 ELSE description END,
            intro        = CASE WHEN $6 THEN $7 ELSE intro END,
            status_text  = CASE WHEN $8 THEN $9 ELSE status_text END,
            status_emoji = CASE WHEN $10 THEN $11 ELSE status_emoji END,
            status_updated_at = CASE WHEN $12 THEN NOW() ELSE status_updated_at END,
            status_auto_update = CASE WHEN $13 THEN $14 ELSE status_auto_update END,
            status_update_prompt = CASE WHEN $15 THEN $16 ELSE status_update_prompt END,
            status_update_interval_minutes = CASE WHEN $17 THEN $18 ELSE status_update_interval_minutes END,
            external_processor = CASE WHEN $19 THEN $20 ELSE external_processor END,
            processor_name = CASE WHEN $21 THEN $22 ELSE processor_name END,
            processor_privacy_url = CASE WHEN $23 THEN $24 ELSE processor_privacy_url END,
            processor_data_use = CASE WHEN $25 THEN $26 ELSE processor_data_use END,
            processor_policy_version = CASE WHEN $27 THEN $28 ELSE processor_policy_version END
         WHERE bot_id = $1",
    )
    .bind(&bot_id)
    .bind(display_name.provided)
    .bind(&display_name.value)
    .bind(description.provided)
    .bind(&description.value)
    .bind(intro.provided)
    .bind(&intro.value)
    .bind(status_text.provided)
    .bind(&status_text.value)
    .bind(status_emoji.provided)
    .bind(&status_emoji.value)
    .bind(touched_status)
    .bind(auto_update_provided)
    .bind(auto_update)
    .bind(status_prompt.provided)
    .bind(&status_prompt.value)
    .bind(interval_provided)
    .bind(interval)
    .bind(external_processor_provided)
    .bind(external_processor)
    .bind(processor_name.provided)
    .bind(&processor_name.value)
    .bind(processor_privacy_url.provided)
    .bind(&processor_privacy_url.value)
    .bind(processor_data_use.provided)
    .bind(&processor_data_use.value)
    .bind(processor_policy_version.provided)
    .bind(&processor_policy_version.value)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "bot_id": bot_id, "updated": true })))
}

#[derive(Deserialize)]
pub struct BotSelfStatusRequest {
    #[serde(default)]
    pub status_text: Option<String>,
    #[serde(default)]
    pub status_emoji: Option<String>,
    /// Optional: the bot may also refresh its own "information" line.
    #[serde(default)]
    pub description: Option<String>,
}

/// POST /api/v1/bots/{bot_id}/self-status — the bot updates ITS OWN status, authed
/// by the bot's Agent Bridge token (the connector already holds it), NOT a user JWT.
/// This is the write-back for "the bot updates itself": either ad-hoc, or on its
/// schedule after re-running `status_update_prompt`. Bumps `status_last_auto_update_at`
/// so the scheduler's "due?" clock resets. The path `bot_id` must match the token's
/// bot (a token is scoped to exactly one bot).
pub async fn bot_self_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(bot_id): Path<String>,
    Json(body): Json<BotSelfStatusRequest>,
) -> Result<Json<Value>, AppError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::Unauthorized("missing bot token".into()))?;

    let token_hash = hash_bot_token(token);
    // The token IS the credential and resolves to exactly one bot; matching the
    // path bot_id closes the door on a valid token editing a different bot's row.
    let matched: Option<String> = sqlx::query_scalar(
        "SELECT bot_id FROM bot_accounts WHERE bot_token_hash = $1 AND bot_id = $2",
    )
    .bind(&token_hash)
    .bind(&bot_id)
    .fetch_optional(&state.db)
    .await?;
    if matched.is_none() {
        return Err(AppError::Unauthorized(
            "invalid bot token for this bot".into(),
        ));
    }

    // Rate-limit per bot (audit item 2): min 5s between writes, so a runaway
    // connector can't fan a `member_updated` broadcast storm. Keyed by bot_id and
    // checked after auth so an unauthenticated probe never touches the limiter.
    // `peek` only — the interval is committed (`record`) after a *successful*
    // persist, so an over-cap payload that 400s doesn't burn the 5s budget and
    // leave the corrected retry throttled.
    if let Err(retry_after_secs) = crate::infra::ratelimit::bot_status_limiter().peek(&bot_id) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }

    let status_text = body
        .status_text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let status_emoji = body
        .status_emoji
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let description = body
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // Input caps (status_text ≤140, status_emoji ≤32, description ≤1000 chars) are
    // enforced inside persist_bot_self_status — the single choke point shared with
    // the resource verb (audit item 1) — so both write paths validate identically.
    let description_provided = body.description.is_some();
    persist_bot_self_status(
        &state.db,
        &bot_id,
        &status_text,
        &status_emoji,
        description_provided,
        &description,
    )
    .await
    .map_err(|e| match e {
        PersistStatusError::Invalid(msg) => AppError::BadRequest(msg),
        PersistStatusError::Db(e) => AppError::Db(e),
    })?;

    // Persist succeeded — now commit the rate-limit interval (see `peek` above).
    crate::infra::ratelimit::bot_status_limiter().record(&bot_id);

    // Push the new status to channel viewers so the bot's member card updates live
    // (mirrors what update_me does for users — a bot is a member too).
    broadcast_bot_member_update(&state, &bot_id).await;

    Ok(Json(json!({
        "bot_id": bot_id,
        "status_text": status_text,
        "status_emoji": status_emoji,
        "updated": true,
    })))
}

/// Failure of the shared bot-self-status persistence path: either an input-cap
/// violation (caller-fixable → 400 / INVALID_PARAMS) or a DB error. Splitting the
/// two lets each write path map them to its own transport error cleanly.
pub(crate) enum PersistStatusError {
    /// An input exceeded its character cap; the string is the caller-facing message.
    Invalid(String),
    Db(sqlx::Error),
}

/// Shared persistence for a bot writing its OWN status — used by both write paths:
/// the REST `POST /bots/{id}/self-status` (connector-authed by bot token) and the
/// `bot.status.write` resource verb (the agent's `set_status` MCP tool, authed by
/// the Agent Bridge connection). One UPDATE, so the two paths can't drift. Inputs
/// are already normalized (trimmed, empty→None); `description_provided=false`
/// keeps the current description. Bumps both status clocks.
///
/// Input caps are enforced HERE (audit item 1) so every self-status write — REST
/// and resource verb alike — sees the same limits: `status_text` ≤140,
/// `status_emoji` ≤32, `description` ≤1000, counted in chars (not bytes). This is
/// the single choke point, so the two paths can't drift on validation either.
pub(crate) async fn persist_bot_self_status(
    db: &sqlx::PgPool,
    bot_id: &str,
    status_text: &Option<String>,
    status_emoji: &Option<String>,
    description_provided: bool,
    description: &Option<String>,
) -> Result<(), PersistStatusError> {
    if status_text
        .as_deref()
        .is_some_and(|s| s.chars().count() > 140)
    {
        return Err(PersistStatusError::Invalid(
            "status_text too long (≤140 chars)".into(),
        ));
    }
    if status_emoji
        .as_deref()
        .is_some_and(|s| s.chars().count() > 32)
    {
        return Err(PersistStatusError::Invalid(
            "status_emoji too long (≤32 chars)".into(),
        ));
    }
    if description
        .as_deref()
        .is_some_and(|s| s.chars().count() > 1000)
    {
        return Err(PersistStatusError::Invalid(
            "description too long (≤1000 chars)".into(),
        ));
    }
    sqlx::query(
        "UPDATE bot_accounts SET
            status_text = $2,
            status_emoji = $3,
            description = CASE WHEN $4 THEN $5 ELSE description END,
            status_updated_at = NOW(),
            status_last_auto_update_at = NOW()
         WHERE bot_id = $1",
    )
    .bind(bot_id)
    .bind(status_text)
    .bind(status_emoji)
    .bind(description_provided)
    .bind(description)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(PersistStatusError::Db)
}

/// Broadcast a bot's current card (name/avatar/description/status) to every channel
/// it's in, as a `member_updated` frame — the bot-side analogue of
/// [`crate::api::users::broadcast_member_update`]. Best-effort; a bot's `bio` on the
/// member card is its `description`. Never fails the caller.
pub async fn broadcast_bot_member_update(state: &AppState, bot_id: &str) {
    let row = match sqlx::query(
        "SELECT display_name, avatar_url, description, status_text, status_emoji, status_updated_at
         FROM bot_accounts WHERE bot_id = $1",
    )
    .bind(bot_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        _ => return,
    };
    let profile = json!({
        "member_id": bot_id,
        "member_type": "bot",
        "display_name": row.try_get::<Option<String>, _>("display_name").ok().flatten(),
        "avatar_url": row.try_get::<Option<String>, _>("avatar_url").ok().flatten(),
        "bio": row.try_get::<Option<String>, _>("description").ok().flatten(),
        "status_text": row.try_get::<Option<String>, _>("status_text").ok().flatten(),
        "status_emoji": row.try_get::<Option<String>, _>("status_emoji").ok().flatten(),
        // RFC3339 so the hovercard can render "updated x ago" (audit item 5).
        "status_updated_at": row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("status_updated_at")
            .ok()
            .flatten()
            .map(|t| t.to_rfc3339()),
    });

    let channels: Vec<String> = sqlx::query_scalar(
        "SELECT channel_id::text FROM channel_memberships
         WHERE member_id = $1 AND member_type = 'bot'",
    )
    .bind(bot_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for cid in channels {
        let Ok(channel_uuid) = Uuid::parse_str(&cid) else {
            continue;
        };
        let mut data = profile.clone();
        data["channel_id"] = json!(cid);
        state
            .fanout
            .broadcast_channel(
                channel_uuid,
                WireFrame::channel(channel_uuid, "member_updated", data),
            )
            .await;
    }
}

/// Fallback when a bot has no `status_update_prompt` configured, so the manual
/// refresh button works out of the box. Names the `set_status` MCP tool explicitly:
/// that is the agent's ONLY write path for its own card (the REST /self-status
/// endpoint needs the bot token, which agents never see) — a prompt that doesn't
/// name the tool gets a chat reply and no card update.
const DEFAULT_STATUS_REFRESH_PROMPT: &str =
    "Update your status: call your `set_status` tool with a short status_text (and \
     optional status_emoji) reflecting what you're currently working on. If your \
     info line is stale, refresh it too via the same tool.";

/// POST /api/v1/bots/:bot_id/status/refresh — owner/admin asks the agent to refresh
/// its own status NOW. Posts the bot's configured `status_update_prompt` (mentioning
/// the bot) into a **DM** the caller shares with it, so the normal prompt path runs
/// the agent — which then writes its status via `/self-status`. A DM (not any shared
/// group channel) is required so the prompt — which `list_bots` redacts from
/// non-managers — is never made visible to other human members. Reuses the
/// `session/prompt` INITIATE gate (the panel is already owner/admin-only); no
/// connector changes needed.
pub async fn refresh_bot_status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;

    let bot_uuid =
        Uuid::parse_str(&bot_id).map_err(|_| AppError::BadRequest("invalid bot id".into()))?;
    let caller = Uuid::parse_str(&claims.sub)
        .map_err(|_| AppError::Unauthorized("invalid user id".into()))?;

    // The prompt that makes the agent produce its status; default so the button works
    // before a custom `status_update_prompt` is configured.
    let configured: Option<String> =
        sqlx::query_scalar("SELECT status_update_prompt FROM bot_accounts WHERE bot_id = $1")
            .bind(&bot_id)
            .fetch_optional(&state.db)
            .await?
            .flatten();
    let prompt = configured
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STATUS_REFRESH_PROMPT.to_string());

    // Post into the caller's DM with the bot: create_message needs the caller to be a
    // member, mention-triggering needs the bot to be one, and a DM is private to just the
    // two of them — posting the configured `status_update_prompt` into a group room would
    // leak it to other human members, contradicting the manager-only redaction `list_bots`
    // applies to that same field. Auto-create the DM if it doesn't exist yet (find-or-create,
    // race-safe via dm_key, same path `/channels/dm` uses) so the owner can refresh without
    // first opening one by hand.
    let channel_id =
        crate::domain::dms::find_or_create_dm(&state.db, caller, &bot_id, true).await?;

    // INITIATE(prompt) gate. `create_message` posts the prompt but *silently skips*
    // waking the bot when this event is denied (it `continue`s the dispatch loop and
    // still returns Ok) — which would make this endpoint report a false success while
    // the agent never runs. Check the same gate `send_message` uses up front and fail
    // loudly instead. Fail-open on a rules error, matching create_message/cancel_message.
    let caller_role: String = sqlx::query(
        "SELECT role FROM channel_memberships
         WHERE channel_id = $1 AND member_id = $2 AND member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.try_get::<Option<String>, _>("role").ok().flatten())
    .unwrap_or_else(|| "member".to_string());
    let may_prompt = crate::domain::acp_policy::allows(
        &state.db,
        &bot_id,
        &channel_id.to_string(),
        &claims.sub,
        &caller_role,
        "session/prompt",
        crate::domain::bot_event_policy::Capability::Initiate,
    )
    .await
    .unwrap_or(true);
    if !may_prompt {
        return Err(AppError::Forbidden(
            "not authorized to prompt this bot here — status refresh needs the ACP prompt permission"
                .into(),
        ));
    }

    let dto = messages::create_message(
        &state.db,
        &state.fanout,
        &state.stream_registry,
        &state.bot_locator,
        CreateMessageParams {
            user_id: caller,
            channel_id,
            content: prompt,
            msg_type: None,
            reply_to_msg_id: None,
            file_ids: vec![],
            mention_ids: vec![bot_uuid],
            mention_names: vec![],
            session_id: None,
            context_bundle: None,
        },
    )
    .await?;

    Ok(Json(json!({
        "ok": true,
        "channel_id": channel_id.to_string(),
        "msg_id": dto.msg_id,
    })))
}

/// Strict semver-triple "is `candidate` newer than `current`" — used for the
/// connector `update_available` flag. Tolerates a leading `v`; anything that
/// isn't three dot-separated integers compares as "not newer" (fail quiet:
/// a garbled version must never nag every bot owner to update).
fn version_is_newer(candidate: &str, current: &str) -> bool {
    fn triple(s: &str) -> Option<(u64, u64, u64)> {
        let mut it = s.trim().trim_start_matches('v').splitn(3, '.');
        let major = it.next()?.parse().ok()?;
        let minor = it.next()?.parse().ok()?;
        let patch = it.next()?.parse().ok()?;
        Some((major, minor, patch))
    }
    match (triple(candidate), triple(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::version_is_newer;

    #[test]
    fn version_compare_is_numeric_not_lexicographic() {
        assert!(version_is_newer("0.1.27", "0.1.26"));
        assert!(version_is_newer("0.2.0", "0.1.99"));
        assert!(version_is_newer("0.1.100", "0.1.26"));
        assert!(version_is_newer("v0.1.27", "0.1.26"));
        assert!(!version_is_newer("0.1.26", "0.1.26"));
        assert!(!version_is_newer("0.1.25", "0.1.26"));
        assert!(!version_is_newer("latest", "0.1.26"));
        assert!(!version_is_newer("0.1.27", "unknown"));
    }
}
