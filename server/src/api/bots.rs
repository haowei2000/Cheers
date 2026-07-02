use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    errors::AppError,
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
                created_by
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
    Ok(Json(rows.into_iter().map(|r| {
        let created_by = r.try_get::<Option<String>, _>("created_by").ok().flatten();
        let is_owner = created_by.as_deref() == Some(claims.sub.as_str());
        let binding_config = if admin || is_owner {
            r.try_get::<Value, _>("binding_config").ok()
        } else {
            None
        };
        // LIVE connectivity from the connection registry — the only honest "online"
        // signal. `status` is a persisted enable flag that's set 'online' at creation
        // and never flipped, so it can't tell a connected bot from a dead one. All
        // bots dispatch through the WS bridge (see gateway::dispatcher), so the
        // registry is authoritative for every binding type.
        let bot_id = r.try_get::<String, _>("bot_id").unwrap_or_default();
        let is_online = Uuid::parse_str(&bot_id)
            .map(|id| state.bot_locator.is_online(id))
            .unwrap_or(false);
        json!({
            "bot_id": bot_id,
            "username": r.try_get::<String, _>("username").unwrap_or_default(),
            "display_name": r.try_get::<String, _>("display_name").ok(),
            "description": r.try_get::<String, _>("description").ok(),
            "avatar_url": r.try_get::<String, _>("avatar_url").ok(),
            "is_disabled": r.try_get::<bool, _>("is_disabled").unwrap_or(false),
            "can_manage": admin || is_owner,
            "is_online": is_online,
            "scope": r.try_get::<String, _>("scope").unwrap_or_else(|_| "friend".into()),
            "binding_type": r.try_get::<String, _>("binding_type").unwrap_or_else(|_| "http".into()),
            "bridge_provider": r.try_get::<String, _>("bridge_provider").unwrap_or_else(|_| "generic".into()),
            "model_id": r.try_get::<String, _>("model_id").ok(),
            "template_id": r.try_get::<String, _>("template_id").ok(),
            "intro": r.try_get::<String, _>("intro").ok(),
            "binding_config": binding_config,
        })
    }).collect()))
}

pub async fn create_bot(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<BotCreateRequest>,
) -> Result<Json<Value>, AppError> {
    if body.username.trim().is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }
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
             binding_config, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING bot_id, username, display_name, description, avatar_url, is_disabled, scope,
                   binding_type, bridge_provider, model_id, template_id, intro, binding_config",
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
    .fetch_one(&state.db)
    .await?;
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
        "SELECT bot_id, is_disabled, binding_type, created_by FROM bot_accounts WHERE bot_id = $1",
    )
    .bind(&bot_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let is_disabled: bool = row.try_get("is_disabled").unwrap_or(false);

    // bridge_connected is the LIVE truth from the connection registry (a control
    // + data WS are bound right now), distinct from the persisted `status` flag.
    // A bot can be status="online" (eligible to connect) yet have no live bridge.
    let bridge_connected = Uuid::parse_str(&bot_id)
        .ok()
        .map(|id| state.bot_locator.is_online(id))
        .unwrap_or(false);

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
        "live_enrollment_codes": live_codes,
    })))
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
