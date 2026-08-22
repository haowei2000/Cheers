//! Unified login and in-session step-up authentication flows.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;
use webauthn_rs::prelude::PublicKeyCredential;

use crate::{
    api::{auth, middleware::Claims},
    app_state::AppState,
    domain::{auth as auth_domain, auth_sessions, two_factor, webauthn},
    errors::AppError,
    infra::crypto,
};

const FLOW_TTL_MINUTES: i64 = 10;
const MAX_ATTEMPTS: i16 = 5;
const EMAIL_PURPOSE: &str = "auth_flow";

#[derive(Deserialize)]
pub struct StartRequest {
    pub purpose: String,
    pub identifier: Option<String>,
    pub client: Option<String>,
    pub device_name: Option<String>,
    pub action_class: Option<String>,
}

#[derive(Deserialize)]
pub struct PasswordRequest {
    pub password: String,
}

#[derive(Deserialize)]
pub struct CodeRequest {
    pub code: String,
}

#[derive(Deserialize)]
pub struct PasskeyRequest {
    pub credential: PublicKeyCredential,
}

pub async fn cancel(
    State(state): State<AppState>,
    claims: Option<Extension<Claims>>,
    Path(transaction_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let flow = load_flow(
        &state,
        &transaction_id,
        claims.as_ref().map(|value| &value.0),
    )
    .await?;
    sqlx::query(
        "UPDATE auth_transactions
         SET status = 'failed', consumed_at = NOW(), updated_at = NOW()
         WHERE transaction_id = $1 AND consumed_at IS NULL",
    )
    .bind(&flow.transaction_id)
    .execute(&state.db)
    .await?;
    record_event(
        &state,
        flow.user_id.as_deref(),
        flow.session_id.as_deref(),
        "auth_flow_cancelled",
        None,
        json!({
            "purpose": flow.kind,
            "action_class": flow.context["action_class"],
        }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

struct Flow {
    transaction_id: String,
    kind: String,
    status: String,
    user_id: Option<String>,
    session_id: Option<String>,
    client: auth_sessions::ClientType,
    context: Value,
    failed_attempts: i16,
}

pub async fn start(
    State(state): State<AppState>,
    claims: Option<Extension<Claims>>,
    Json(body): Json<StartRequest>,
) -> Result<Json<Value>, AppError> {
    let client = auth_sessions::ClientType::parse(body.client.as_deref())?;
    let (kind, user_id, session_id, identifier) = match body.purpose.as_str() {
        "step_up" => {
            let claims = claims
                .as_ref()
                .ok_or_else(|| AppError::Unauthorized("authentication required".into()))?;
            (
                "step_up",
                Some(claims.sub.clone()),
                Some(claims.sid.clone()),
                None,
            )
        }
        "login" => {
            let identifier = body
                .identifier
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::BadRequest("identifier required".into()))?
                .to_lowercase();
            let user_id = sqlx::query_scalar::<_, String>(
                "SELECT user_id FROM users
                 WHERE is_deleted = FALSE
                   AND (LOWER(username) = $1 OR LOWER(email) = $1)",
            )
            .bind(&identifier)
            .fetch_optional(&state.db)
            .await?;
            ("login", user_id, None, Some(identifier))
        }
        _ => return Err(AppError::BadRequest("purpose must be login|step_up".into())),
    };

    let transaction_id = Uuid::new_v4().to_string();
    let context = json!({
        "identifier": identifier,
        "device_name": body.device_name,
        "action_class": normalize_action_class(body.action_class.as_deref()),
    });
    sqlx::query(
        "INSERT INTO auth_transactions
         (transaction_id, user_id, session_id, kind, status, client_type,
          context_json, expires_at)
         VALUES ($1, $2, $3, $4, 'method_required', $5, $6,
                 NOW() + INTERVAL '10 minutes')",
    )
    .bind(&transaction_id)
    .bind(&user_id)
    .bind(&session_id)
    .bind(kind)
    .bind(client.as_str())
    .bind(context)
    .execute(&state.db)
    .await?;

    let methods = available_methods(&state, user_id.as_deref(), kind == "login").await?;
    record_event(
        &state,
        user_id.as_deref(),
        session_id.as_deref(),
        "auth_flow_started",
        None,
        json!({ "purpose": kind }),
    )
    .await;
    Ok(Json(json!({
        "transaction_id": transaction_id,
        "status": "method_required",
        "methods": methods,
        "expires_in": FLOW_TTL_MINUTES * 60,
    })))
}

pub async fn password(
    State(state): State<AppState>,
    claims: Option<Extension<Claims>>,
    Path(transaction_id): Path<String>,
    Json(body): Json<PasswordRequest>,
) -> Result<Response, AppError> {
    let flow = load_flow(&state, &transaction_id, claims.as_ref().map(|v| &v.0)).await?;
    let user_id = flow
        .user_id
        .as_deref()
        .ok_or_else(|| invalid_factor("password"))?;
    let hash = sqlx::query_scalar::<_, String>(
        "SELECT password_hash FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let valid = match hash {
        Some(hash) => crypto::verify_password(body.password, hash)
            .await
            .unwrap_or(false),
        None => false,
    };
    if !valid {
        fail_attempt(&state, &flow, "password").await?;
        return Err(invalid_factor("password"));
    }
    complete_primary(&state, flow, "password").await
}

pub async fn send_email(
    State(state): State<AppState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    claims: Option<Extension<Claims>>,
    Path(transaction_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let flow = load_flow(&state, &transaction_id, claims.as_ref().map(|v| &v.0)).await?;
    let limiter = crate::infra::ratelimit::login_2fa_email_limiter();
    let source_key = format!(
        "flow-source:{}",
        crate::infra::ratelimit::client_key(
            &headers,
            connect_info.map(|ConnectInfo(address)| address),
            state.config.trust_proxy_headers,
        )
    );
    let identifier = flow
        .user_id
        .as_deref()
        .or_else(|| flow.context["identifier"].as_str())
        .unwrap_or("unknown");
    let identifier_key = format!("flow-identifier:{}", crypto::sha256_hex(identifier));
    if let Some(retry_after_secs) = limiter
        .retry_after(&source_key)
        .or_else(|| limiter.retry_after(&identifier_key))
    {
        return Err(AppError::TooManyRequests { retry_after_secs });
    }
    limiter.record_failure(&source_key);
    limiter.record_failure(&identifier_key);
    if let Some(user_id) = flow.user_id.as_deref() {
        if let Some(email) = webauthn::user_email(&state.db, user_id).await? {
            let normalized_email = email.trim().to_lowercase();
            let cooling_down: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM email_codes
                    WHERE email = $1 AND purpose = $2 AND used = FALSE
                      AND created_at > NOW() - INTERVAL '60 seconds'
                      AND expires_at > NOW()
                 )",
            )
            .bind(&normalized_email)
            .bind(EMAIL_PURPOSE)
            .fetch_one(&state.db)
            .await?;
            if cooling_down {
                return Ok(Json(
                    json!({ "ok": true, "expires_in": 600, "retry_after": 60 }),
                ));
            }
            sqlx::query(
                "UPDATE email_codes SET used = TRUE
                 WHERE email = $1 AND purpose = $2 AND used = FALSE",
            )
            .bind(&normalized_email)
            .bind(EMAIL_PURPOSE)
            .execute(&state.db)
            .await?;
            let code = crypto::generate_email_code();
            let hash = crypto::hash_email_code(
                state.config.secret_store_key.as_deref(),
                &state.config.jwt_private_key_pem,
                &email,
                EMAIL_PURPOSE,
                &code,
            );
            sqlx::query(
                "INSERT INTO email_codes
                 (email, code, code_hash, purpose, expires_at)
                 VALUES ($1, NULL, $2, $3, NOW() + INTERVAL '10 minutes')",
            )
            .bind(&normalized_email)
            .bind(hash)
            .bind(EMAIL_PURPOSE)
            .execute(&state.db)
            .await?;
            crate::infra::email::send_login_2fa_code(&state.config, &email, &code).await;
        }
    }
    // Deliberately identical for missing users and missing email addresses.
    Ok(Json(json!({ "ok": true, "expires_in": 600 })))
}

pub async fn verify_email(
    State(state): State<AppState>,
    claims: Option<Extension<Claims>>,
    Path(transaction_id): Path<String>,
    Json(body): Json<CodeRequest>,
) -> Result<Response, AppError> {
    let flow = load_flow(&state, &transaction_id, claims.as_ref().map(|v| &v.0)).await?;
    let Some(user_id) = flow.user_id.as_deref() else {
        fail_attempt(&state, &flow, "email").await?;
        return Err(invalid_factor("email code"));
    };
    let email = webauthn::user_email(&state.db, user_id)
        .await?
        .ok_or_else(|| invalid_factor("email code"))?;
    let hash = crypto::hash_email_code(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
        &email,
        EMAIL_PURPOSE,
        &body.code,
    );
    let consumed = sqlx::query(
        "UPDATE email_codes SET used = TRUE
         WHERE email = $1 AND purpose = $2 AND code_hash = $3
           AND used = FALSE AND expires_at > NOW()",
    )
    .bind(email.trim().to_lowercase())
    .bind(EMAIL_PURPOSE)
    .bind(hash)
    .execute(&state.db)
    .await?;
    if consumed.rows_affected() != 1 {
        fail_attempt(&state, &flow, "email").await?;
        return Err(invalid_factor("email code"));
    }
    if two_factor::status(&state.db, user_id).await?.enabled {
        return require_second_factor(&state, &flow).await;
    }
    complete_primary(&state, flow, "email").await
}

pub async fn verify_totp(
    State(state): State<AppState>,
    claims: Option<Extension<Claims>>,
    Path(transaction_id): Path<String>,
    Json(body): Json<CodeRequest>,
) -> Result<Response, AppError> {
    let flow = load_flow(&state, &transaction_id, claims.as_ref().map(|v| &v.0)).await?;
    if !totp_allowed(&flow.kind, &flow.status) {
        return Err(AppError::Unauthorized(
            "a primary sign-in method is required before the second factor".into(),
        ));
    }
    let user_id = flow
        .user_id
        .as_deref()
        .ok_or_else(|| invalid_factor("verification code"))?;
    let key = two_factor::master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    if !two_factor::verify_login(&state.db, user_id, &body.code, &key).await? {
        fail_attempt(&state, &flow, "totp").await?;
        return Err(invalid_factor("verification code"));
    }
    complete_verified(&state, flow, "totp").await
}

pub async fn passkey_options(
    State(state): State<AppState>,
    claims: Option<Extension<Claims>>,
    Path(transaction_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let flow = load_flow(&state, &transaction_id, claims.as_ref().map(|v| &v.0)).await?;
    let user_id = flow
        .user_id
        .as_deref()
        .ok_or_else(|| invalid_factor("passkey"))?;
    let service = state.webauthn.as_deref().ok_or_else(|| {
        AppError::ServiceUnavailable("passkeys are not configured on this server".into())
    })?;
    let options =
        webauthn::start_authentication(&state.db, service, user_id, &transaction_id).await?;
    let mut payload = serde_json::to_value(options)
        .map_err(|error| AppError::Internal(format!("serialize passkey options: {error}")))?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("rp_id".into(), json!(service.rp_id()));
    }
    Ok(Json(payload))
}

pub async fn verify_passkey(
    State(state): State<AppState>,
    claims: Option<Extension<Claims>>,
    Path(transaction_id): Path<String>,
    Json(body): Json<PasskeyRequest>,
) -> Result<Response, AppError> {
    let flow = load_flow(&state, &transaction_id, claims.as_ref().map(|v| &v.0)).await?;
    let user_id = flow
        .user_id
        .as_deref()
        .ok_or_else(|| invalid_factor("passkey"))?;
    let service = state.webauthn.as_deref().ok_or_else(|| {
        AppError::ServiceUnavailable("passkeys are not configured on this server".into())
    })?;
    if let Err(error) = webauthn::finish_authentication(
        &state.db,
        service,
        user_id,
        &transaction_id,
        body.credential,
    )
    .await
    {
        fail_attempt(&state, &flow, "passkey").await?;
        return Err(error);
    }
    complete_verified(&state, flow, "passkey").await
}

async fn load_flow(
    state: &AppState,
    transaction_id: &str,
    claims: Option<&Claims>,
) -> Result<Flow, AppError> {
    let row = sqlx::query(
        "SELECT transaction_id, kind, status, user_id, session_id, client_type,
                context_json, failed_attempts, expires_at
         FROM auth_transactions
         WHERE transaction_id = $1 AND kind IN ('login', 'step_up')
           AND status IN ('method_required', 'factor_required', 'verified')
           AND consumed_at IS NULL",
    )
    .bind(transaction_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("invalid authentication transaction".into()))?;
    let expires_at: DateTime<Utc> = row.try_get("expires_at")?;
    let failed_attempts: i16 = row.try_get("failed_attempts").unwrap_or(0);
    if expires_at <= Utc::now() || failed_attempts >= MAX_ATTEMPTS {
        let status = if failed_attempts >= MAX_ATTEMPTS {
            "failed"
        } else {
            "expired"
        };
        sqlx::query(
            "UPDATE auth_transactions SET status = $2, updated_at = NOW()
             WHERE transaction_id = $1 AND consumed_at IS NULL",
        )
        .bind(transaction_id)
        .bind(status)
        .execute(&state.db)
        .await?;
        record_event(
            state,
            row.try_get::<Option<String>, _>("user_id")
                .ok()
                .flatten()
                .as_deref(),
            row.try_get::<Option<String>, _>("session_id")
                .ok()
                .flatten()
                .as_deref(),
            if status == "failed" {
                "auth_flow_locked"
            } else {
                "auth_flow_expired"
            },
            None,
            json!({}),
        )
        .await;
        return Err(AppError::Unauthorized(
            "authentication transaction expired".into(),
        ));
    }
    let kind: String = row.try_get("kind")?;
    let user_id: Option<String> = row.try_get("user_id").ok().flatten();
    let session_id: Option<String> = row.try_get("session_id").ok().flatten();
    if kind == "step_up" {
        let claims =
            claims.ok_or_else(|| AppError::Unauthorized("authentication required".into()))?;
        if user_id.as_deref() != Some(&claims.sub) || session_id.as_deref() != Some(&claims.sid) {
            return Err(AppError::Unauthorized(
                "authentication transaction belongs to another session".into(),
            ));
        }
    }
    Ok(Flow {
        transaction_id: row.try_get("transaction_id")?,
        kind,
        status: row.try_get("status")?,
        user_id,
        session_id,
        client: auth_sessions::ClientType::parse(Some(
            row.try_get::<String, _>("client_type")?.as_str(),
        ))?,
        context: row.try_get("context_json").unwrap_or_else(|_| json!({})),
        failed_attempts,
    })
}

async fn available_methods(
    state: &AppState,
    user_id: Option<&str>,
    login: bool,
) -> Result<Vec<String>, AppError> {
    let Some(user_id) = user_id else {
        return Ok(vec!["passkey".into(), "password".into(), "email".into()]);
    };
    let row = sqlx::query(
        "SELECT password_hash IS NOT NULL AS has_password,
                email IS NOT NULL AND email <> '' AS has_email,
                totp_enabled
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    let mut methods = Vec::new();
    if state.webauthn.is_some() && webauthn::user_has_passkeys(&state.db, user_id).await? {
        methods.push("passkey".into());
    }
    if row.try_get::<bool, _>("has_password").unwrap_or(false) {
        methods.push("password".into());
    }
    if row.try_get::<bool, _>("has_email").unwrap_or(false) {
        methods.push("email".into());
    }
    if !login && row.try_get::<bool, _>("totp_enabled").unwrap_or(false) {
        methods.push("totp".into());
        methods.push("recovery_code".into());
    }
    Ok(methods)
}

async fn complete_primary(
    state: &AppState,
    flow: Flow,
    factor: &str,
) -> Result<Response, AppError> {
    if flow.kind == "login" {
        let user_id = flow
            .user_id
            .as_deref()
            .ok_or_else(|| invalid_factor(factor))?;
        if two_factor::status(&state.db, user_id).await?.enabled && factor != "passkey" {
            return require_second_factor(state, &flow).await;
        }
    }
    complete_verified(state, flow, factor).await
}

async fn require_second_factor(state: &AppState, flow: &Flow) -> Result<Response, AppError> {
    sqlx::query(
        "UPDATE auth_transactions SET status = 'factor_required', updated_at = NOW()
         WHERE transaction_id = $1 AND consumed_at IS NULL",
    )
    .bind(&flow.transaction_id)
    .execute(&state.db)
    .await?;
    let mut methods = vec!["totp", "recovery_code"];
    if let Some(user_id) = flow.user_id.as_deref() {
        if state.webauthn.is_some() && webauthn::user_has_passkeys(&state.db, user_id).await? {
            methods.insert(0, "passkey");
        }
    }
    Ok(Json(json!({
        "transaction_id": flow.transaction_id,
        "status": "factor_required",
        "methods": methods,
        "expires_in": 600,
    }))
    .into_response())
}

async fn complete_verified(
    state: &AppState,
    flow: Flow,
    factor: &str,
) -> Result<Response, AppError> {
    let user_id = flow
        .user_id
        .as_deref()
        .ok_or_else(|| invalid_factor(factor))?;
    if flow.kind == "step_up" {
        let session_id = flow
            .session_id
            .as_deref()
            .ok_or_else(|| AppError::Unauthorized("step-up session missing".into()))?;
        let expires_at = auth_sessions::complete_step_up(
            &state.db,
            &flow.transaction_id,
            user_id,
            session_id,
            factor,
        )
        .await?;
        return Ok(Json(json!({
            "transaction_id": flow.transaction_id,
            "status": "verified",
            "step_up_expires_at": expires_at,
        }))
        .into_response());
    }

    let consumed = sqlx::query(
        "UPDATE auth_transactions
         SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
         WHERE transaction_id = $1 AND consumed_at IS NULL AND expires_at > NOW()",
    )
    .bind(&flow.transaction_id)
    .execute(&state.db)
    .await?;
    if consumed.rows_affected() != 1 {
        return Err(AppError::Unauthorized(
            "authentication transaction is invalid or already used".into(),
        ));
    }
    let user = auth_domain::load_auth_user(&state.db, user_id).await?;
    let session = auth_sessions::finalize_login(
        &state.db,
        &state.config,
        &user,
        flow.client,
        flow.context["device_name"].as_str(),
    )
    .await?;
    let refresh = session.refresh_token.clone();
    let csrf = session.csrf_token.clone();
    let outcome = auth::session_response(&user, session, flow.client)?;
    Ok(if flow.client == auth_sessions::ClientType::Web {
        auth::response_with_session_cookies(outcome, Some(&refresh), Some(&csrf))
    } else {
        Json(outcome).into_response()
    })
}

async fn fail_attempt(state: &AppState, flow: &Flow, factor: &str) -> Result<(), AppError> {
    let attempts = flow.failed_attempts + 1;
    sqlx::query(
        "UPDATE auth_transactions
         SET failed_attempts = LEAST(failed_attempts + 1, 5),
             status = CASE WHEN failed_attempts + 1 >= 5 THEN 'failed' ELSE status END,
             updated_at = NOW()
         WHERE transaction_id = $1 AND consumed_at IS NULL",
    )
    .bind(&flow.transaction_id)
    .execute(&state.db)
    .await?;
    record_event(
        state,
        flow.user_id.as_deref(),
        flow.session_id.as_deref(),
        if attempts >= MAX_ATTEMPTS {
            "auth_flow_locked"
        } else {
            "auth_flow_failed"
        },
        Some(factor),
        json!({
            "purpose": flow.kind,
            "attempt": attempts,
            "action_class": flow.context["action_class"],
        }),
    )
    .await;
    Ok(())
}

async fn record_event(
    state: &AppState,
    user_id: Option<&str>,
    session_id: Option<&str>,
    event_type: &str,
    factor: Option<&str>,
    metadata: Value,
) {
    let _ = sqlx::query(
        "INSERT INTO auth_security_events
         (event_id, user_id, session_id, event_type, factor, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(user_id)
    .bind(session_id)
    .bind(event_type)
    .bind(factor)
    .bind(metadata)
    .execute(&state.db)
    .await;
}

fn invalid_factor(label: &str) -> AppError {
    AppError::Unauthorized(format!("invalid {label}"))
}

fn normalize_action_class(value: Option<&str>) -> Option<String> {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .map(str::to_owned)
}

fn totp_allowed(kind: &str, status: &str) -> bool {
    kind == "step_up" || (kind == "login" && status == "factor_required")
}

#[cfg(test)]
mod tests {
    use super::{normalize_action_class, totp_allowed};

    #[test]
    fn login_totp_cannot_replace_the_primary_factor() {
        assert!(!totp_allowed("login", "method_required"));
        assert!(totp_allowed("login", "factor_required"));
        assert!(totp_allowed("step_up", "method_required"));
    }

    #[test]
    fn action_classes_are_fixed_safe_labels() {
        assert_eq!(
            normalize_action_class(Some("host_credential_rotation")).as_deref(),
            Some("host_credential_rotation")
        );
        assert_eq!(normalize_action_class(Some("bot/secret")), None);
        assert_eq!(normalize_action_class(Some("EmailAddress")), None);
    }
}
