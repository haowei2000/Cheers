//! One-time enrollment codes — the shared primitive behind all three bot
//! onboarding modes (manual / install-script / agent-self-connect).
//!
//! Flow: an owner MINTS a short-lived, single-use code bound to a bot (not to a
//! user). A host REDEEMS it once, anonymously, over TLS, to receive a freshly
//! rotated bot token + a ready-to-run connector config. The code's plaintext is
//! never stored (only its SHA-256), never put in a URL/log, and a redeem rotates
//! the bot token through the single mint path (`bots::mint_bot_token`) so one
//! code == one issuance; N hosts need N codes.
//!
//! Public surface is intentionally tiny: only `redeem` is unauthenticated (it
//! authenticates by the code itself). Mint / revoke / config all sit behind JWT
//! + `ensure_bot_owner_or_admin`. See the design note "Bot 接入三模式设计".

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::bots::{ensure_bot_owner_or_admin, mint_bot_token},
    api::middleware::Claims,
    app_state::AppState,
    domain::connector_config::{
        self, control_url, data_url, RenderParams, TokenRef, DEFAULT_PUBLIC_BASE,
    },
    errors::AppError,
    infra::crypto::{generate_enrollment_code, hash_enrollment_code},
};

/// How long a freshly minted code stays redeemable (15 minutes). Short by
/// design: the code is an ownerless bearer secret, so TTL + single-use + the
/// blast radius being "rotates exactly one bot's token" are what bound it.
const ENROLLMENT_TTL_SECS: f64 = 900.0;

/// Per-bot live (un-redeemed, un-revoked, un-expired) code cap. One code per
/// target host is the norm; this stops an accidental mint loop hoarding codes.
const MAX_LIVE_CODES_PER_BOT: i64 = 5;

/// Per-owner global live-code cap. With up to 50 bots × 5/bot the per-bot cap
/// alone allows 250 outstanding secrets; this is the real abuse bound.
const MAX_LIVE_CODES_PER_OWNER: i64 = 20;

/// Sidecar path (relative to the connector config dir) the generated config
/// reads the bot token from. The install script / manual steps write the
/// plaintext here with 0600.
fn token_file_path(account_id: &str) -> String {
    format!("secrets/{account_id}.token")
}

/// Resolve the public WS base the connector should dial, and whether it came
/// from explicit config (vs. the localhost fallback that may need port-forward).
fn resolve_public_base(state: &AppState) -> (String, bool) {
    match state.config.connector_public_base.as_deref() {
        Some(b) if !b.trim().is_empty() => (b.trim().to_string(), true),
        _ => (DEFAULT_PUBLIC_BASE.to_string(), false),
    }
}

/// Normalize an agent_type input to one of the known presets (or "generic").
fn normalize_agent_type(raw: Option<&str>) -> String {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("claude") => "claude".into(),
        Some("codex") => "codex".into(),
        Some("opencode") => "opencode".into(),
        _ => "generic".into(),
    }
}

#[derive(Deserialize)]
pub struct MintRequest {
    /// claude | codex | opencode | generic (drives the rendered adapter.command).
    #[serde(default)]
    pub agent_type: Option<String>,
}

/// POST /api/v1/bots/{bot_id}/enrollment — mint a one-time enrollment code.
/// Owner/admin only. Returns the plaintext code **once**.
pub async fn mint_enrollment_code(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    body: Option<Json<MintRequest>>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let agent_type = normalize_agent_type(
        body.as_ref()
            .and_then(|b| b.agent_type.as_deref())
            .filter(|s| !s.trim().is_empty()),
    );

    // Per-bot cap.
    let live_for_bot: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM enrollment_codes
         WHERE bot_id = $1 AND redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()",
    )
    .bind(&bot_id)
    .fetch_one(&state.db)
    .await?;
    if live_for_bot >= MAX_LIVE_CODES_PER_BOT {
        return Err(AppError::Forbidden(format!(
            "too many live enrollment codes for this bot (max {MAX_LIVE_CODES_PER_BOT}); revoke some first"
        )));
    }

    // Per-owner global cap (uses the partial index ix_enrollment_codes_live).
    let live_for_owner: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM enrollment_codes
         WHERE created_by = $1 AND redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()",
    )
    .bind(&claims.sub)
    .fetch_one(&state.db)
    .await?;
    if live_for_owner >= MAX_LIVE_CODES_PER_OWNER {
        return Err(AppError::Forbidden(format!(
            "too many live enrollment codes (max {MAX_LIVE_CODES_PER_OWNER} per user); revoke some first"
        )));
    }

    let code = generate_enrollment_code();
    let code_hash = hash_enrollment_code(&code);
    let code_id = Uuid::new_v4().to_string();

    let row = sqlx::query(
        "INSERT INTO enrollment_codes
            (code_id, bot_id, code_hash, created_by, agent_type, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6))
         RETURNING expires_at",
    )
    .bind(&code_id)
    .bind(&bot_id)
    .bind(&code_hash)
    .bind(&claims.sub)
    .bind(&agent_type)
    .bind(ENROLLMENT_TTL_SECS)
    .fetch_one(&state.db)
    .await?;
    let expires_at: chrono::DateTime<chrono::Utc> = row.try_get("expires_at")?;

    let (public_base, configured) = resolve_public_base(&state);

    // Audit only the prefix + bot_id — never the code (it's a bearer secret).
    tracing::info!(
        %bot_id,
        code_prefix = &code[..code.len().min(12)],
        %agent_type,
        owner = %claims.sub,
        "enrollment code minted"
    );

    Ok(Json(json!({
        "code": code,
        "code_id": code_id,
        "bot_id": bot_id,
        "agent_type": agent_type,
        "expires_at": expires_at.to_rfc3339(),
        "ttl_secs": ENROLLMENT_TTL_SECS as i64,
        "redeem_path": "/api/v1/enrollment/redeem",
        "control_url": control_url(&public_base),
        "reachability": {
            "public_base": public_base,
            "configured": configured,
        },
        "live_codes": live_for_bot + 1,
        "note": "Single-use, expires soon. Pass it to the target host via CHEERS_ENROLL_CODE (never a URL).",
    })))
}

/// DELETE /api/v1/bots/{bot_id}/enrollment — revoke ALL live codes for a bot.
/// Owner/admin only. Idempotent; returns how many were revoked.
pub async fn revoke_enrollment_codes(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let revoked = sqlx::query(
        "UPDATE enrollment_codes SET revoked = TRUE
         WHERE bot_id = $1 AND redeemed_at IS NULL AND NOT revoked",
    )
    .bind(&bot_id)
    .execute(&state.db)
    .await?
    .rows_affected();
    tracing::info!(%bot_id, revoked, owner = %claims.sub, "enrollment codes revoked");
    Ok(Json(json!({ "bot_id": bot_id, "revoked": revoked })))
}

#[derive(Deserialize)]
pub struct RedeemRequest {
    pub code: String,
}

/// POST /api/v1/enrollment/redeem — PUBLIC. Authenticated by the code itself.
/// Atomically claims the code (single-use), rotates the bot token, and returns
/// the token + a ready-to-run connector config. Every failure mode (unknown /
/// expired / already-redeemed / revoked) returns the SAME opaque 400 so it isn't
/// an existence/状态 oracle.
pub async fn redeem_enrollment_code(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RedeemRequest>,
) -> Result<Json<Value>, AppError> {
    let limiter = crate::infra::ratelimit::enrollment_redeem_limiter();
    let rl_key = crate::infra::ratelimit::client_key(&headers);
    if let Some(retry_after_secs) = limiter.retry_after(&rl_key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }

    let code = body.code.trim();
    let opaque = || AppError::BadRequest("enrollment code is invalid or expired".into());
    if code.is_empty() {
        limiter.record_failure(&rl_key);
        return Err(opaque());
    }
    let code_hash = hash_enrollment_code(code);

    // Atomic single-redemption: the WHERE clause guarantees exactly one caller
    // can flip redeemed_at; a replay sees zero rows. Same predicate as the table
    // comment in migration 0024.
    let claimed = sqlx::query(
        "UPDATE enrollment_codes SET redeemed_at = NOW()
         WHERE code_hash = $1 AND redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()
         RETURNING bot_id, agent_type",
    )
    .bind(&code_hash)
    .fetch_optional(&state.db)
    .await?;

    let Some(row) = claimed else {
        limiter.record_failure(&rl_key);
        return Err(opaque());
    };
    let bot_id: String = row.try_get("bot_id").map_err(|_| opaque())?;
    let agent_type = normalize_agent_type(row.try_get::<Option<String>, _>("agent_type").ok().flatten().as_deref());

    // Fetch the bot's name for the TOML account id. If the bot vanished between
    // claim and here (CASCADE would have deleted the code, so this is rare), the
    // code is already spent — fail opaque rather than leak.
    let bot_row = sqlx::query("SELECT username FROM bot_accounts WHERE bot_id = $1")
        .bind(&bot_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(opaque)?;
    let username: String = bot_row.try_get("username").unwrap_or_else(|_| bot_id.clone());
    let account_id = connector_config::sanitize_account_id(&username);

    // Single mint path — identical to a manual token rotate.
    let (token, token_prefix) = mint_bot_token(&state, &bot_id).await?;

    let (public_base, configured) = resolve_public_base(&state);
    let token_file = token_file_path(&account_id);
    let config_toml = connector_config::render_toml(&RenderParams {
        account_id: &username,
        agent_type: &agent_type,
        public_base: &public_base,
        token_ref: TokenRef::File(token_file.clone()),
    });

    limiter.reset(&rl_key);
    tracing::info!(%bot_id, %account_id, %agent_type, token_prefix = %token_prefix, "enrollment code redeemed");

    Ok(Json(json!({
        "bot_id": bot_id,
        "account_id": account_id,
        "agent_type": agent_type,
        "token": token,
        "token_prefix": token_prefix,
        "token_file": token_file,
        "control_url": control_url(&public_base),
        "data_url": data_url(&public_base),
        "config_toml": config_toml,
        "reachability": {
            "public_base": public_base,
            "configured": configured,
        },
        "note": "Write `token` to <config_dir>/<token_file> (chmod 600), save config_toml, then start the connector. The token replaces any previous one for this bot.",
    })))
}

#[derive(Deserialize)]
pub struct ConnectorConfigQuery {
    #[serde(default)]
    pub agent_type: Option<String>,
}

/// GET /api/v1/bots/{bot_id}/connector-config — owner/admin. Manual-mode (mode 3)
/// helper: returns a ready-to-run config that reads the token from a sidecar
/// file. The token itself is issued separately via `POST /bots/{id}/token` so a
/// single page never juggles two secrets (config + code).
pub async fn get_connector_config(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(bot_id): Path<String>,
    Query(q): Query<ConnectorConfigQuery>,
) -> Result<Json<Value>, AppError> {
    ensure_bot_owner_or_admin(&state, &claims, &bot_id).await?;
    let row = sqlx::query("SELECT username FROM bot_accounts WHERE bot_id = $1")
        .bind(&bot_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let username: String = row.try_get("username").unwrap_or_else(|_| bot_id.clone());
    let account_id = connector_config::sanitize_account_id(&username);
    let agent_type = normalize_agent_type(q.agent_type.as_deref());

    let (public_base, configured) = resolve_public_base(&state);
    let token_file = token_file_path(&account_id);
    let config_toml = connector_config::render_toml(&RenderParams {
        account_id: &username,
        agent_type: &agent_type,
        public_base: &public_base,
        token_ref: TokenRef::File(token_file.clone()),
    });

    Ok(Json(json!({
        "bot_id": bot_id,
        "account_id": account_id,
        "agent_type": agent_type,
        "token_file": token_file,
        "control_url": control_url(&public_base),
        "data_url": data_url(&public_base),
        "config_toml": config_toml,
        "reachability": {
            "public_base": public_base,
            "configured": configured,
        },
        "note": "Issue the bot token separately (POST /api/v1/bots/{bot_id}/token) and write it to <config_dir>/<token_file> (chmod 600).",
    })))
}

/// GET /api/v1/ops/connector-discovery — authed. Where should a connector dial?
/// Lets the wizard show the reachable control/data URLs (and whether the deploy
/// has an explicit public base configured vs. the port-forward fallback).
pub async fn connector_discovery(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
    Query(_q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    let (public_base, configured) = resolve_public_base(&state);
    Ok(Json(json!({
        "public_base": public_base,
        "configured": configured,
        "control_url": control_url(&public_base),
        "data_url": data_url(&public_base),
        "hint": if configured {
            "Connector should dial these URLs."
        } else {
            "No CHEERS_CONNECTOR_PUBLIC_BASE set — using a localhost fallback that may require `kubectl port-forward svc/cheers-gateway 8000:8000` (or set it to the frontend NodePort ws://localhost:30080)."
        },
    })))
}
