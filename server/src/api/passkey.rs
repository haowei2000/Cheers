//! Passkey / WebAuthn HTTP handlers.

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};

use crate::{
    api::{auth, middleware::Claims},
    app_state::AppState,
    domain::{auth as auth_domain, auth_sessions, webauthn},
    errors::AppError,
};

fn require_webauthn(state: &AppState) -> Result<&webauthn::WebauthnService, AppError> {
    state
        .webauthn
        .as_deref()
        .ok_or_else(|| {
            AppError::ServiceUnavailable(
                "passkeys are not configured on this server (set WEBAUTHN_RP_ID and WEBAUTHN_RP_ORIGIN)"
                    .into(),
            )
        })
}

#[derive(Deserialize)]
pub struct RegisterOptionsRequest {
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize)]
pub struct RegisterFinishRequest {
    pub transaction_id: String,
    pub credential: RegisterPublicKeyCredential,
}

#[derive(Deserialize)]
pub struct FactorPasskeyOptionsRequest {
    pub transaction_id: String,
}

#[derive(Deserialize)]
pub struct FactorPasskeyVerifyRequest {
    pub transaction_id: String,
    pub credential: PublicKeyCredential,
    #[serde(default)]
    pub remember_device: bool,
}

/// POST /api/v1/auth/passkey/register/options
pub async fn register_options(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<RegisterOptionsRequest>,
) -> Result<Json<Value>, AppError> {
    let service = require_webauthn(&state)?;
    let row = sqlx::query(
        "SELECT username, display_name FROM users
         WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(&claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let username: String = row.get("username");
    let display_name: Option<String> = row.try_get("display_name").ok().flatten();
    let display = display_name.as_deref().unwrap_or(username.as_str());
    let (options, transaction_id) = webauthn::start_registration_with_tx(
        &state.db,
        service,
        &claims.sub,
        &username,
        display,
        body.name,
    )
    .await?;
    let mut payload = serde_json::to_value(&options)
        .map_err(|e| AppError::Internal(format!("serialize registration options: {e}")))?;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("transaction_id".into(), json!(transaction_id));
        obj.insert("rp_id".into(), json!(service.rp_id()));
        obj.insert("rp_name".into(), json!(service.rp_name()));
    }
    Ok(Json(payload))
}

/// POST /api/v1/auth/passkey/register/finish
pub async fn register_finish(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<RegisterFinishRequest>,
) -> Result<Json<webauthn::StoredCredential>, AppError> {
    let service = require_webauthn(&state)?;
    let stored = webauthn::finish_registration(
        &state.db,
        service,
        &claims.sub,
        &body.transaction_id,
        body.credential,
    )
    .await?;
    Ok(Json(stored))
}

/// GET /api/v1/auth/passkey/credentials
pub async fn list_credentials(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<webauthn::StoredCredential>>, AppError> {
    let _ = require_webauthn(&state)?;
    Ok(Json(
        webauthn::list_credentials(&state.db, &claims.sub).await?,
    ))
}

/// DELETE /api/v1/auth/passkey/credentials/:credential_pk
pub async fn delete_credential(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(credential_pk): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _ = require_webauthn(&state)?;
    webauthn::delete_credential(&state.db, &claims.sub, &credential_pk).await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/v1/auth/2fa/passkey/options — begin assertion for a login factor transaction.
pub async fn factor_options(
    State(state): State<AppState>,
    Json(body): Json<FactorPasskeyOptionsRequest>,
) -> Result<Json<Value>, AppError> {
    let service = require_webauthn(&state)?;
    let (user_id, _client, _device) =
        auth_sessions::factor_transaction_user(&state.db, &body.transaction_id).await?;
    let options =
        webauthn::start_authentication(&state.db, service, &user_id, &body.transaction_id).await?;
    let mut payload = serde_json::to_value(&options)
        .map_err(|e| AppError::Internal(format!("serialize assertion options: {e}")))?;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("rp_id".into(), json!(service.rp_id()));
    }
    Ok(Json(payload))
}

/// POST /api/v1/auth/2fa/passkey/verify — complete login with a passkey assertion.
pub async fn factor_verify(
    State(state): State<AppState>,
    Json(body): Json<FactorPasskeyVerifyRequest>,
) -> Result<Response, AppError> {
    let service = require_webauthn(&state)?;
    let (user_id, client, device_name) =
        auth_sessions::factor_transaction_user(&state.db, &body.transaction_id).await?;
    if let Err(err) = webauthn::finish_authentication(
        &state.db,
        service,
        &user_id,
        &body.transaction_id,
        body.credential,
    )
    .await
    {
        let _ = auth_sessions::record_factor_failure(&state.db, &body.transaction_id).await;
        return Err(err);
    }
    auth_sessions::consume_factor_transaction(&state.db, &body.transaction_id).await?;
    let user = auth_domain::load_auth_user(&state.db, &user_id).await?;
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
    let mut login_body = auth::session_response(&user, session, client)?;
    if body.remember_device {
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
            auth::response_with_session_cookies(login_body, Some(&refresh), Some(&csrf))
        } else {
            Json(login_body).into_response()
        };
        response.headers_mut().append(
            axum::http::header::SET_COOKIE,
            format!(
                "cheers_trusted_device={trusted}; Max-Age={}; Path=/; Secure; HttpOnly; SameSite=Lax",
                30 * 24 * 60 * 60
            )
            .parse()
            .expect("valid cookie header"),
        );
        return Ok(response);
    }
    Ok(if client == auth_sessions::ClientType::Web {
        auth::response_with_session_cookies(login_body, Some(&refresh), Some(&csrf))
    } else {
        Json(login_body).into_response()
    })
}
