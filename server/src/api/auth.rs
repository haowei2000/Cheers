use axum::{extract::State, http::HeaderMap, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{error::DatabaseError, Row};
use uuid::Uuid;

use crate::{api::middleware::Claims, app_state::AppState, domain::auth, errors::AppError};

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
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub user_id: String,
    pub display_name: Option<String>,
    pub role: String,
}

/// POST /api/v1/auth/login
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    // Throttle brute-force / bcrypt-DoS (audit H3): cap failed attempts per
    // client source; a successful login clears the counter.
    let limiter = crate::infra::ratelimit::login_limiter();
    let key = crate::infra::ratelimit::client_key(&headers);
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

    let user_uuid: Uuid = user
        .id
        .parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;

    let token = auth::create_access_token(
        &state.config,
        user_uuid,
        &user.role,
        user.token_version as i64,
    )?;

    Ok(Json(LoginResponse {
        access_token: token,
        token_type: "bearer".into(),
        user_id: user.id,
        display_name: user.display_name,
        role: user.role,
    }))
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// POST /api/v1/auth/register (public) — self-service sign-up. Creates a `member`
/// account and auto-logs-in (returns a token, like login). Gated by
/// `config.open_registration` and rate-limited; roles above `member` are never
/// self-assignable (admins are provisioned via `POST /users`).
pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RegisterRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    if !state.config.open_registration {
        return Err(AppError::Forbidden(
            "self-service registration is disabled on this instance".into(),
        ));
    }
    let limiter = crate::infra::ratelimit::register_limiter();
    let key = crate::infra::ratelimit::client_key(&headers);
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
    if body.password.chars().count() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    // Email is REQUIRED for self-service sign-up (so password reset always works).
    let email = body
        .email
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_lowercase();
    if email.is_empty() {
        return Err(AppError::BadRequest("email is required".into()));
    }
    if !looks_like_email(&email) {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let hash = bcrypt::hash(&body.password, bcrypt::DEFAULT_COST)
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

    // Auto-login: a fresh account starts at token_version 0.
    let token = auth::create_access_token(&state.config, user_id, "member", 0)?;
    Ok(Json(LoginResponse {
        access_token: token,
        token_type: "bearer".into(),
        user_id: user_id.to_string(),
        display_name,
        role: "member".into(),
    }))
}

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
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
    if body.new_password.chars().count() < 8 {
        return Err(AppError::BadRequest(
            "new password must be at least 8 characters".into(),
        ));
    }
    let row = sqlx::query(
        "SELECT password_hash, role, token_version FROM users
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let hashed: String = row.try_get("password_hash").map_err(AppError::Db)?;
    if !bcrypt::verify(&body.current_password, &hashed).unwrap_or(false) {
        return Err(AppError::Unauthorized(
            "current password is incorrect".into(),
        ));
    }
    let new_hash = bcrypt::hash(&body.new_password, bcrypt::DEFAULT_COST)
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

    // Mint a fresh token at the new version so the current caller stays signed in.
    let new_version = row.try_get::<i32, _>("token_version").unwrap_or(0) as i64 + 1;
    let role: String = row.try_get("role").unwrap_or_else(|_| "member".into());
    let user_uuid: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("invalid user id".into()))?;
    let token = auth::create_access_token(&state.config, user_uuid, &role, new_version)?;

    Ok(Json(json!({ "ok": true, "access_token": token })))
}

/// POST /api/v1/auth/logout — server-side revocation. Bumps the caller's
/// `token_version`, invalidating every token they hold (this session + other
/// devices). The client also clears its local token.
pub async fn logout(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE user_id = $1")
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
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
    headers: HeaderMap,
    Json(body): Json<ForgotPasswordRequest>,
) -> Result<Json<Value>, AppError> {
    let limiter = crate::infra::ratelimit::password_reset_limiter();
    let key = crate::infra::ratelimit::client_key(&headers);
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
    headers: HeaderMap,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<Value>, AppError> {
    let limiter = crate::infra::ratelimit::password_reset_limiter();
    let key = crate::infra::ratelimit::client_key(&headers);
    if let Some(retry_after_secs) = limiter.retry_after(&key) {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }
    if body.new_password.chars().count() < 8 {
        return Err(AppError::BadRequest(
            "new password must be at least 8 characters".into(),
        ));
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

    let hash = bcrypt::hash(&body.new_password, bcrypt::DEFAULT_COST)
        .map_err(|e| AppError::Internal(format!("hash: {e}")))?;
    sqlx::query(
        "UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE user_id = $1",
    )
    .bind(&user_id)
    .bind(&hash)
    .execute(&state.db)
    .await?;
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
