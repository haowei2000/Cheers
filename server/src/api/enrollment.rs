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
    http::{header, HeaderMap},
    response::IntoResponse,
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

    let code = generate_enrollment_code();
    let code_hash = hash_enrollment_code(&code);
    let code_id = Uuid::new_v4().to_string();

    // Cap check + insert run in one transaction guarded by a per-owner advisory
    // lock (audit follow-up L1): previously the two COUNT(*)s and the INSERT were
    // independent autocommit statements, so two interleaved mints could both pass
    // a sub-cap count and both insert, racing past the caps. The xact lock
    // serializes a single owner's concurrent mints (the realistic race: double
    // submit / retry); it's released on commit or on rollback when `tx` drops.
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(&claims.sub)
        .execute(&mut *tx)
        .await?;

    let live_for_bot: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM enrollment_codes
         WHERE bot_id = $1 AND redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()",
    )
    .bind(&bot_id)
    .fetch_one(&mut *tx)
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
    .fetch_one(&mut *tx)
    .await?;
    if live_for_owner >= MAX_LIVE_CODES_PER_OWNER {
        return Err(AppError::Forbidden(format!(
            "too many live enrollment codes (max {MAX_LIVE_CODES_PER_OWNER} per user); revoke some first"
        )));
    }

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
    .fetch_one(&mut *tx)
    .await?;
    let expires_at: chrono::DateTime<chrono::Utc> = row.try_get("expires_at")?;
    tx.commit().await?;

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
    connect_info: Option<axum::extract::ConnectInfo<std::net::SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<RedeemRequest>,
) -> Result<Json<Value>, AppError> {
    let limiter = crate::infra::ratelimit::enrollment_redeem_limiter();
    let rl_key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|axum::extract::ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
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
    let agent_type = normalize_agent_type(
        row.try_get::<Option<String>, _>("agent_type")
            .ok()
            .flatten()
            .as_deref(),
    );

    // Fetch the bot's name for the TOML account id. If the bot vanished between
    // claim and here (CASCADE would have deleted the code, so this is rare), the
    // code is already spent — fail opaque rather than leak.
    let bot_row = sqlx::query("SELECT username FROM bot_accounts WHERE bot_id = $1")
        .bind(&bot_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(opaque)?;
    let username: String = bot_row
        .try_get("username")
        .unwrap_or_else(|_| bot_id.clone());
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
    let row = sqlx::query(
        "SELECT username, status_auto_update, status_update_prompt,
                status_update_interval_minutes
         FROM bot_accounts WHERE bot_id = $1",
    )
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
        // Scheduled self-status: when enabled, the connector should, every
        // `interval_minutes`, run `prompt` through its agent and POST the answer to
        // /api/v1/bots/{bot_id}/self-status (Bearer = bot token). The gateway owns
        // the config; the connector owns the timer + the write-back.
        "status_schedule": {
            "enabled": row.try_get::<bool, _>("status_auto_update").unwrap_or(false),
            "prompt": row.try_get::<Option<String>, _>("status_update_prompt").ok().flatten(),
            "interval_minutes": row
                .try_get::<Option<i32>, _>("status_update_interval_minutes")
                .ok()
                .flatten(),
            "self_status_path": format!("/api/v1/bots/{bot_id}/self-status"),
        },
        "note": "Issue the bot token separately (POST /api/v1/bots/{bot_id}/token) and write it to <config_dir>/<token_file> (chmod 600).",
    })))
}

/// The mode-2 installer, embedded at compile time so it ships inside the
/// gateway binary (the container has no repo checkout). `__CHEERS_API_BASE__`
/// is substituted per request from the caller's Host so the one-liner is
/// self-configuring.
const INSTALL_SCRIPT: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/install.sh"));

/// Derive the gateway API base the installer should call, from the inbound
/// request's Host (set by nginx) + forwarded proto. Falls back to the
/// configured public base's host, then localhost.
fn resolve_api_base(state: &AppState, headers: &HeaderMap) -> String {
    // Reflect the Host into the served install.sh body, so only accept a strict
    // host:port charset (defense-in-depth; the HTTP layer already rejects CR/LF,
    // and the caller is piping the result into their own shell — but a clean host
    // keeps the script body free of anything surprising).
    fn safe_host(h: &str) -> bool {
        !h.is_empty()
            && h.len() <= 255
            && h.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|h| safe_host(h));
    let proto = match headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
    {
        Some("https") => "https",
        _ => "http",
    };
    match host {
        Some(h) => format!("{proto}://{h}/api/v1"),
        None => {
            // No Host (shouldn't happen behind nginx) — best-effort from config.
            let _ = state; // kept for future use of connector_public_base host
            "http://localhost:8000/api/v1".to_string()
        }
    }
}

/// GET /api/v1/install.sh — PUBLIC. Serves the mode-2 connector installer with
/// the API base baked in. No secrets here; the script reads the one-time code
/// from CHEERS_ENROLL_CODE at runtime and redeems it itself.
pub async fn install_script(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let api_base = resolve_api_base(&state, &headers);
    let body = INSTALL_SCRIPT.replace("__CHEERS_API_BASE__", &api_base);
    (
        [(header::CONTENT_TYPE, "text/x-shellscript; charset=utf-8")],
        body,
    )
}

/// Allowlisted release-asset names the gateway will proxy — exactly the
/// 2 products × 2 OS × 2 arches the release-connector workflow publishes,
/// plus the ed25519-signed sha256 manifest pair the connector self-updater
/// verifies before swapping binaries. Anything else 404s, so the endpoint
/// can't be used as an open proxy.
fn is_known_connector_asset(name: &str) -> bool {
    if matches!(
        name,
        "connector-manifest.json" | "connector-manifest.json.sig"
    ) {
        return true;
    }
    let Some(rest) = name
        .strip_prefix("cce-acp-connector-")
        .or_else(|| name.strip_prefix("cheers-mcp-server-"))
    else {
        return false;
    };
    matches!(
        rest,
        "darwin-amd64" | "darwin-arm64" | "linux-amd64" | "linux-arm64"
    )
}

static DOWNLOAD_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

/// GET /api/v1/connector/download/{asset} — PUBLIC. Same-origin proxy for the
/// prebuilt connector release binaries. A host onboarding a bot has already
/// proven it can reach this gateway (install.sh came from here), but GitHub may
/// be unreachable from it (firewalled networks) — while the gateway itself can
/// reach GitHub fine. So install.sh tries this URL first and the gateway
/// STREAMS the asset through (a redirect to GitHub would defeat the point).
/// Repo/version come from CHEERS_CONNECTOR_RELEASE_REPO / _VERSION (default:
/// this repo's latest release). No secrets, no auth — the assets are public.
pub async fn connector_download(
    State(state): State<AppState>,
    Path(asset): Path<String>,
) -> Result<axum::response::Response, AppError> {
    if !is_known_connector_asset(&asset) {
        return Err(AppError::NotFound);
    }
    let repo = &state.config.connector_release_repo;
    let url = match &state.config.connector_release_version {
        Some(v) => {
            format!("https://github.com/{repo}/releases/download/connector-v{v}/{asset}")
        }
        None => format!("https://github.com/{repo}/releases/latest/download/{asset}"),
    };
    let client = DOWNLOAD_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    let upstream = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("connector release fetch failed: {e}")))?;
    if !upstream.status().is_success() {
        return Err(AppError::Internal(format!(
            "connector release fetch returned HTTP {} for {asset}",
            upstream.status()
        )));
    }
    let mut resp = axum::response::Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{asset}\""),
        );
    if let Some(len) = upstream.content_length() {
        resp = resp.header(header::CONTENT_LENGTH, len);
    }
    resp.body(axum::body::Body::from_stream(upstream.bytes_stream()))
        .map_err(|e| AppError::Internal(format!("stream response: {e}")))
}

/// Natural-language prompt handed to a user's own agent (mode 1). `{INSTALL_URL}`
/// is filled server-side; `{ENROLL_CODE}` is filled client-side from a minted
/// code so the secret never rides in this GET. Mode 1 is honestly mode 2 driven
/// by the agent — hence the keep-alive emphasis.
const GUIDANCE_TEMPLATE: &str = r#"You are being connected to a Cheers chat workspace as a long-running bot connector. Please set yourself up on THIS machine:

1. Run this exact command in a terminal. It redeems a one-time code, writes a connector config + a 0600 token file, installs a keep-alive service, and starts the connector:

   CHEERS_ENROLL_CODE='{ENROLL_CODE}' bash <(curl -fsSL {INSTALL_URL})

2. The script finds `cce-acp-connector` on PATH, or downloads the prebuilt binary — first from this Cheers server itself (no GitHub access needed), then from the GitHub release (https://github.com/ElePerson/Cheers/releases). Only if no downloaded binary runs on this platform, build it once from the Cheers repo (packages/cheers-acp-connector-rs: `cargo build --release`), then re-run with CHEERS_CONNECTOR_BIN=/path/to/target/release/cce-acp-connector.

3. The bot's agent adapter (e.g. `claude-agent-acp` for Claude) must be installed too — the script auto-installs it via npm when missing (needs node/npm). If the script reports the adapter missing, install it (`npm install -g @agentclientprotocol/claude-agent-acp`) and run the finish command the script printed — do NOT re-run the one-liner, the code is single-use.

4. Make sure the connector keeps running in the BACKGROUND after this task ends (the install script sets up a launchd/systemd unit for this). If it only runs while you are active, the bot will go offline the moment your turn finishes.

The code is single-use and expires in ~15 minutes. Do not echo it back or save it anywhere except by running the command above."#;

/// GET /api/v1/enrollment/guidance — authed. Returns the mode-1 agent prompt
/// template (with the install URL baked in) plus the install URL, so the wizard
/// and any programmatic caller share one prompt. The client fills {ENROLL_CODE}.
pub async fn guidance(
    State(state): State<AppState>,
    Extension(_claims): Extension<Claims>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let api_base = resolve_api_base(&state, &headers);
    let install_url = format!("{api_base}/install.sh");
    let prompt_template = GUIDANCE_TEMPLATE.replace("{INSTALL_URL}", &install_url);
    Ok(Json(json!({
        "install_url": install_url,
        "prompt_template": prompt_template,
        "code_placeholder": "{ENROLL_CODE}",
        "note": "Fill {ENROLL_CODE} with a freshly minted one-time code before handing this to your agent.",
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
