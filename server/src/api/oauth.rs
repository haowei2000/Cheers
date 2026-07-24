//! Authorization-code OAuth for the browser and native shells.
//!
//! The provider callback never contains Cheers tokens. It verifies state,
//! nonce, PKCE, and the provider ID token, records the resolved subject in a
//! ten-minute transaction, and redirects with a one-time handoff code. The
//! handoff endpoint is the only place that can finalize a Cheers session.

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Redirect, Response},
    Form, Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Utc};
use jsonwebtoken::{
    decode, decode_header, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use sqlx::Row;
use url::Url;
use uuid::Uuid;

use crate::{
    api::auth,
    app_state::AppState,
    config::{AppleAuthConfig, GoogleAuthConfig},
    domain::{auth as auth_domain, auth_sessions, two_factor},
    errors::AppError,
    infra::crypto,
};

const APPLE_ISSUER: &str = "https://appleid.apple.com";
const APPLE_KEYS_URL: &str = "https://appleid.apple.com/auth/keys";
const APPLE_TOKEN_URL: &str = "https://appleid.apple.com/auth/token";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_KEYS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];

#[derive(Debug, Deserialize)]
pub struct StartRequest {
    pub client: Option<String>,
    pub device_name: Option<String>,
    pub invite_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartResponse {
    pub transaction_id: String,
    pub authorization_url: String,
    pub expires_in: i64,
}

#[derive(Debug, Deserialize)]
pub struct HandoffRequest {
    pub code: String,
    pub client: Option<String>,
    #[serde(default)]
    pub trusted_device: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleCallback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppleCallback {
    pub code: Option<String>,
    pub id_token: Option<String>,
    pub state: Option<String>,
    pub user: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppleJwks {
    keys: Vec<AppleJwk>,
}

#[derive(Debug, Deserialize)]
struct AppleJwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct GoogleJwks {
    keys: Vec<GoogleJwk>,
}

#[derive(Debug, Deserialize)]
struct GoogleJwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct ProviderClaims {
    sub: String,
    #[serde(rename = "iss")]
    iss: String,
    #[serde(rename = "aud")]
    aud: String,
    nonce: Option<String>,
    email: Option<String>,
    email_verified: Option<Value>,
    name: Option<String>,
    given_name: Option<String>,
    family_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppleTokenResponse {
    id_token: String,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    id_token: String,
}

fn random_url_secret() -> Result<String, AppError> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| AppError::Internal(format!("secure random generation failed: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()))
}

fn provider_name(path: &str) -> Result<&'static str, AppError> {
    match path {
        "apple" => Ok("apple"),
        "google" => Ok("google"),
        _ => Err(AppError::NotFound),
    }
}

fn return_uri(state: &AppState, client: auth_sessions::ClientType) -> Result<String, AppError> {
    match client {
        auth_sessions::ClientType::Web => state
            .config
            .oauth_web_return_url
            .clone()
            .ok_or_else(|| AppError::ServiceUnavailable("web OAuth is not configured".into())),
        auth_sessions::ClientType::Macos | auth_sessions::ClientType::Ios => {
            Ok("cheers://auth/callback".into())
        }
    }
}

fn apple_web_config(state: &AppState) -> Result<(&AppleAuthConfig, &str, &str), AppError> {
    let config = state.config.apple_auth.as_ref().ok_or_else(|| {
        AppError::ServiceUnavailable("Sign in with Apple is not configured on this server".into())
    })?;
    let client_id = config.web_client_id.as_deref().ok_or_else(|| {
        AppError::ServiceUnavailable("Apple Web Services ID is not configured".into())
    })?;
    let redirect_uri = config.web_redirect_uri.as_deref().ok_or_else(|| {
        AppError::ServiceUnavailable("Apple Web callback is not configured".into())
    })?;
    Ok((config, client_id, redirect_uri))
}

fn google_config(state: &AppState) -> Result<&GoogleAuthConfig, AppError> {
    state.config.google_auth.as_ref().ok_or_else(|| {
        AppError::ServiceUnavailable("Google sign-in is not configured on this server".into())
    })
}

pub async fn start(
    State(state): State<AppState>,
    Path(provider_path): Path<String>,
    Json(body): Json<StartRequest>,
) -> Result<Json<StartResponse>, AppError> {
    let provider = provider_name(&provider_path)?;
    let client = auth_sessions::ClientType::parse(body.client.as_deref())?;
    if client == auth_sessions::ClientType::Web && state.config.oauth_web_return_url.is_none() {
        return Err(AppError::ServiceUnavailable(
            "web OAuth is not configured".into(),
        ));
    }
    let return_uri = return_uri(&state, client)?;
    let (authorization_endpoint, provider_client_id, provider_redirect_uri) = match provider {
        "apple" => {
            let (_, client_id, redirect_uri) = apple_web_config(&state)?;
            (
                "https://appleid.apple.com/auth/authorize",
                client_id.to_string(),
                redirect_uri.to_string(),
            )
        }
        "google" => {
            let config = google_config(&state)?;
            (
                "https://accounts.google.com/o/oauth2/v2/auth",
                config.client_id.clone(),
                config.redirect_uri.clone(),
            )
        }
        _ => unreachable!(),
    };

    let transaction_id = Uuid::new_v4().to_string();
    let state_secret = random_url_secret()?;
    let nonce = random_url_secret()?;
    let verifier = random_url_secret()?;
    let context = json!({
        "device_name": body.device_name,
        "invite_token": body.invite_token,
        "return_uri": return_uri,
        "nonce": nonce,
    });
    let encrypted_verifier = crypto::encrypt_secret(
        &crypto::derive_master_key(
            state.config.secret_store_key.as_deref(),
            &state.config.jwt_private_key_pem,
        ),
        &verifier,
    )
    .map_err(|e| AppError::Internal(format!("encrypt OAuth verifier: {e}")))?;
    let expires_at = Utc::now() + Duration::minutes(10);
    sqlx::query(
        "INSERT INTO auth_transactions
         (transaction_id, kind, status, provider, client_type, redirect_uri,
          state_hash, nonce_hash, pkce_verifier_hash, oauth_code_verifier_encrypted,
          context_json, expires_at)
         VALUES ($1, 'oauth', 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(&transaction_id)
    .bind(provider)
    .bind(client.as_str())
    .bind(&provider_redirect_uri)
    .bind(crypto::sha256_hex(&state_secret))
    .bind(crypto::sha256_hex(&nonce))
    .bind(crypto::sha256_hex(&verifier))
    .bind(encrypted_verifier)
    .bind(context)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    let mut url = Url::parse(authorization_endpoint)
        .map_err(|e| AppError::Internal(format!("OAuth endpoint URL: {e}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", &provider_client_id);
        query.append_pair("redirect_uri", &provider_redirect_uri);
        query.append_pair(
            "response_type",
            if provider == "apple" {
                "code id_token"
            } else {
                "code"
            },
        );
        query.append_pair(
            "scope",
            if provider == "apple" {
                "name email"
            } else {
                "openid email profile"
            },
        );
        query.append_pair("state", &state_secret);
        query.append_pair("nonce", &nonce);
        query.append_pair("code_challenge", &pkce_challenge(&verifier));
        query.append_pair("code_challenge_method", "S256");
        if provider == "apple" {
            query.append_pair("response_mode", "form_post");
        } else {
            query.append_pair("access_type", "online");
            query.append_pair("prompt", "select_account");
        }
    }
    Ok(Json(StartResponse {
        transaction_id,
        authorization_url: url.to_string(),
        expires_in: 600,
    }))
}

pub async fn google_callback(
    State(state): State<AppState>,
    Query(query): Query<GoogleCallback>,
) -> Result<Response, AppError> {
    complete_callback(&state, "google", query.state, query.code, query.error).await
}

pub async fn apple_callback(
    State(state): State<AppState>,
    Form(form): Form<AppleCallback>,
) -> Result<Response, AppError> {
    complete_callback(&state, "apple", form.state, form.code, form.error).await
}

async fn complete_callback(
    state: &AppState,
    provider: &str,
    state_secret: Option<String>,
    code: Option<String>,
    provider_error: Option<String>,
) -> Result<Response, AppError> {
    let state_secret =
        state_secret.ok_or_else(|| AppError::Unauthorized("OAuth state is missing".into()))?;
    // Claim the provider callback in one statement. A standalone SELECT FOR
    // UPDATE would release its lock before the token exchange because it is not
    // inside an explicit transaction, allowing the same state to race twice.
    let row = sqlx::query(
        "UPDATE auth_transactions
         SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
         WHERE state_hash = $1 AND kind = 'oauth' AND provider = $2
           AND status = 'pending' AND expires_at > NOW() AND consumed_at IS NULL
         RETURNING transaction_id, client_type, redirect_uri, context_json,
                   oauth_code_verifier_encrypted, expires_at",
    )
    .bind(crypto::sha256_hex(&state_secret))
    .bind(provider)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("OAuth state is invalid or expired".into()))?;
    let transaction_id: String = row.try_get("transaction_id")?;
    let _client =
        auth_sessions::ClientType::parse(Some(row.try_get::<String, _>("client_type")?.as_str()))?;
    let return_uri: String = row.try_get("redirect_uri")?;
    let context: Value = row.try_get("context_json")?;
    if let Some(error) = provider_error {
        let _ = sqlx::query("UPDATE auth_transactions SET status = 'failed', updated_at = NOW() WHERE transaction_id = $1 AND status = 'consumed'")
            .bind(&transaction_id).execute(&state.db).await;
        return Ok(oauth_return_redirect(
            context["return_uri"].as_str().unwrap_or(&return_uri),
            "error",
            &error_code(&error),
        )
        .into_response());
    }
    let code =
        code.ok_or_else(|| AppError::Unauthorized("OAuth authorization code is missing".into()))?;
    let encrypted_verifier: String = row.try_get("oauth_code_verifier_encrypted")?;
    let verifier = crypto::decrypt_secret(
        &crypto::derive_master_key(
            state.config.secret_store_key.as_deref(),
            &state.config.jwt_private_key_pem,
        ),
        &encrypted_verifier,
    )
    .map_err(|e| AppError::Internal(format!("decrypt OAuth verifier: {e}")))?;
    let nonce = context["nonce"]
        .as_str()
        .ok_or_else(|| AppError::Internal("OAuth nonce missing".into()))?;
    let (subject, email, name, verified, refresh_token) = match provider {
        "apple" => verify_apple_callback(state, &code, &verifier, nonce).await?,
        "google" => verify_google_callback(state, &code, &verifier, nonce).await?,
        _ => unreachable!(),
    };
    if !verified {
        return Err(AppError::Unauthorized(
            "provider email is not verified".into(),
        ));
    }
    let user_id = resolve_identity(
        state,
        provider,
        &subject,
        email.as_deref(),
        name.as_deref(),
        context["invite_token"].as_str(),
    )
    .await?;
    if provider == "apple" {
        if let Some(token) = refresh_token.as_deref() {
            persist_apple_refresh_token(state, &subject, &user_id, token).await?;
        }
    }
    let handoff = random_url_secret()?;
    sqlx::query(
        "UPDATE auth_transactions
         SET user_id = $2, status = 'verified', handoff_code_hash = $3,
             consumed_at = NULL, updated_at = NOW()
         WHERE transaction_id = $1 AND status = 'consumed' AND consumed_at IS NOT NULL",
    )
    .bind(&transaction_id)
    .bind(&user_id)
    .bind(crypto::sha256_hex(&handoff))
    .execute(&state.db)
    .await?;
    let target = context["return_uri"].as_str().unwrap_or(&return_uri);
    Ok(oauth_return_redirect(target, "code", &handoff).into_response())
}

fn error_code(value: &str) -> String {
    if value == "access_denied" {
        "access_denied".into()
    } else {
        "provider_error".into()
    }
}

fn append_query(base: &str, key: &str, value: &str) -> String {
    let mut url = match Url::parse(base) {
        Ok(url) => url,
        Err(_) => return base.to_string(),
    };
    url.query_pairs_mut().append_pair(key, value);
    url.to_string()
}

fn oauth_return_redirect(base: &str, key: &str, value: &str) -> Redirect {
    // Apple posts its callback form. A 307 would preserve POST when returning
    // to the SPA or custom URL scheme, producing a 405 instead of loading the
    // callback page. A 303 explicitly continues the handoff with GET.
    Redirect::to(&append_query(base, key, value))
}

async fn verify_apple_callback(
    state: &AppState,
    code: &str,
    verifier: &str,
    nonce: &str,
) -> Result<(String, Option<String>, Option<String>, bool, Option<String>), AppError> {
    let (config, client_id, redirect_uri) = apple_web_config(state)?;
    let secret = apple_client_secret(config, client_id)?;
    let tokens: AppleTokenResponse = reqwest::Client::new()
        .post(APPLE_TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", secret.as_str()),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|_| AppError::ServiceUnavailable("could not reach Apple token service".into()))?
        .error_for_status()
        .map_err(|_| AppError::Unauthorized("Apple authorization code was rejected".into()))?
        .json()
        .await
        .map_err(|_| AppError::ServiceUnavailable("invalid Apple token response".into()))?;
    let claims = verify_jwt(
        state,
        &tokens.id_token,
        nonce,
        client_id,
        APPLE_KEYS_URL,
        APPLE_ISSUER,
        true,
    )
    .await?;
    let verified = claims.email_verified.as_ref().map(is_true).unwrap_or(false);
    Ok((
        claims.sub,
        claims.email.clone(),
        claims.name.clone(),
        verified,
        tokens.refresh_token,
    ))
}

async fn verify_google_callback(
    state: &AppState,
    code: &str,
    verifier: &str,
    nonce: &str,
) -> Result<(String, Option<String>, Option<String>, bool, Option<String>), AppError> {
    let config = google_config(state)?;
    let tokens: GoogleTokenResponse = reqwest::Client::new()
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", config.redirect_uri.as_str()),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|_| AppError::ServiceUnavailable("could not reach Google token service".into()))?
        .error_for_status()
        .map_err(|_| AppError::Unauthorized("Google authorization code was rejected".into()))?
        .json()
        .await
        .map_err(|_| AppError::ServiceUnavailable("invalid Google token response".into()))?;
    let claims = verify_google_jwt(state, &tokens.id_token, nonce, &config.client_id).await?;
    let verified = claims.email_verified.as_ref().map(is_true).unwrap_or(false);
    Ok((
        claims.sub,
        claims.email.clone(),
        claims.name.clone(),
        verified,
        None,
    ))
}

fn is_true(value: &Value) -> bool {
    value.as_bool().unwrap_or(false) || value.as_str().map(|v| v == "true").unwrap_or(false)
}

async fn verify_jwt(
    _state: &AppState,
    token: &str,
    nonce: &str,
    audience: &str,
    keys_url: &str,
    issuer: &str,
    apple: bool,
) -> Result<ProviderClaims, AppError> {
    let header = decode_header(token)
        .map_err(|_| AppError::Unauthorized("invalid provider identity token".into()))?;
    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("provider token has no key id".into()))?;
    let response = reqwest::Client::new()
        .get(keys_url)
        .send()
        .await
        .map_err(|_| {
            AppError::ServiceUnavailable("could not reach provider identity service".into())
        })?
        .error_for_status()
        .map_err(|_| {
            AppError::ServiceUnavailable("provider identity service rejected key request".into())
        })?;
    let keys: AppleJwks = response
        .json()
        .await
        .map_err(|_| AppError::ServiceUnavailable("invalid provider key response".into()))?;
    let key = keys
        .keys
        .into_iter()
        .find(|key| key.kid == kid)
        .ok_or_else(|| AppError::Unauthorized("provider signing key not found".into()))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    let claims = decode::<ProviderClaims>(
        token,
        &DecodingKey::from_rsa_components(&key.n, &key.e)
            .map_err(|_| AppError::Unauthorized("invalid provider signing key".into()))?,
        &validation,
    )
    .map_err(|_| AppError::Unauthorized("provider identity token verification failed".into()))?
    .claims;
    if claims.nonce.as_deref() != Some(nonce) || (apple && claims.iss != issuer) {
        return Err(AppError::Unauthorized("provider nonce mismatch".into()));
    }
    Ok(claims)
}

async fn verify_google_jwt(
    state: &AppState,
    token: &str,
    nonce: &str,
    audience: &str,
) -> Result<ProviderClaims, AppError> {
    let header = decode_header(token)
        .map_err(|_| AppError::Unauthorized("invalid Google identity token".into()))?;
    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("Google token has no key id".into()))?;
    let keys: GoogleJwks = reqwest::Client::new()
        .get(GOOGLE_KEYS_URL)
        .send()
        .await
        .map_err(|_| {
            AppError::ServiceUnavailable("could not reach Google identity service".into())
        })?
        .error_for_status()
        .map_err(|_| {
            AppError::ServiceUnavailable("Google identity service rejected key request".into())
        })?
        .json()
        .await
        .map_err(|_| AppError::ServiceUnavailable("invalid Google key response".into()))?;
    let key = keys
        .keys
        .into_iter()
        .find(|key| key.kid == kid)
        .ok_or_else(|| AppError::Unauthorized("Google signing key not found".into()))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&GOOGLE_ISSUER);
    validation.set_audience(&[audience]);
    let claims = decode::<ProviderClaims>(
        token,
        &DecodingKey::from_rsa_components(&key.n, &key.e)
            .map_err(|_| AppError::Unauthorized("invalid Google signing key".into()))?,
        &validation,
    )
    .map_err(|_| AppError::Unauthorized("Google identity token verification failed".into()))?
    .claims;
    if claims.nonce.as_deref() != Some(nonce) {
        return Err(AppError::Unauthorized("Google nonce mismatch".into()));
    }
    let _ = state;
    Ok(claims)
}

fn apple_client_secret(config: &AppleAuthConfig, client_id: &str) -> Result<String, AppError> {
    #[derive(Serialize)]
    struct Claims<'a> {
        iss: &'a str,
        iat: usize,
        exp: usize,
        aud: &'static str,
        sub: &'a str,
    }
    let now = Utc::now().timestamp() as usize;
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(config.key_id.clone());
    encode(
        &header,
        &Claims {
            iss: &config.team_id,
            iat: now,
            exp: now + 300,
            aud: APPLE_ISSUER,
            sub: client_id,
        },
        &EncodingKey::from_ec_pem(config.private_key_pem.as_bytes())
            .map_err(|_| AppError::Internal("invalid Apple private key".into()))?,
    )
    .map_err(|_| AppError::Internal("Apple client-secret signing failed".into()))
}

async fn resolve_identity(
    state: &AppState,
    provider: &str,
    subject: &str,
    email: Option<&str>,
    name: Option<&str>,
    invite_token: Option<&str>,
) -> Result<String, AppError> {
    let issuer = if provider == "apple" {
        APPLE_ISSUER
    } else {
        "https://accounts.google.com"
    };
    let existing = sqlx::query(
        "SELECT DISTINCT user_id FROM auth_external_identities
         WHERE provider = $1 AND issuer = $2 AND subject = $3",
    )
    .bind(provider)
    .bind(issuer)
    .bind(subject)
    .fetch_all(&state.db)
    .await?;
    if existing.len() > 1 {
        return Err(AppError::Conflict(
            "provider identity is linked to multiple accounts; contact support".into(),
        ));
    }
    if let Some(row) = existing.first() {
        let user_id: String = row.try_get("user_id")?;
        // Apple uses separate native and Web client IDs, but account ownership
        // is resolved only from the verified issuer + sub. Record the Web
        // configuration on the same user so its refresh credential retains the
        // correct revocation client ID.
        sqlx::query(
            "INSERT INTO auth_external_identities
             (identity_id, provider, issuer, provider_config_id, subject, user_id,
              corp_id, display_name, email, profile)
             VALUES ($1, $2, $3, 'web', $4, $5, $2, $6, $7, '{}'::jsonb)
             ON CONFLICT (provider, issuer, provider_config_id, subject) DO NOTHING",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(provider)
        .bind(issuer)
        .bind(subject)
        .bind(&user_id)
        .bind(name)
        .bind(email)
        .execute(&state.db)
        .await?;
        let web_owner: String = sqlx::query_scalar(
            "SELECT user_id FROM auth_external_identities
             WHERE provider = $1 AND issuer = $2 AND provider_config_id = 'web'
               AND subject = $3",
        )
        .bind(provider)
        .bind(issuer)
        .bind(subject)
        .fetch_one(&state.db)
        .await?;
        if web_owner != user_id {
            return Err(AppError::Conflict(
                "provider identity is already linked to another account".into(),
            ));
        }
        return Ok(user_id);
    }
    auth::ensure_may_register(state, invite_token).await?;
    if let Some(email) = email.map(str::trim).filter(|v| !v.is_empty()) {
        if sqlx::query(
            "SELECT 1 FROM users WHERE lower(email) = lower($1) AND is_deleted = FALSE LIMIT 1",
        )
        .bind(email)
        .fetch_optional(&state.db)
        .await?
        .is_some()
        {
            return Err(AppError::Conflict("account_link_required: sign in with your password, then link this provider in Settings".into()));
        }
    }
    let user_id = Uuid::new_v4().to_string();
    let identity_id = Uuid::new_v4().to_string();
    let username = format!(
        "{}_{}",
        provider,
        Uuid::new_v4().simple().to_string()[..12].to_string()
    );
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO users (user_id, username, email, password_hash, display_name, role) VALUES ($1, $2, $3, NULL, $4, 'member')")
        .bind(&user_id).bind(&username).bind(email).bind(name).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO auth_external_identities (identity_id, provider, issuer, provider_config_id, subject, user_id, corp_id, display_name, email, profile) VALUES ($1, $2, $3, 'web', $4, $5, $6, $7, $8, $9)")
        .bind(&identity_id).bind(provider).bind(issuer).bind(subject).bind(&user_id).bind(provider).bind(name).bind(email).bind(json!({})).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(user_id)
}

async fn persist_apple_refresh_token(
    state: &AppState,
    subject: &str,
    user_id: &str,
    token: &str,
) -> Result<(), AppError> {
    let identity_id: String = sqlx::query_scalar("SELECT identity_id FROM auth_external_identities WHERE provider = 'apple' AND issuer = $1 AND provider_config_id = 'web' AND subject = $2 AND user_id = $3")
        .bind(APPLE_ISSUER).bind(subject).bind(user_id).fetch_one(&state.db).await?;
    let key = crypto::derive_master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    let encrypted = crypto::encrypt_secret(&key, token)
        .map_err(|e| AppError::Internal(format!("encrypt Apple refresh token: {e}")))?;
    let (_, client_id, _) = apple_web_config(state)?;
    sqlx::query("INSERT INTO apple_auth_credentials (identity_id, refresh_token_encrypted, client_id, last_validated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (identity_id) DO UPDATE SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, client_id = EXCLUDED.client_id, last_validated_at = NOW(), revoked_at = NULL, updated_at = NOW()")
        .bind(identity_id).bind(encrypted).bind(client_id).execute(&state.db).await?;
    Ok(())
}

pub async fn handoff(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<HandoffRequest>,
) -> Result<Response, AppError> {
    let requested_client = body
        .client
        .as_deref()
        .map(|value| auth_sessions::ClientType::parse(Some(value)))
        .transpose()?;
    let mut tx = state.db.begin().await?;
    let row = sqlx::query("UPDATE auth_transactions SET status = 'consumed', consumed_at = NOW(), updated_at = NOW() WHERE handoff_code_hash = $1 AND status = 'verified' AND consumed_at IS NULL AND expires_at > NOW() AND ($2::VARCHAR IS NULL OR client_type = $2) RETURNING user_id, client_type, context_json")
        .bind(crypto::sha256_hex(&body.code))
        .bind(requested_client.map(|client| client.as_str()))
        .fetch_optional(&mut *tx).await?.ok_or_else(|| AppError::Unauthorized("handoff code is invalid, expired, already used, or belongs to another client".into()))?;
    tx.commit().await?;
    let user_id: String = row.try_get("user_id")?;
    let stored_client: String = row.try_get("client_type")?;
    let client = requested_client.unwrap_or(auth_sessions::ClientType::parse(Some(
        stored_client.as_str(),
    ))?);
    let context: Value = row.try_get("context_json")?;
    let user = auth_domain::load_auth_user(&state.db, &user_id).await?;
    let presented =
        crate::api::auth::presented_trusted_device(&headers, body.trusted_device.as_deref());
    let trusted =
        auth_sessions::trusted_device_is_valid(&state.db, &user_id, presented.as_deref()).await?;
    if two_factor::status(&state.db, &user_id).await?.enabled && !trusted {
        let factor = auth_sessions::create_factor_transaction(
            &state.db,
            &user_id,
            client,
            context["device_name"].as_str(),
        )
        .await?;
        let allowed_factors = crate::domain::webauthn::allowed_login_factors(
            &state.db,
            state.webauthn.as_deref(),
            &user_id,
        )
        .await?;
        return Ok(Json(json!({
            "status": "factor_required",
            "transaction_id": factor.transaction_id,
            "allowed_factors": allowed_factors,
            "expires_in": 600,
            "requires_2fa": true
        }))
        .into_response());
    }
    let session = auth_sessions::finalize_login(
        &state.db,
        &state.config,
        &user,
        client,
        context["device_name"].as_str(),
    )
    .await?;
    let refresh = session.refresh_token.clone();
    let csrf = session.csrf_token.clone();
    let response = auth::session_response(&user, session, client)?;
    Ok(if client == auth_sessions::ClientType::Web {
        auth::response_with_session_cookies(response, Some(&refresh), Some(&csrf))
    } else {
        Json(response).into_response()
    })
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderValue, StatusCode};

    use super::*;

    #[test]
    fn pkce_uses_rfc7636_s256_encoding() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn provider_path_is_allowlisted() {
        assert_eq!(provider_name("apple").unwrap(), "apple");
        assert_eq!(provider_name("google").unwrap(), "google");
        assert!(provider_name("github").is_err());
    }

    #[test]
    fn callback_query_values_are_encoded() {
        assert_eq!(
            append_query("cheers://auth/callback", "code", "one/two+three"),
            "cheers://auth/callback?code=one%2Ftwo%2Bthree"
        );
    }

    #[test]
    fn provider_errors_are_reduced_to_public_codes() {
        assert_eq!(error_code("access_denied"), "access_denied");
        assert_eq!(error_code("internal_provider_detail"), "provider_error");
    }

    #[test]
    fn oauth_return_uses_see_other_to_drop_apple_form_post() {
        let response = oauth_return_redirect(
            "https://www.tocheers.com/auth/callback",
            "code",
            "one/two+three",
        )
        .into_response();

        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers().get(header::LOCATION),
            Some(&HeaderValue::from_static(
                "https://www.tocheers.com/auth/callback?code=one%2Ftwo%2Bthree"
            ))
        );
    }
}
