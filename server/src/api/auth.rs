use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{error::DatabaseError, Row};
use uuid::Uuid;

use crate::infra::crypto::MIN_PASSWORD_CHARS;
use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::{auth, auth_sessions, two_factor},
    errors::AppError,
};

/// Minimal `local@domain.tld` shape check — not RFC-perfect, just rejects obvious junk.
fn looks_like_email(s: &str) -> bool {
    let mut parts = s.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => {
            !local.is_empty()
                && domain.len() >= 3
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains(' ')
        }
        _ => false,
    }
}

#[derive(Deserialize)]
pub struct LoginRequest {
    /// username 或 email
    pub login: String,
    pub password: String,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub remember_device: bool,
    /// Native clients present a previously issued trusted-device secret here
    /// (web uses the `cheers_trusted_device` cookie instead).
    #[serde(default)]
    pub trusted_device: Option<String>,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(default)]
    pub allowed_factors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i64>,
    pub requires_2fa: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub two_factor_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csrf_token: Option<String>,
    /// Native clients persist this (Keychain) and present it on later logins so
    /// Apple/Google/password can skip 2FA the same way the web cookie does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_device: Option<String>,
}

fn client_type(value: Option<&str>) -> Result<auth_sessions::ClientType, AppError> {
    auth_sessions::ClientType::parse(value)
}

pub(crate) fn session_response(
    user: &auth::AuthUser,
    session: auth_sessions::IssuedSession,
    client: auth_sessions::ClientType,
) -> Result<LoginResponse, AppError> {
    Ok(LoginResponse {
        status: "authenticated".into(),
        transaction_id: None,
        allowed_factors: Vec::new(),
        expires_in: Some(session.expires_in),
        requires_2fa: false,
        two_factor_session_id: None,
        access_token: Some(session.access_token),
        token_type: Some("bearer".into()),
        user_id: Some(user.id.clone()),
        username: Some(user.username.clone()),
        display_name: user.display_name.clone(),
        role: Some(user.role.clone()),
        // Browser callers receive this as HttpOnly cookies in the final handler;
        // native clients receive it through their Keychain-facing network layer.
        refresh_token: (client != auth_sessions::ClientType::Web).then_some(session.refresh_token),
        csrf_token: (client != auth_sessions::ClientType::Web).then_some(session.csrf_token),
        trusted_device: None,
    })
}

/// POST /api/v1/auth/login
pub async fn login(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<Response, AppError> {
    // Throttle brute-force / bcrypt-DoS (audit H3): cap failed attempts per
    // client source; a successful login clears the counter.
    let limiter = crate::infra::ratelimit::login_limiter();
    let key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }

    let user = match auth::authenticate(&state.db, &body.login, &body.password).await {
        Ok(u) => u,
        Err(e) => {
            limiter.record_failure(&key);
            return Err(e);
        }
    };
    limiter.reset(&key);

    let client = client_type(body.client.as_deref())?;
    let remember_device = body.remember_device;
    let presented = presented_trusted_device(&headers, body.trusted_device.as_deref());
    let trusted =
        auth_sessions::trusted_device_is_valid(&state.db, &user.id, presented.as_deref()).await?;
    let tf_status = two_factor::status(&state.db, &user.id).await?;

    if tf_status.enabled && !trusted {
        let transaction = auth_sessions::create_factor_transaction(
            &state.db,
            &user.id,
            client,
            body.device_name.as_deref(),
        )
        .await?;
        let allowed_factors = crate::domain::webauthn::allowed_login_factors(
            &state.db,
            state.webauthn.as_deref(),
            &user.id,
        )
        .await?;
        return Ok(Json(LoginResponse {
            status: "factor_required".into(),
            transaction_id: Some(transaction.transaction_id),
            allowed_factors,
            expires_in: Some(600),
            requires_2fa: true,
            two_factor_session_id: None,
            access_token: None,
            token_type: None,
            user_id: None,
            username: None,
            display_name: None,
            role: None,
            refresh_token: None,
            csrf_token: None,
            trusted_device: None,
        })
        .into_response());
    }
    let session = auth_sessions::finalize_login(
        &state.db,
        &state.config,
        &user,
        client,
        body.device_name.as_deref(),
    )
    .await?;
    let session_id = session.session_id.clone();
    let refresh = session.refresh_token.clone();
    let csrf = session.csrf_token.clone();
    let device_name = body.device_name.clone();
    let mut login_body = session_response(&user, session, client)?;
    if remember_device {
        let trusted = auth_sessions::issue_trusted_device(
            &state.db,
            &user.id,
            &session_id,
            device_name.as_deref(),
        )
        .await?;
        if client != auth_sessions::ClientType::Web {
            login_body.trusted_device = Some(trusted.clone());
        }
        let mut response = if client == auth_sessions::ClientType::Web {
            response_with_session_cookies(login_body, Some(&refresh), Some(&csrf))
        } else {
            Json(login_body).into_response()
        };
        response.headers_mut().append(
            axum::http::header::SET_COOKIE,
            auth_cookie("cheers_trusted_device", &trusted, true, 30 * 24 * 60 * 60)
                .parse()
                .expect("valid cookie header"),
        );
        return Ok(response);
    }
    Ok(if client == auth_sessions::ClientType::Web {
        response_with_session_cookies(login_body, Some(&refresh), Some(&csrf))
    } else {
        Json(login_body).into_response()
    })
}

pub(crate) fn parse_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(axum::http::header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| value.to_string())
        })
}

/// Prefer an explicitly presented native credential; fall back to the web cookie.
pub(crate) fn presented_trusted_device(
    headers: &HeaderMap,
    body_value: Option<&str>,
) -> Option<String> {
    if let Some(value) = body_value.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(value.to_string());
    }
    parse_cookie(headers, "cheers_trusted_device")
}

fn auth_cookie(name: &str, value: &str, http_only: bool, max_age: i64) -> String {
    let http_only = if http_only { "; HttpOnly" } else { "" };
    format!("{name}={value}; Max-Age={max_age}; Path=/; Secure{http_only}; SameSite=Lax")
}

fn clear_auth_cookie(name: &str) -> String {
    format!("{name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax")
}

pub(crate) fn response_with_session_cookies(
    body: LoginResponse,
    refresh_token: Option<&str>,
    csrf_token: Option<&str>,
) -> Response {
    let mut response = Json(body).into_response();
    if let Some(refresh) = refresh_token {
        response.headers_mut().append(
            axum::http::header::SET_COOKIE,
            auth_cookie("cheers_refresh", refresh, true, 30 * 24 * 60 * 60)
                .parse()
                .expect("valid cookie header"),
        );
    }
    if let Some(csrf) = csrf_token {
        response.headers_mut().append(
            axum::http::header::SET_COOKIE,
            auth_cookie("cheers_csrf", csrf, false, 30 * 24 * 60 * 60)
                .parse()
                .expect("valid cookie header"),
        );
    }
    response
}

#[derive(Deserialize)]
pub struct RegisterCodeRequest {
    pub email: String,
    /// Shareable invite-link token: when live, it substitutes for
    /// `config.open_registration` (the link IS the sign-up authorization).
    #[serde(default)]
    pub invite_token: Option<String>,
}

/// Sign-up gate shared by request-code + register: open registration, or a live
/// invite-link token. The token is only CHECKED here — its use is consumed later
/// by `accept_invite_link`, once the account exists and actually joins.
pub(crate) async fn ensure_may_register(
    state: &AppState,
    invite_token: Option<&str>,
) -> Result<(), AppError> {
    if state.config.open_registration {
        return Ok(());
    }
    let live = match invite_token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => crate::api::invite_links::token_is_live(&state.db, t).await?,
        None => false,
    };
    if live {
        return Ok(());
    }
    Err(AppError::Forbidden(
        "self-service registration is disabled on this instance (a valid invite link is required)"
            .into(),
    ))
}

/// POST /api/v1/auth/register/request-code (public) — email a one-time verification
/// code the caller must then present to `POST /auth/register`. Gated by
/// `config.open_registration` and rate-limited (shares the sign-up limiter, so code
/// requests + the final register call together can't be script-flooded). Unlike
/// forgot-password, this DOES reject an already-registered email: `register` would
/// fail on it anyway, so a clear signal here beats a confusing failure at the last
/// step (and self-service sign-up already reveals taken emails via that 409).
pub async fn register_request_code(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<RegisterCodeRequest>,
) -> Result<Json<Value>, AppError> {
    ensure_may_register(&state, body.invite_token.as_deref()).await?;
    let limiter = crate::infra::ratelimit::register_limiter();
    let key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }
    limiter.record_failure(&key); // every code request counts toward the anti-spam cap

    let email = body.email.trim().to_lowercase();
    if !looks_like_email(&email) {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    // Don't mint a verification code for an address that can't complete sign-up.
    // The `users.email` UNIQUE constraint spans soft-deleted rows (delete_user only
    // flips is_deleted), so `register`'s INSERT would 409 on any email already on
    // file — deleted or not. Mirror that here (no is_deleted filter) instead of
    // handing out a code that leads to a dead-end conflict.
    let taken = sqlx::query("SELECT 1 AS ok FROM users WHERE lower(email) = $1 LIMIT 1")
        .bind(&email)
        .fetch_optional(&state.db)
        .await?;
    if taken.is_some() {
        return Err(AppError::Conflict(
            "that email is already registered".into(),
        ));
    }

    let code = crate::infra::crypto::generate_email_code();
    let expires = chrono::Utc::now() + chrono::Duration::minutes(15);
    sqlx::query(
        "INSERT INTO email_codes (email, code, purpose, expires_at)
         VALUES ($1, $2, 'register', $3)",
    )
    .bind(&email)
    .bind(&code)
    .bind(expires)
    .execute(&state.db)
    .await?;
    crate::infra::email::send_registration_code(&state.config, &email, &code).await;

    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub email: String,
    /// One-time verification code from `POST /auth/register/request-code`.
    pub code: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Shareable invite-link token — see `RegisterCodeRequest::invite_token`.
    /// The client redeems it via `POST /invite-links/{token}/accept` right after
    /// this call's auto-login, so the new account lands in the workspace.
    #[serde(default)]
    pub invite_token: Option<String>,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
}

/// POST /api/v1/auth/register (public) — self-service sign-up. Creates a `member`
/// account and auto-logs-in (returns a token, like login). Gated by
/// `config.open_registration` and rate-limited; roles above `member` are never
/// self-assignable (admins are provisioned via `POST /users`).
pub async fn register(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<RegisterRequest>,
) -> Result<Response, AppError> {
    ensure_may_register(&state, body.invite_token.as_deref()).await?;
    let client = client_type(body.client.as_deref())?;
    let limiter = crate::infra::ratelimit::register_limiter();
    let key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }
    limiter.record_failure(&key);

    let username = body.username.trim().to_string();
    if username.is_empty() || username.chars().count() > 64 {
        return Err(AppError::BadRequest(
            "username is required (≤64 chars)".into(),
        ));
    }
    if body.password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AppError::BadRequest(format!(
            "password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    // Email is REQUIRED for self-service sign-up (so password reset always works).
    let email = body.email.trim().to_lowercase();
    if email.is_empty() {
        return Err(AppError::BadRequest("email is required".into()));
    }
    if !looks_like_email(&email) {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    // Prove ownership of the email: consume a code minted by request-code above.
    let code = body.code.trim().to_uppercase(); // codes use an uppercase alphabet
    let valid = sqlx::query(
        "SELECT 1 AS ok FROM email_codes
         WHERE email = $1 AND code = $2 AND purpose = 'register'
           AND used = FALSE AND expires_at > NOW()
         LIMIT 1",
    )
    .bind(&email)
    .bind(&code)
    .fetch_optional(&state.db)
    .await?;
    if valid.is_none() {
        return Err(AppError::BadRequest(
            "invalid or expired verification code".into(),
        ));
    }
    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let hash = crate::infra::crypto::hash_password(body.password.clone())
        .await
        .map_err(|e| AppError::Internal(format!("hash: {e}")))?;
    let user_id = Uuid::new_v4();

    let res = sqlx::query(
        "INSERT INTO users (user_id, username, email, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4, $5, 'member')",
    )
    .bind(user_id.to_string())
    .bind(&username)
    .bind(&email)
    .bind(&hash)
    .bind(&display_name)
    .execute(&state.db)
    .await;
    if let Err(e) = res {
        if e.as_database_error()
            .is_some_and(DatabaseError::is_unique_violation)
        {
            return Err(AppError::Conflict("username or email already taken".into()));
        }
        return Err(AppError::Db(e));
    }

    // Burn this + any other live register codes for the email (single-use).
    sqlx::query(
        "UPDATE email_codes SET used = TRUE
         WHERE email = $1 AND purpose = 'register' AND used = FALSE",
    )
    .bind(&email)
    .execute(&state.db)
    .await?;

    // Auto-login goes through the same session issuer as every other provider.
    let user = auth::load_auth_user(&state.db, &user_id.to_string()).await?;
    let session = auth_sessions::finalize_login(
        &state.db,
        &state.config,
        &user,
        client,
        body.device_name.as_deref(),
    )
    .await?;
    let refresh = session.refresh_token.clone();
    let csrf = session.csrf_token.clone();
    let body = session_response(&user, session, client)?;
    Ok(if client == auth_sessions::ClientType::Web {
        response_with_session_cookies(body, Some(&refresh), Some(&csrf))
    } else {
        Json(body).into_response()
    })
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
    #[serde(default)]
    pub two_factor_code: Option<String>,
}

/// POST /api/v1/auth/change-password — the authenticated user rotates their own
/// password. Verifies the current password, stores the new hash, and bumps
/// `token_version` so every OTHER session is force-logged-out; a fresh token is
/// returned so THIS session keeps working.
pub async fn change_password(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Json<Value>, AppError> {
    if body.new_password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AppError::BadRequest(format!(
            "new password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    let row = sqlx::query(
        "SELECT password_hash, role, token_version FROM users
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let hashed: Option<String> = row.try_get("password_hash").map_err(AppError::Db)?;
    let hashed = hashed.ok_or_else(|| {
        AppError::BadRequest(
            "this account has no password; add one from Sign in with Apple settings".into(),
        )
    })?;
    if !crate::infra::crypto::verify_password(body.current_password.clone(), hashed)
        .await
        .unwrap_or(false)
    {
        return Err(AppError::Unauthorized(
            "current password is incorrect".into(),
        ));
    }
    let master_key = two_factor::master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    two_factor::ensure_valid_code_if_enabled(
        &state.db,
        &claims.sub,
        body.two_factor_code.as_deref(),
        &master_key,
    )
    .await?;
    let new_hash = crate::infra::crypto::hash_password(body.new_password.clone())
        .await
        .map_err(|e| AppError::Internal(format!("hash: {e}")))?;

    // Revoke all existing tokens (other devices) by bumping the version.
    sqlx::query(
        "UPDATE users SET password_hash = $2, token_version = token_version + 1
         WHERE user_id = $1",
    )
    .bind(&claims.sub)
    .bind(&new_hash)
    .execute(&state.db)
    .await?;
    // Tear down live WS sessions authenticated with the now-stale version; the
    // caller's own client reconnects with the fresh token returned below.
    if let Ok(uid) = claims.sub.parse::<Uuid>() {
        state.fanout.kick_user(uid);
    }
    // Push subscriptions belong to devices, not sessions — a password change
    // (typically "device lost/compromised") must silence them all; the user's
    // own device re-enables via the Settings toggle.
    crate::infra::web_push::revoke_user_subscriptions(&state.db, &claims.sub).await;

    auth_sessions::revoke_all_sessions(&state.db, &claims.sub).await?;
    let user = auth::load_auth_user(&state.db, &claims.sub).await?;
    let session = auth_sessions::finalize_login(
        &state.db,
        &state.config,
        &user,
        auth_sessions::ClientType::Web,
        None,
    )
    .await?;

    Ok(Json(
        json!({ "ok": true, "access_token": session.access_token, "expires_in": session.expires_in }),
    ))
}

/// POST /api/v1/auth/logout — server-side revocation. Bumps the caller's
/// `token_version`, invalidating every token they hold (this session + other
/// devices). The client also clears its local token.
pub async fn logout(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Response, AppError> {
    auth_sessions::revoke_all_sessions(&state.db, &claims.sub).await?;
    // Revocation must reach live sockets too, not just future HTTP requests.
    if let Ok(uid) = claims.sub.parse::<Uuid>() {
        state.fanout.kick_user(uid);
    }
    // Logout revokes every session, so no device should keep receiving
    // lock-screen pushes either.
    crate::infra::web_push::revoke_user_subscriptions(&state.db, &claims.sub).await;
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().append(
        axum::http::header::SET_COOKIE,
        clear_auth_cookie("cheers_refresh")
            .parse()
            .expect("valid cookie header"),
    );
    response.headers_mut().append(
        axum::http::header::SET_COOKIE,
        clear_auth_cookie("cheers_csrf")
            .parse()
            .expect("valid cookie header"),
    );
    response.headers_mut().append(
        axum::http::header::SET_COOKIE,
        clear_auth_cookie("cheers_trusted_device")
            .parse()
            .expect("valid cookie header"),
    );
    Ok(response)
}

#[derive(Deserialize)]
pub struct RefreshRequest {
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub csrf_token: Option<String>,
}

/// POST /api/v1/auth/refresh. Browser callers use the HttpOnly cookie and an
/// Origin-bound CSRF header; native callers may submit the Keychain token.
pub async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RefreshRequest>,
) -> Result<Response, AppError> {
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        if !state
            .config
            .allowed_origins()
            .iter()
            .any(|allowed| allowed == origin)
        {
            return Err(AppError::Forbidden("refresh origin is not allowed".into()));
        }
    }
    let refresh_token = body
        .refresh_token
        .or_else(|| parse_cookie(&headers, "cheers_refresh"))
        .ok_or_else(|| AppError::Unauthorized("refresh token is required".into()))?;
    let csrf = body
        .csrf_token
        .or_else(|| {
            headers
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        })
        .or_else(|| parse_cookie(&headers, "cheers_csrf"));
    let rotated = auth_sessions::rotate_refresh_token(
        &state.db,
        &state.config,
        &refresh_token,
        csrf.as_deref(),
    )
    .await?;
    let client = sqlx::query_scalar::<_, String>(
        "SELECT client_type FROM auth_sessions WHERE session_id = $1",
    )
    .bind(&rotated.session_id)
    .fetch_one(&state.db)
    .await?;
    let is_web = client == "web";
    let body = LoginResponse {
        status: "authenticated".into(),
        transaction_id: None,
        allowed_factors: Vec::new(),
        expires_in: Some(rotated.expires_in),
        requires_2fa: false,
        two_factor_session_id: None,
        access_token: Some(rotated.access_token),
        token_type: Some("bearer".into()),
        user_id: Some(rotated.user.id.clone()),
        username: Some(rotated.user.username.clone()),
        display_name: rotated.user.display_name.clone(),
        role: Some(rotated.user.role.clone()),
        refresh_token: (!is_web).then_some(rotated.refresh_token.clone()),
        csrf_token: (!is_web).then_some(rotated.csrf_token.clone().unwrap_or_default()),
        trusted_device: None,
    };
    Ok(if is_web {
        response_with_session_cookies(
            body,
            Some(&rotated.refresh_token),
            rotated.csrf_token.as_deref(),
        )
    } else {
        Json(body).into_response()
    })
}

pub async fn logout_current(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    auth_sessions::revoke_session(&state.db, &claims.sub, &claims.sid).await?;
    if let Ok(uid) = claims.sub.parse::<Uuid>() {
        state.fanout.kick_user(uid);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn logout_all(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    auth_sessions::revoke_all_sessions(&state.db, &claims.sub).await?;
    if let Ok(uid) = claims.sub.parse::<Uuid>() {
        state.fanout.kick_user(uid);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_sessions(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<auth_sessions::SessionSummary>>, AppError> {
    Ok(Json(
        auth_sessions::list_sessions(&state.db, &claims.sub, &claims.sid).await?,
    ))
}

pub async fn revoke_session(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
) -> Result<Json<Value>, AppError> {
    if !auth_sessions::revoke_session(&state.db, &claims.sub, &session_id).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn capabilities(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<CapabilitiesQuery>,
) -> Json<Value> {
    let client = query.client.unwrap_or_else(|| "web".into());
    let browser_client = client == "web" || client == "macos";
    let apple_web =
        state.config.apple_auth.as_ref().is_some_and(|config| {
            config.web_client_id.is_some() && config.web_redirect_uri.is_some()
        });
    let apple_enabled = if browser_client {
        apple_web && (client != "web" || state.config.oauth_web_return_url.is_some())
    } else {
        state.config.apple_auth.is_some()
    };
    let google_enabled = state.config.google_auth.is_some()
        && (client != "web" || state.config.oauth_web_return_url.is_some());
    let passkey_enabled = state.webauthn.is_some();
    Json(json!({
        "client": client,
        "providers": {
            "password": true,
            "apple": apple_enabled,
            "google": google_enabled,
        },
        "passkey": passkey_enabled,
        "passkey_rp_id": state.webauthn.as_ref().map(|w| w.rp_id()),
        "password_login": true,
        "sign_in_with_apple": apple_enabled,
        "apple_client_id": state.config.apple_auth.as_ref().and_then(|value| {
            if browser_client { value.web_client_id.clone() } else { Some(value.client_id.clone()) }
        }),
        "self_service_registration": state.config.open_registration,
        "registration": { "open": state.config.open_registration, "invite_required": !state.config.open_registration },
        "session": { "access_token_ttl_seconds": auth_sessions::ACCESS_TOKEN_TTL_SECONDS, "refresh_idle_days": 30, "trusted_device_days": 30 }
    }))
}

#[derive(Deserialize)]
pub struct CapabilitiesQuery {
    pub client: Option<String>,
}

#[derive(Deserialize)]
pub struct ForgotPasswordRequest {
    pub email: String,
}

/// POST /api/v1/auth/forgot-password (public) — mails a one-time reset code if the
/// email belongs to an account. ALWAYS returns 200 (never reveals whether an email
/// exists — user-enumeration hardening). Rate-limited per client.
pub async fn forgot_password(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<ForgotPasswordRequest>,
) -> Result<Json<Value>, AppError> {
    let limiter = crate::infra::ratelimit::password_reset_limiter();
    let key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }
    limiter.record_failure(&key); // every request counts toward the anti-spam cap

    let email = body.email.trim().to_lowercase();
    if !email.is_empty() {
        let found = sqlx::query(
            "SELECT user_id FROM users WHERE lower(email) = $1 AND is_deleted = FALSE LIMIT 1",
        )
        .bind(&email)
        .fetch_optional(&state.db)
        .await?;
        if found.is_some() {
            let code = crate::infra::crypto::generate_email_code();
            let expires = chrono::Utc::now() + chrono::Duration::minutes(15);
            sqlx::query(
                "INSERT INTO email_codes (email, code, purpose, expires_at)
                 VALUES ($1, $2, 'password_reset', $3)",
            )
            .bind(&email)
            .bind(&code)
            .bind(expires)
            .execute(&state.db)
            .await?;
            crate::infra::email::send_password_reset_code(&state.config, &email, &code).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    pub email: String,
    pub code: String,
    pub new_password: String,
}

/// POST /api/v1/auth/reset-password (public) — consumes a valid reset code, sets the
/// new password, and revokes every existing session (token_version bump). Rate-limited.
pub async fn reset_password(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<Value>, AppError> {
    let limiter = crate::infra::ratelimit::password_reset_limiter();
    let key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }
    if body.new_password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(AppError::BadRequest(format!(
            "new password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    let email = body.email.trim().to_lowercase();
    let code = body.code.trim().to_uppercase(); // codes use an uppercase alphabet

    let valid = sqlx::query(
        "SELECT 1 AS ok FROM email_codes
         WHERE email = $1 AND code = $2 AND purpose = 'password_reset'
           AND used = FALSE AND expires_at > NOW()
         LIMIT 1",
    )
    .bind(&email)
    .bind(&code)
    .fetch_optional(&state.db)
    .await?;
    if valid.is_none() {
        limiter.record_failure(&key); // wrong/expired code counts toward the brute-force cap
        return Err(AppError::BadRequest("invalid or expired code".into()));
    }

    let user = sqlx::query(
        "SELECT user_id FROM users WHERE lower(email) = $1 AND is_deleted = FALSE LIMIT 1",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let user_id: String = user.try_get("user_id").map_err(AppError::Db)?;

    let hash = crate::infra::crypto::hash_password(body.new_password.clone())
        .await
        .map_err(|e| AppError::Internal(format!("hash: {e}")))?;
    sqlx::query(
        "UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE user_id = $1",
    )
    .bind(&user_id)
    .bind(&hash)
    .execute(&state.db)
    .await?;
    // Revocation must reach live sockets too (a reset usually means the old
    // credential is considered compromised).
    if let Ok(uid) = user_id.parse::<Uuid>() {
        state.fanout.kick_user(uid);
    }
    // …and push subscriptions: a compromised-credential reset must silence
    // every previously-enrolled device.
    crate::infra::web_push::revoke_user_subscriptions(&state.db, &user_id).await;
    // Burn this + any other live reset codes for the email.
    sqlx::query(
        "UPDATE email_codes SET used = TRUE
         WHERE email = $1 AND purpose = 'password_reset' AND used = FALSE",
    )
    .bind(&email)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Two-factor authentication (TOTP) ───────────────────────────────────────

#[derive(Serialize)]
pub struct TwoFactorSetupResponse {
    pub secret: String,
    pub provisioning_uri: String,
}

#[derive(Deserialize)]
pub struct TwoFactorEnableRequest {
    pub code: String,
}

#[derive(Serialize)]
pub struct TwoFactorEnableResponse {
    pub backup_codes: Vec<String>,
}

#[derive(Deserialize)]
pub struct TwoFactorVerifyRequest {
    #[serde(default)]
    pub transaction_id: Option<String>,
    #[serde(default)]
    pub two_factor_session_id: Option<String>,
    pub code: String,
    #[serde(default)]
    pub remember_device: bool,
}

#[derive(Deserialize)]
pub struct TwoFactorDisableRequest {
    pub code: String,
}

#[derive(Serialize)]
pub struct TwoFactorStatusResponse {
    pub enabled: bool,
}

/// GET /api/v1/auth/2fa/status — whether TOTP 2FA is currently enabled for the caller.
pub async fn two_factor_status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<TwoFactorStatusResponse>, AppError> {
    let status = two_factor::status(&state.db, &claims.sub).await?;
    Ok(Json(TwoFactorStatusResponse {
        enabled: status.enabled,
    }))
}

/// POST /api/v1/auth/2fa/setup — generate a TOTP secret for the caller.
/// The secret is stored encrypted but not yet enabled; the caller must verify
/// a code via `/auth/2fa/enable` to activate 2FA.
pub async fn setup_two_factor(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<TwoFactorSetupResponse>, AppError> {
    let current = two_factor::status(&state.db, &claims.sub).await?;
    if current.enabled {
        return Err(AppError::BadRequest(
            "2FA is already enabled; disable it before starting a new setup".into(),
        ));
    }
    let master_key = two_factor::master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    let secret = crate::infra::totp::generate_secret();
    let row = sqlx::query("SELECT username FROM users WHERE user_id = $1 AND is_deleted = FALSE")
        .bind(&claims.sub)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    let username: String = row.try_get("username").map_err(AppError::Db)?;
    let provisioning_uri = crate::infra::totp::provisioning_uri(&secret, &username, "Cheers");
    two_factor::setup(&state.db, &claims.sub, &secret, &master_key).await?;
    Ok(Json(TwoFactorSetupResponse {
        secret,
        provisioning_uri,
    }))
}

/// POST /api/v1/auth/2fa/enable — verify the first TOTP code and activate 2FA.
/// Returns one-time backup codes; the client should store them securely.
pub async fn enable_two_factor(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<TwoFactorEnableRequest>,
) -> Result<Json<TwoFactorEnableResponse>, AppError> {
    let master_key = two_factor::master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    let backup_codes = two_factor::enable(&state.db, &claims.sub, &body.code, &master_key).await?;
    Ok(Json(TwoFactorEnableResponse { backup_codes }))
}

/// POST /api/v1/auth/2fa/disable — turn off 2FA after verifying a code.
pub async fn disable_two_factor(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<TwoFactorDisableRequest>,
) -> Result<Json<Value>, AppError> {
    let master_key = two_factor::master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    two_factor::verify_and_disable(&state.db, &claims.sub, &body.code, &master_key).await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/v1/auth/2fa/login — complete login when 2FA is enabled.
/// Consumes the intermediate session returned by `/auth/login` and issues a
/// normal access token after a TOTP code, backup code, or email OTP is verified.
pub async fn verify_two_factor_login(
    State(state): State<AppState>,
    Json(body): Json<TwoFactorVerifyRequest>,
) -> Result<Response, AppError> {
    let transaction_id = body
        .transaction_id
        .as_deref()
        .ok_or_else(|| AppError::Unauthorized("authentication transaction is required".into()))?;
    let (user_id, client, device_name) =
        auth_sessions::factor_transaction_user(&state.db, transaction_id).await?;
    let remember_device = body.remember_device;
    let master_key = two_factor::master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    let totp_ok = two_factor::verify_login(&state.db, &user_id, &body.code, &master_key).await?;
    let email_ok = if totp_ok {
        false
    } else {
        crate::domain::webauthn::consume_login_2fa_email_code(&state.db, &user_id, &body.code)
            .await?
    };
    if !totp_ok && !email_ok {
        auth_sessions::record_factor_failure(&state.db, transaction_id).await?;
        return Err(AppError::Unauthorized("invalid 2FA code".into()));
    }
    auth_sessions::consume_factor_transaction(&state.db, transaction_id).await?;
    let user = auth::load_auth_user(&state.db, &user_id).await?;
    let session = auth_sessions::finalize_login(
        &state.db,
        &state.config,
        &user,
        client,
        device_name.as_deref(),
    )
    .await?;
    let session_id = session.session_id.clone();
    let refresh = session.refresh_token.clone();
    let csrf = session.csrf_token.clone();
    let mut login_body = session_response(&user, session, client)?;
    if remember_device {
        let trusted = auth_sessions::issue_trusted_device(
            &state.db,
            &user.id,
            &session_id,
            device_name.as_deref(),
        )
        .await?;
        if client != auth_sessions::ClientType::Web {
            login_body.trusted_device = Some(trusted.clone());
        }
        let mut response = if client == auth_sessions::ClientType::Web {
            response_with_session_cookies(login_body, Some(&refresh), Some(&csrf))
        } else {
            Json(login_body).into_response()
        };
        response.headers_mut().append(
            axum::http::header::SET_COOKIE,
            auth_cookie("cheers_trusted_device", &trusted, true, 30 * 24 * 60 * 60)
                .parse()
                .expect("valid cookie header"),
        );
        return Ok(response);
    }
    Ok(if client == auth_sessions::ClientType::Web {
        response_with_session_cookies(login_body, Some(&refresh), Some(&csrf))
    } else {
        Json(login_body).into_response()
    })
}

#[derive(Deserialize)]
pub struct TwoFactorEmailSendRequest {
    pub transaction_id: String,
}

/// POST /api/v1/auth/2fa/email/send — mail a one-time code for the pending login
/// factor challenge. Requires a valid `factor_required` transaction.
pub async fn send_two_factor_email(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(body): Json<TwoFactorEmailSendRequest>,
) -> Result<Json<Value>, AppError> {
    let limiter = crate::infra::ratelimit::login_2fa_email_limiter();
    let key = crate::infra::ratelimit::client_key(
        &headers,
        connect_info.map(|ConnectInfo(a)| a),
        state.config.trust_proxy_headers,
    );
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }
    limiter.record_failure(&key);

    let (user_id, _client, _device_name) =
        auth_sessions::factor_transaction_user(&state.db, &body.transaction_id).await?;
    let email = crate::domain::webauthn::user_email(&state.db, &user_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("no email on this account".into()))?;
    let code = crate::domain::webauthn::issue_login_2fa_email_code(&state.db, &email).await?;
    crate::infra::email::send_login_2fa_code(&state.config, &email, &code).await;
    Ok(Json(json!({
        "ok": true,
        "email_hint": crate::domain::webauthn::mask_email(&email),
    })))
}
