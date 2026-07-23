//! Sign in with Apple for gateways explicitly configured with the official
//! app's Apple credentials. Unconfigured/self-hosted gateways fail closed and
//! advertise the feature as unavailable.

use axum::{extract::State, Extension, Json};
use chrono::{Duration, Utc};
use jsonwebtoken::{
    decode, decode_header, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    api::{auth::LoginResponse, middleware::Claims},
    app_state::AppState,
    config::AppleAuthConfig,
    domain::auth,
    errors::AppError,
    infra::crypto,
};

const APPLE_ISSUER: &str = "https://appleid.apple.com";
const APPLE_KEYS_URL: &str = "https://appleid.apple.com/auth/keys";
const APPLE_TOKEN_URL: &str = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL: &str = "https://appleid.apple.com/auth/revoke";

#[derive(Serialize)]
pub struct AuthCapabilities {
    password_login: bool,
    sign_in_with_apple: bool,
    apple_client_id: Option<String>,
    self_service_registration: bool,
}

pub async fn capabilities(State(state): State<AppState>) -> Json<AuthCapabilities> {
    let apple = state.config.apple_auth.as_ref();
    Json(AuthCapabilities {
        password_login: true,
        sign_in_with_apple: apple.is_some(),
        apple_client_id: apple.map(|v| v.client_id.clone()),
        self_service_registration: state.config.open_registration,
    })
}

#[derive(Serialize)]
pub struct AppleChallengeResponse {
    challenge_id: String,
    nonce: String,
    expires_at: chrono::DateTime<Utc>,
}

pub async fn challenge(
    State(state): State<AppState>,
) -> Result<Json<AppleChallengeResponse>, AppError> {
    require_config(&state)?;
    let challenge_id = Uuid::new_v4().to_string();
    let nonce = crypto::generate_auth_nonce();
    let nonce_hash = crypto::sha256_hex(&nonce);
    let expires_at = Utc::now() + Duration::minutes(10);
    sqlx::query(
        "INSERT INTO apple_auth_challenges (challenge_id, nonce_hash, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(&challenge_id)
    .bind(nonce_hash)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    Ok(Json(AppleChallengeResponse {
        challenge_id,
        nonce,
        expires_at,
    }))
}

#[derive(Deserialize)]
pub struct AppleAuthorizationRequest {
    pub challenge_id: String,
    pub identity_token: String,
    pub authorization_code: String,
    #[serde(default)]
    pub given_name: Option<String>,
    #[serde(default)]
    pub family_name: Option<String>,
    #[serde(default)]
    pub invite_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppleIdentityClaims {
    sub: String,
    #[serde(rename = "iss")]
    _iss: String,
    #[serde(rename = "aud")]
    _aud: String,
    #[serde(rename = "exp")]
    _exp: usize,
    nonce: Option<String>,
    email: Option<String>,
    email_verified: Option<Value>,
    is_private_email: Option<Value>,
}

#[derive(Deserialize)]
struct AppleJwks {
    keys: Vec<AppleJwk>,
}

#[derive(Deserialize)]
struct AppleJwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Serialize)]
struct AppleClientSecretClaims<'a> {
    iss: &'a str,
    iat: usize,
    exp: usize,
    aud: &'static str,
    sub: &'a str,
}

#[derive(Debug, Deserialize)]
struct AppleTokenResponse {
    refresh_token: Option<String>,
    id_token: String,
}

fn require_config(state: &AppState) -> Result<&AppleAuthConfig, AppError> {
    state.config.apple_auth.as_ref().ok_or_else(|| {
        AppError::ServiceUnavailable("Sign in with Apple is not configured on this server".into())
    })
}

fn client_secret(config: &AppleAuthConfig) -> Result<String, AppError> {
    let now = Utc::now().timestamp() as usize;
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(config.key_id.clone());
    encode(
        &header,
        &AppleClientSecretClaims {
            iss: &config.team_id,
            iat: now,
            exp: now + 300,
            aud: APPLE_ISSUER,
            sub: &config.client_id,
        },
        &EncodingKey::from_ec_pem(config.private_key_pem.as_bytes())
            .map_err(|e| AppError::Internal(format!("invalid Apple private key: {e}")))?,
    )
    .map_err(|e| AppError::Internal(format!("Apple client-secret signing failed: {e}")))
}

async fn consume_challenge(state: &AppState, id: &str) -> Result<String, AppError> {
    sqlx::query(
        "UPDATE apple_auth_challenges SET consumed_at = NOW()
         WHERE challenge_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
         RETURNING nonce_hash",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .and_then(|r| r.try_get("nonce_hash").ok())
    .ok_or_else(|| {
        AppError::Unauthorized(
            "Apple authentication challenge is invalid, expired, or already used".into(),
        )
    })
}

async fn verify_identity_token(
    config: &AppleAuthConfig,
    token: &str,
    expected_nonce: &str,
) -> Result<AppleIdentityClaims, AppError> {
    let header = decode_header(token)
        .map_err(|_| AppError::Unauthorized("invalid Apple identity token".into()))?;
    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("Apple token has no key id".into()))?;
    let keys: AppleJwks = reqwest::Client::new()
        .get(APPLE_KEYS_URL)
        .send()
        .await
        .map_err(|_| AppError::ServiceUnavailable("could not reach Apple identity service".into()))?
        .error_for_status()
        .map_err(|_| {
            AppError::ServiceUnavailable("Apple identity service rejected key request".into())
        })?
        .json()
        .await
        .map_err(|_| AppError::ServiceUnavailable("invalid Apple key response".into()))?;
    let key = keys
        .keys
        .into_iter()
        .find(|k| k.kid == kid)
        .ok_or_else(|| AppError::Unauthorized("Apple signing key not found".into()))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[APPLE_ISSUER]);
    validation.set_audience(&[config.client_id.as_str()]);
    let claims = decode::<AppleIdentityClaims>(
        token,
        &DecodingKey::from_rsa_components(&key.n, &key.e)
            .map_err(|_| AppError::Unauthorized("invalid Apple signing key".into()))?,
        &validation,
    )
    .map_err(|_| AppError::Unauthorized("Apple identity token verification failed".into()))?
    .claims;
    if claims.nonce.as_deref() != Some(expected_nonce) {
        return Err(AppError::Unauthorized("Apple nonce mismatch".into()));
    }
    Ok(claims)
}

async fn exchange_code(
    config: &AppleAuthConfig,
    code: &str,
) -> Result<AppleTokenResponse, AppError> {
    let response = reqwest::Client::new()
        .post(APPLE_TOKEN_URL)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", client_secret(config)?.as_str()),
            ("code", code),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|_| AppError::ServiceUnavailable("could not reach Apple token service".into()))?;
    if !response.status().is_success() {
        return Err(AppError::Unauthorized(
            "Apple authorization code was rejected".into(),
        ));
    }
    response
        .json()
        .await
        .map_err(|_| AppError::ServiceUnavailable("invalid Apple token response".into()))
}

async fn verify_authorization(
    state: &AppState,
    request: &AppleAuthorizationRequest,
) -> Result<(AppleIdentityClaims, AppleTokenResponse), AppError> {
    let config = require_config(state)?;
    let expected_nonce = consume_challenge(state, &request.challenge_id).await?;
    let claims = verify_identity_token(config, &request.identity_token, &expected_nonce).await?;
    let tokens = exchange_code(config, &request.authorization_code).await?;
    let exchanged_claims = verify_identity_token(config, &tokens.id_token, &expected_nonce).await?;
    if exchanged_claims.sub != claims.sub {
        return Err(AppError::Unauthorized(
            "Apple authorization code does not match the identity token".into(),
        ));
    }
    Ok((claims, tokens))
}

pub(crate) async fn verify_recent_for_user(
    state: &AppState,
    user_id: &str,
    request: &AppleAuthorizationRequest,
) -> Result<(), AppError> {
    let (apple, tokens) = verify_authorization(state, request).await?;
    let row = sqlx::query(
        "SELECT identity_id FROM auth_external_identities
         WHERE provider = 'apple' AND subject = $1 AND user_id = $2",
    )
    .bind(&apple.sub)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Apple account is not linked to this user".into()))?;
    let identity_id: String = row.try_get("identity_id")?;
    persist_refresh_token(state, &identity_id, tokens.refresh_token.as_deref()).await?;
    Ok(())
}

fn verified_email(claims: &AppleIdentityClaims) -> Option<String> {
    let verified = matches!(claims.email_verified.as_ref(), Some(Value::Bool(true)))
        || matches!(
            claims.email_verified.as_ref().and_then(Value::as_str),
            Some("true")
        );
    if !verified {
        return None;
    }
    claims
        .email
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_lowercase)
}

fn display_name(request: &AppleAuthorizationRequest) -> Option<String> {
    let name = [
        request.given_name.as_deref(),
        request.family_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|v| !v.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    (!name.is_empty()).then_some(name)
}

async fn persist_refresh_token(
    state: &AppState,
    identity_id: &str,
    refresh_token: Option<&str>,
) -> Result<(), AppError> {
    let Some(refresh_token) = refresh_token else {
        return Ok(());
    };
    let key = crypto::derive_master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    let encrypted = crypto::encrypt_secret(&key, refresh_token)
        .map_err(|e| AppError::Internal(format!("encrypt Apple refresh token: {e}")))?;
    sqlx::query(
        "INSERT INTO apple_auth_credentials (identity_id, refresh_token_encrypted, last_validated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (identity_id) DO UPDATE SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
             last_validated_at = NOW(), revoked_at = NULL, updated_at = NOW()",
    )
    .bind(identity_id).bind(encrypted).execute(&state.db).await?;
    Ok(())
}

async fn login_response(state: &AppState, user_id: &str) -> Result<LoginResponse, AppError> {
    let row = sqlx::query(
        "SELECT username, display_name, role, token_version, is_suspended
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    if row.try_get::<bool, _>("is_suspended").unwrap_or(false) {
        return Err(AppError::Forbidden("account suspended".into()));
    }
    let role: String = row.try_get("role").unwrap_or_else(|_| "member".into());
    let token_version = row.try_get::<i32, _>("token_version").unwrap_or(0) as i64;
    Ok(LoginResponse {
        requires_2fa: false,
        two_factor_session_id: None,
        access_token: Some(auth::create_access_token(
            state.config.as_ref(),
            user_id
                .parse()
                .map_err(|_| AppError::Internal("invalid user id".into()))?,
            &role,
            token_version,
        )?),
        token_type: Some("bearer".into()),
        user_id: Some(user_id.into()),
        username: Some(row.try_get("username").unwrap_or_default()),
        display_name: row.try_get("display_name").ok(),
        role: Some(role),
    })
}

pub async fn authorize(
    State(state): State<AppState>,
    Json(request): Json<AppleAuthorizationRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    let (apple, tokens) = verify_authorization(&state, &request).await?;
    if let Some(row) = sqlx::query(
        "SELECT identity_id, user_id FROM auth_external_identities WHERE provider = 'apple' AND subject = $1",
    ).bind(&apple.sub).fetch_optional(&state.db).await? {
        let identity_id: String = row.try_get("identity_id")?;
        let user_id: String = row.try_get("user_id")?;
        persist_refresh_token(&state, &identity_id, tokens.refresh_token.as_deref()).await?;
        return Ok(Json(login_response(&state, &user_id).await?));
    }

    crate::api::auth::ensure_may_register(&state, request.invite_token.as_deref()).await?;
    let email = verified_email(&apple);
    if let Some(email) = email.as_deref() {
        if sqlx::query("SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1")
            .bind(email)
            .fetch_optional(&state.db)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "account_link_required: sign in with your password, then link Apple in Settings"
                    .into(),
            ));
        }
    }
    let user_id = Uuid::new_v4().to_string();
    let identity_id = Uuid::new_v4().to_string();
    let username = format!(
        "apple_{}",
        Uuid::new_v4().simple().to_string()[..12].to_string()
    );
    let name = display_name(&request);
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO users (user_id, username, email, password_hash, display_name, role)
         VALUES ($1, $2, $3, NULL, $4, 'member')",
    )
    .bind(&user_id)
    .bind(&username)
    .bind(&email)
    .bind(&name)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO auth_external_identities
         (identity_id, provider, subject, user_id, corp_id, display_name, email, profile)
         VALUES ($1, 'apple', $2, $3, $4, $5, $6, $7)",
    )
    .bind(&identity_id)
    .bind(&apple.sub)
    .bind(&user_id)
    .bind(&require_config(&state)?.team_id)
    .bind(&name)
    .bind(&email)
    .bind(json!({"is_private_email": apple.is_private_email}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    persist_refresh_token(&state, &identity_id, tokens.refresh_token.as_deref()).await?;
    Ok(Json(login_response(&state, &user_id).await?))
}

pub async fn link(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(request): Json<AppleAuthorizationRequest>,
) -> Result<Json<Value>, AppError> {
    let (apple, tokens) = verify_authorization(&state, &request).await?;
    if let Some(row) = sqlx::query(
        "SELECT identity_id, user_id FROM auth_external_identities WHERE provider = 'apple' AND subject = $1",
    )
    .bind(&apple.sub)
    .fetch_optional(&state.db)
    .await?
    {
        let owner: String = row.try_get("user_id")?;
        if owner != claims.sub {
            return Err(AppError::Conflict(
                "this Apple account is already linked".into(),
            ));
        }
        let identity_id: String = row.try_get("identity_id")?;
        persist_refresh_token(&state, &identity_id, tokens.refresh_token.as_deref()).await?;
        return Ok(Json(json!({"linked": true})));
    }
    let identity_id = Uuid::new_v4().to_string();
    let email = verified_email(&apple);
    sqlx::query(
        "INSERT INTO auth_external_identities
         (identity_id, provider, subject, user_id, corp_id, display_name, email, profile)
         VALUES ($1, 'apple', $2, $3, $4, $5, $6, $7)",
    )
    .bind(&identity_id)
    .bind(&apple.sub)
    .bind(&claims.sub)
    .bind(&require_config(&state)?.team_id)
    .bind(display_name(&request))
    .bind(email)
    .bind(json!({"is_private_email": apple.is_private_email}))
    .execute(&state.db)
    .await?;
    persist_refresh_token(&state, &identity_id, tokens.refresh_token.as_deref()).await?;
    Ok(Json(json!({"linked": true})))
}

pub async fn status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let row = sqlx::query(
        "SELECT password_hash IS NOT NULL AS has_password,
         EXISTS(SELECT 1 FROM auth_external_identities i WHERE i.user_id = users.user_id AND i.provider = 'apple') AS apple_linked
         FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    ).bind(&claims.sub).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    Ok(Json(json!({
        "apple_linked": row.try_get::<bool,_>("apple_linked").unwrap_or(false),
        "has_password": row.try_get::<bool,_>("has_password").unwrap_or(false),
    })))
}

pub async fn unlink(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    let has_password: bool = sqlx::query("SELECT password_hash IS NOT NULL AS ok FROM users WHERE user_id = $1 AND is_deleted = FALSE")
        .bind(&claims.sub).fetch_optional(&state.db).await?
        .and_then(|r| r.try_get("ok").ok()).unwrap_or(false);
    if !has_password {
        return Err(AppError::Conflict(
            "set a password before unlinking your only sign-in method".into(),
        ));
    }
    revoke_for_user(&state, &claims.sub).await?;
    sqlx::query("DELETE FROM auth_external_identities WHERE provider = 'apple' AND user_id = $1")
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({"linked": false})))
}

pub async fn revoke_for_user(state: &AppState, user_id: &str) -> Result<(), AppError> {
    let Some(row) = sqlx::query(
        "SELECT c.refresh_token_encrypted FROM apple_auth_credentials c
         JOIN auth_external_identities i ON i.identity_id = c.identity_id
         WHERE i.provider = 'apple' AND i.user_id = $1 AND c.revoked_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    else {
        return Ok(());
    };
    let encrypted: String = row.try_get("refresh_token_encrypted")?;
    let key = crypto::derive_master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    let token = crypto::decrypt_secret(&key, &encrypted)
        .map_err(|e| AppError::Internal(format!("decrypt Apple refresh token: {e}")))?;
    let config = require_config(state)?;
    let response = reqwest::Client::new()
        .post(APPLE_REVOKE_URL)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", client_secret(config)?.as_str()),
            ("token", token.as_str()),
            ("token_type_hint", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|_| {
            AppError::ServiceUnavailable("could not reach Apple revocation service".into())
        })?;
    if !response.status().is_success() {
        return Err(AppError::ServiceUnavailable(
            "Apple token revocation failed; account was not unlinked".into(),
        ));
    }
    sqlx::query(
        "UPDATE apple_auth_credentials SET revoked_at = NOW(), updated_at = NOW()
         WHERE identity_id IN (SELECT identity_id FROM auth_external_identities WHERE provider = 'apple' AND user_id = $1)",
    ).bind(user_id).execute(&state.db).await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct AppleEventRequest {
    signed_payload: String,
}

#[derive(Deserialize)]
struct AppleEventClaims {
    events: AppleEvent,
}

#[derive(Deserialize)]
struct AppleEvent {
    #[serde(rename = "type")]
    event_type: String,
    sub: String,
    #[serde(default)]
    email: Option<String>,
}

/// Apple server-to-server event endpoint. Full account deletion still uses the
/// same internal deletion path as the in-app button; credential-revoked/email
/// events immediately invalidate the local session and external identity.
pub async fn events(
    State(state): State<AppState>,
    Json(request): Json<AppleEventRequest>,
) -> Result<Json<Value>, AppError> {
    let config = require_config(&state)?;
    let header = decode_header(&request.signed_payload)
        .map_err(|_| AppError::Unauthorized("invalid Apple event token".into()))?;
    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("Apple event token has no key id".into()))?;
    let keys: AppleJwks = reqwest::Client::new()
        .get(APPLE_KEYS_URL)
        .send()
        .await
        .map_err(|_| AppError::ServiceUnavailable("could not reach Apple identity service".into()))?
        .error_for_status()
        .map_err(|_| {
            AppError::ServiceUnavailable("Apple identity service rejected key request".into())
        })?
        .json()
        .await
        .map_err(|_| AppError::ServiceUnavailable("invalid Apple key response".into()))?;
    let key = keys
        .keys
        .into_iter()
        .find(|key| key.kid == kid)
        .ok_or_else(|| AppError::Unauthorized("Apple event signing key not found".into()))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[APPLE_ISSUER]);
    validation.set_audience(&[config.client_id.as_str()]);
    let event = decode::<AppleEventClaims>(
        &request.signed_payload,
        &DecodingKey::from_rsa_components(&key.n, &key.e)
            .map_err(|_| AppError::Unauthorized("invalid Apple signing key".into()))?,
        &validation,
    )
    .map_err(|_| AppError::Unauthorized("Apple event verification failed".into()))?
    .claims
    .events;

    let identity = sqlx::query(
        "SELECT identity_id, user_id FROM auth_external_identities WHERE provider = 'apple' AND subject = $1",
    ).bind(&event.sub).fetch_optional(&state.db).await?;
    let Some(identity) = identity else {
        return Ok(Json(json!({"processed": true})));
    };
    let identity_id: String = identity.try_get("identity_id")?;
    let user_id: String = identity.try_get("user_id")?;
    match event.event_type.as_str() {
        "account-delete" => {
            sqlx::query("UPDATE apple_auth_credentials SET revoked_at = NOW(), updated_at = NOW() WHERE identity_id = $1")
                .bind(&identity_id).execute(&state.db).await?;
            crate::api::compliance::delete_user_data(&state, &user_id).await?;
        }
        "consent-revoked" => {
            sqlx::query("UPDATE apple_auth_credentials SET revoked_at = NOW(), updated_at = NOW() WHERE identity_id = $1")
                .bind(&identity_id).execute(&state.db).await?;
            sqlx::query("DELETE FROM auth_external_identities WHERE identity_id = $1")
                .bind(&identity_id)
                .execute(&state.db)
                .await?;
            sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE user_id = $1")
                .bind(&user_id)
                .execute(&state.db)
                .await?;
            if let Ok(id) = user_id.parse::<Uuid>() {
                state.fanout.kick_user(id);
            }
        }
        "email-disabled" | "email-enabled" => {
            sqlx::query(
                "UPDATE auth_external_identities SET email = COALESCE($2, email),
                 profile = COALESCE(profile, '{}'::jsonb) || jsonb_build_object('relay_status', $3), updated_at = NOW()
                 WHERE identity_id = $1",
            ).bind(&identity_id).bind(event.email).bind(&event.event_type).execute(&state.db).await?;
        }
        _ => tracing::info!(event_type = %event.event_type, "ignored unknown verified Apple event"),
    }
    Ok(Json(json!({"processed": true})))
}
