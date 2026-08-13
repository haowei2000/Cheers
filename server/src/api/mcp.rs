use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Extension, Json,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use cheers_mcp_server::{
    build_uri_resource_call, required_scope_for_tool, resource_content, resource_definitions,
    resource_help_text, resource_template_definitions,
    tools::{build_resource_call as build_tool_resource_call, definitions as tool_definitions},
    ALL_OAUTH_SCOPES, RESOURCE_GUIDE_URI, SCOPE_READ,
};
use chrono::{Duration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, Algorithm, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Digest;
use sqlx::Row;
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use url::Url;
use uuid::Uuid;

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    errors::AppError,
    infra::crypto::hash_installation_credential,
    resource::{self, Principal},
};

const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
const MCP_TOKEN_USE: &str = "mcp_access";
const MCP_ACCESS_TOKEN_TTL_SECS: u64 = 10 * 60;
const MCP_CATALOG_TTL_MS: u64 = 30_000;
const MCP_AUTH_CODE_TTL_MINUTES: i64 = 5;
const MCP_REFRESH_TOKEN_TTL_DAYS: i64 = 30;
const MCP_PROTOCOL_VERSION_HEADER: &str = "mcp-protocol-version";
const MCP_METHOD_HEADER: &str = "mcp-method";
const MCP_NAME_HEADER: &str = "mcp-name";

fn server_info() -> Value {
    json!({"name": "cheers", "version": env!("CARGO_PKG_VERSION")})
}

fn result_meta() -> Value {
    json!({"io.modelcontextprotocol/serverInfo": server_info()})
}

/// RFC 9728 metadata for the stateless Cheers MCP protected resource.
pub async fn protected_resource_metadata(State(state): State<AppState>) -> Response {
    let resource = state.config.mcp_resource_url();
    let issuer = state.config.mcp_authorization_issuer();
    let metadata = protected_resource_metadata_document(&resource, Some(&issuer));
    let mut response = (StatusCode::OK, Json(metadata)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    response
}

fn protected_resource_metadata_document(resource: &str, issuer: Option<&str>) -> Value {
    let mut metadata = json!({
        "resource": resource,
        "resource_name": "Cheers MCP",
        "scopes_supported": ALL_OAUTH_SCOPES,
        "bearer_methods_supported": ["header"]
    });
    if let Some(issuer) = issuer {
        metadata["authorization_servers"] = json!([issuer]);
    }
    metadata
}

/// RFC 8414 metadata for Cheers' installation-bound OAuth 2.1 issuer.
pub async fn authorization_server_metadata(State(state): State<AppState>) -> Response {
    let issuer = state.config.mcp_authorization_issuer();
    let resource = state.config.mcp_resource_url();
    let metadata = json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{}/oauth/authorize", issuer),
        "token_endpoint": format!("{}/oauth/token", issuer),
        "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
        "response_types_supported": ["code"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "scopes_supported": ALL_OAUTH_SCOPES,
        "resource_indicators_supported": true,
        "client_id_metadata_document_supported": true,
        "cheers_installation_clients": true,
        "protected_resource": resource
    });
    let mut response = (StatusCode::OK, Json(metadata)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    response
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpAuthorizeRequest {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    scope: String,
    state: Option<String>,
    code_challenge: String,
    code_challenge_method: String,
    resource: String,
}

#[derive(Debug, Deserialize)]
pub struct McpAuthorizeApproval {
    #[serde(flatten)]
    request: McpAuthorizeRequest,
    installation_id: String,
    approved: bool,
}

#[derive(Debug, Deserialize)]
struct ClientMetadataDocument {
    client_id: String,
    client_name: Option<String>,
    redirect_uris: Vec<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}

/// OAuth authorization endpoint. Consent is rendered by the Cheers frontend so
/// it can reuse the existing authenticated user session without ever placing a
/// user JWT in the OAuth query string.
pub async fn authorize_start(
    State(state): State<AppState>,
    Query(request): Query<McpAuthorizeRequest>,
) -> Response {
    if let Err(message) = validate_authorize_shape(&state, &request) {
        return oauth_authorization_error(&request, "invalid_request", &message);
    }
    let encoded = match serde_urlencoded::to_string(&request) {
        Ok(value) => value,
        Err(_) => return mcp_http_error(StatusCode::BAD_REQUEST, "invalid authorization request"),
    };
    let resource = match Url::parse(&state.config.mcp_resource_url()) {
        Ok(value) => value,
        Err(_) => return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    Redirect::temporary(&format!(
        "{}/mcp-authorize?{encoded}",
        resource.origin().ascii_serialization()
    ))
    .into_response()
}

/// Authenticated consent preview. Only active installations owned by this user
/// (or an administrator) may become the grant principal.
pub async fn authorize_inspect(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Query(request): Query<McpAuthorizeRequest>,
) -> Result<Json<Value>, AppError> {
    validate_authorize_shape(&state, &request).map_err(AppError::BadRequest)?;
    let client = fetch_client_metadata(&request.client_id)
        .await
        .map_err(AppError::BadRequest)?;
    validate_client_redirect(&client, &request).map_err(AppError::BadRequest)?;
    let rows = if crate::api::bots::is_admin(&claims) {
        sqlx::query(
            "SELECT i.installation_id, i.device_name, b.bot_id, b.display_name, b.username
             FROM terminal_installations i JOIN bot_accounts b ON b.bot_id = i.bot_id
             WHERE i.status = 'active' AND i.revoked_at IS NULL AND b.is_disabled = FALSE
             ORDER BY b.username, i.device_name",
        )
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            "SELECT i.installation_id, i.device_name, b.bot_id, b.display_name, b.username
             FROM terminal_installations i JOIN bot_accounts b ON b.bot_id = i.bot_id
             WHERE i.status = 'active' AND i.revoked_at IS NULL AND b.is_disabled = FALSE
               AND b.created_by = $1
             ORDER BY b.username, i.device_name",
        )
        .bind(&claims.sub)
        .fetch_all(&state.db)
        .await?
    };
    let installations = rows
        .into_iter()
        .map(|row| {
            json!({
                "installation_id": row.try_get::<String, _>("installation_id").unwrap_or_default(),
                "device_name": row.try_get::<String, _>("device_name").unwrap_or_default(),
                "bot_id": row.try_get::<String, _>("bot_id").unwrap_or_default(),
                "bot_name": row.try_get::<Option<String>, _>("display_name").ok().flatten()
                    .or_else(|| row.try_get::<String, _>("username").ok()).unwrap_or_default()
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "client":{"client_id":client.client_id,"client_name":client.client_name.unwrap_or_else(|| "MCP client".into())},
        "scopes":parse_requested_scopes(&request.scope).unwrap_or_default(),
        "installations":installations,
        "redirect_uri":request.redirect_uri
    })))
}

/// Mint a single-use authorization code after explicit resource-owner consent.
pub async fn authorize_approve(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(approval): Json<McpAuthorizeApproval>,
) -> Result<Json<Value>, AppError> {
    let request = approval.request;
    validate_authorize_shape(&state, &request).map_err(AppError::BadRequest)?;
    let client = fetch_client_metadata(&request.client_id)
        .await
        .map_err(AppError::BadRequest)?;
    validate_client_redirect(&client, &request).map_err(AppError::BadRequest)?;
    if !approval.approved {
        return Ok(Json(
            json!({"redirect_uri":authorization_redirect(&request, None, Some(("access_denied", "The resource owner denied the request")), &state.config.mcp_authorization_issuer())?}),
        ));
    }
    let installation = Uuid::parse_str(&approval.installation_id)
        .map_err(|_| AppError::BadRequest("invalid installation_id".into()))?;
    let allowed: bool = if crate::api::bots::is_admin(&claims) {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM terminal_installations i JOIN bot_accounts b ON b.bot_id=i.bot_id
             WHERE i.installation_id=$1 AND i.status='active' AND i.revoked_at IS NULL AND b.is_disabled=FALSE)",
        )
        .bind(installation.to_string()).fetch_one(&state.db).await?
    } else {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM terminal_installations i JOIN bot_accounts b ON b.bot_id=i.bot_id
             WHERE i.installation_id=$1 AND i.status='active' AND i.revoked_at IS NULL
               AND b.is_disabled=FALSE AND b.created_by=$2)",
        )
        .bind(installation.to_string()).bind(&claims.sub).fetch_one(&state.db).await?
    };
    if !allowed {
        return Err(AppError::Forbidden("installation is unavailable".into()));
    }

    let code = random_oauth_secret()?;
    sqlx::query(
        "INSERT INTO mcp_oauth_authorization_codes
         (code_id,code_hash,installation_id,client_id,redirect_uri,scope,resource,code_challenge,created_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(hash_oauth_secret(&code))
    .bind(installation.to_string())
    .bind(&request.client_id)
    .bind(&request.redirect_uri)
    .bind(canonical_scope(&request.scope).map_err(AppError::BadRequest)?)
    .bind(&request.resource)
    .bind(&request.code_challenge)
    .bind(&claims.sub)
    .bind(Utc::now() + Duration::minutes(MCP_AUTH_CODE_TTL_MINUTES))
    .execute(&state.db).await?;
    let redirect_uri = authorization_redirect(
        &request,
        Some(&code),
        None,
        &state.config.mcp_authorization_issuer(),
    )?;
    Ok(Json(json!({"redirect_uri":redirect_uri})))
}

fn validate_authorize_shape(state: &AppState, request: &McpAuthorizeRequest) -> Result<(), String> {
    if request.response_type != "code" {
        return Err("response_type must be code".into());
    }
    if request.code_challenge_method != "S256" {
        return Err("code_challenge_method must be S256".into());
    }
    if request.code_challenge.len() < 43
        || request.code_challenge.len() > 128
        || !request
            .code_challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
    {
        return Err("code_challenge is invalid".into());
    }
    if request.resource != state.config.mcp_resource_url() {
        return Err("resource does not identify this MCP endpoint".into());
    }
    canonical_scope(&request.scope)?;
    Ok(())
}

fn canonical_scope(raw: &str) -> Result<String, String> {
    parse_requested_scopes(raw)
        .map(|scopes| scopes.join(" "))
        .ok_or_else(|| "scope is empty or contains an unknown value".into())
}

fn validate_client_redirect(
    client: &ClientMetadataDocument,
    request: &McpAuthorizeRequest,
) -> Result<(), String> {
    if client.client_id != request.client_id {
        return Err("client metadata client_id mismatch".into());
    }
    if !client
        .redirect_uris
        .iter()
        .any(|uri| uri == &request.redirect_uri)
    {
        return Err("redirect_uri is not registered by the client".into());
    }
    if client
        .grant_types
        .as_ref()
        .is_some_and(|v| !v.iter().any(|x| x == "authorization_code"))
    {
        return Err("client does not register authorization_code".into());
    }
    if client
        .response_types
        .as_ref()
        .is_some_and(|v| !v.iter().any(|x| x == "code"))
    {
        return Err("client does not register code responses".into());
    }
    Ok(())
}

fn authorization_redirect(
    request: &McpAuthorizeRequest,
    code: Option<&str>,
    error: Option<(&str, &str)>,
    issuer: &str,
) -> Result<String, AppError> {
    let mut target = Url::parse(&request.redirect_uri)
        .map_err(|_| AppError::BadRequest("invalid redirect_uri".into()))?;
    {
        let mut pairs = target.query_pairs_mut();
        if let Some(code) = code {
            pairs.append_pair("code", code);
        }
        if let Some((error, description)) = error {
            pairs
                .append_pair("error", error)
                .append_pair("error_description", description);
        }
        if let Some(state) = &request.state {
            pairs.append_pair("state", state);
        }
        pairs.append_pair("iss", issuer);
    }
    Ok(target.to_string())
}

fn oauth_authorization_error(
    _request: &McpAuthorizeRequest,
    error: &str,
    description: &str,
) -> Response {
    // Never redirect until client metadata has authenticated redirect_uri.
    mcp_http_error(StatusCode::BAD_REQUEST, &format!("{error}: {description}"))
}

async fn fetch_client_metadata(client_id: &str) -> Result<ClientMetadataDocument, String> {
    let url = Url::parse(client_id).map_err(|_| "client_id must be an HTTPS metadata URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("client_id must be a canonical HTTPS metadata URL".into());
    }
    let host = url.host_str().unwrap();
    if host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok() {
        return Err("client metadata host is not public".into());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "client metadata host could not be resolved")?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("client metadata host resolves to a non-public address".into());
    }
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5));
    for address in addresses {
        builder = builder.resolve(host, SocketAddr::new(address.ip(), port));
    }
    let response = builder
        .build()
        .map_err(|_| "client metadata fetch is unavailable")?
        .get(url.clone())
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "client metadata fetch failed")?;
    if !response.status().is_success() {
        return Err("client metadata endpoint rejected the request".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > 64 * 1024)
    {
        return Err("client metadata document is too large".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "client metadata body is unavailable")?;
    if bytes.len() > 64 * 1024 {
        return Err("client metadata document is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "client metadata document is invalid".into())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_unspecified()
                || ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_documentation()
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let first = ip.segments()[0];
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

fn random_oauth_secret() -> Result<String, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| AppError::Internal(format!("secure random generation failed: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn hash_oauth_secret(secret: &str) -> String {
    format!("{:x}", sha2::Sha256::digest(secret.as_bytes()))
}

#[derive(Debug, Serialize, Deserialize)]
struct McpAccessClaims {
    sub: String,
    installation_id: String,
    credential_hash: String,
    scope: String,
    aud: String,
    iss: String,
    token_use: String,
    exp: u64,
    iat: u64,
    nbf: u64,
}

#[derive(Serialize)]
struct McpTokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: u64,
    scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
}

#[derive(Default, Deserialize)]
struct McpTokenRequest {
    grant_type: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    scope: Option<String>,
    resource: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
}

/// Exchange an active installation credential for a narrowly scoped MCP token.
/// Rotation, revocation, or demotion invalidates outstanding tokens immediately.
pub async fn issue_mcp_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let request = if content_type.starts_with("application/x-www-form-urlencoded") {
        match serde_urlencoded::from_bytes::<McpTokenRequest>(&body) {
            Ok(request) => request,
            Err(_) => return oauth_token_error("invalid_request", "invalid token request"),
        }
    } else if body.is_empty() {
        McpTokenRequest::default()
    } else {
        match serde_json::from_slice::<McpTokenRequest>(&body) {
            Ok(request) => request,
            Err(_) => return oauth_token_error("invalid_request", "invalid token request"),
        }
    };
    let Some(grant_type) = request.grant_type.as_deref() else {
        return oauth_token_error("invalid_request", "grant_type is required");
    };
    if grant_type == "authorization_code" {
        return exchange_authorization_code(&state, request).await;
    }
    if grant_type == "refresh_token" {
        return exchange_refresh_token(&state, request).await;
    }
    if grant_type != "client_credentials" {
        return oauth_token_error("unsupported_grant_type", "unsupported OAuth grant type");
    }
    if request.resource.as_deref() != Some(state.config.mcp_resource_url().as_str()) {
        return oauth_token_error(
            "invalid_target",
            "resource is required and must identify this MCP endpoint",
        );
    }
    let basic = basic_client_credentials(&headers);
    let client_id = request
        .client_id
        .as_deref()
        .or_else(|| basic.as_ref().map(|v| v.0.as_str()));
    let installation_credential = request
        .client_secret
        .as_deref()
        .or_else(|| basic.as_ref().map(|v| v.1.as_str()));
    let Some(installation_credential) = installation_credential else {
        return oauth_token_error("invalid_client", "installation credential is required");
    };
    let credential_hash = hash_installation_credential(installation_credential);
    let row = match sqlx::query(
        "SELECT i.installation_id, i.bot_id, b.is_disabled
         FROM terminal_installations i
         JOIN bot_accounts b ON b.bot_id = i.bot_id
         WHERE i.credential_hash = $1 AND i.status = 'active'
           AND i.revoked_at IS NULL",
    )
    .bind(&credential_hash)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return unauthorized_response(),
        Err(error) => {
            tracing::error!(error = %error, "MCP token exchange lookup failed");
            return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    if row.try_get::<bool, _>("is_disabled").unwrap_or(true) {
        return unauthorized_response();
    }
    let Ok(bot_id) = row.try_get::<String, _>("bot_id") else {
        tracing::error!("MCP token exchange found malformed bot id");
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    };
    let Ok(installation_id) = row.try_get::<String, _>("installation_id") else {
        tracing::error!("MCP token exchange found malformed installation id");
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    };
    if client_id.is_some_and(|value| value != installation_id) {
        return oauth_token_error(
            "invalid_client",
            "client_id does not match the installation",
        );
    }
    if Uuid::parse_str(&bot_id).is_err() {
        tracing::error!("MCP token exchange found invalid bot UUID");
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }

    let requested_scopes = request.scope.as_deref().unwrap_or(SCOPE_READ);
    let scopes = match parse_requested_scopes(requested_scopes) {
        Some(scopes) => scopes,
        None => return mcp_http_error(StatusCode::BAD_REQUEST, "invalid or unknown scope"),
    };
    let scope = scopes.join(" ");

    mint_mcp_access_token(
        &state,
        bot_id,
        installation_id,
        credential_hash,
        scope,
        None,
    )
}

fn mint_mcp_access_token(
    state: &AppState,
    bot_id: String,
    installation_id: String,
    credential_hash: String,
    scope: String,
    refresh_token: Option<String>,
) -> Response {
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let claims = McpAccessClaims {
        sub: bot_id,
        installation_id,
        credential_hash,
        scope: scope.clone(),
        aud: state.config.mcp_resource_url(),
        iss: state.config.mcp_authorization_issuer(),
        token_use: MCP_TOKEN_USE.to_string(),
        exp: now + MCP_ACCESS_TOKEN_TTL_SECS,
        iat: now,
        nbf: now,
    };
    let token = match encode(
        &Header::new(Algorithm::RS256),
        &claims,
        &state.config.jwt.encoding,
    ) {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(error = %error, "MCP access-token signing failed");
            return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    private_json_response(
        StatusCode::OK,
        json!(McpTokenResponse {
            access_token: token,
            token_type: "Bearer",
            expires_in: MCP_ACCESS_TOKEN_TTL_SECS,
            scope,
            refresh_token,
        }),
    )
}

async fn exchange_authorization_code(state: &AppState, request: McpTokenRequest) -> Response {
    if request.resource.as_deref() != Some(state.config.mcp_resource_url().as_str()) {
        return oauth_token_error(
            "invalid_target",
            "resource is required and must identify this MCP endpoint",
        );
    }
    let (Some(code), Some(client_id), Some(redirect_uri), Some(verifier)) = (
        request.code.as_deref(),
        request.client_id.as_deref(),
        request.redirect_uri.as_deref(),
        request.code_verifier.as_deref(),
    ) else {
        return oauth_token_error(
            "invalid_request",
            "code, client_id, redirect_uri and code_verifier are required",
        );
    };
    if verifier.len() < 43 || verifier.len() > 128 {
        return oauth_token_error("invalid_grant", "code_verifier is invalid");
    }
    let challenge = URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(_) => return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    let row = match sqlx::query(
        "UPDATE mcp_oauth_authorization_codes SET used_at=NOW()
         WHERE code_hash=$1 AND used_at IS NULL AND expires_at>NOW()
           AND client_id=$2 AND redirect_uri=$3 AND resource=$4 AND code_challenge=$5
         RETURNING installation_id, scope",
    )
    .bind(hash_oauth_secret(code))
    .bind(client_id)
    .bind(redirect_uri)
    .bind(state.config.mcp_resource_url())
    .bind(challenge)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            return oauth_token_error("invalid_grant", "authorization code is invalid or expired")
        }
        Err(error) => {
            tracing::error!(%error, "MCP authorization-code exchange failed");
            return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    let installation_id: String = match row.try_get("installation_id") {
        Ok(value) => value,
        Err(_) => return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    let scope: String = match row.try_get("scope") {
        Ok(value) => value,
        Err(_) => return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    let installation = match active_installation(&mut tx, &installation_id).await {
        Ok(Some(value)) => value,
        Ok(None) => return oauth_token_error("invalid_grant", "installation is no longer active"),
        Err(error) => {
            tracing::error!(%error, "MCP installation lookup failed");
            return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    let refresh_token = match random_oauth_secret() {
        Ok(value) => value,
        Err(_) => return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    let refresh_token_id = Uuid::new_v4().to_string();
    if let Err(error) = sqlx::query(
        "INSERT INTO mcp_oauth_refresh_tokens
         (refresh_token_id,family_id,token_hash,installation_id,client_id,scope,resource,expires_at)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(refresh_token_id)
    .bind(hash_oauth_secret(&refresh_token))
    .bind(&installation_id)
    .bind(client_id)
    .bind(&scope)
    .bind(state.config.mcp_resource_url())
    .bind(Utc::now() + Duration::days(MCP_REFRESH_TOKEN_TTL_DAYS))
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "MCP refresh-token persistence failed");
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    if tx.commit().await.is_err() {
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    mint_mcp_access_token(
        state,
        installation.0,
        installation_id,
        installation.1,
        scope,
        Some(refresh_token),
    )
}

async fn exchange_refresh_token(state: &AppState, request: McpTokenRequest) -> Response {
    if request.resource.as_deref() != Some(state.config.mcp_resource_url().as_str()) {
        return oauth_token_error(
            "invalid_target",
            "resource is required and must identify this MCP endpoint",
        );
    }
    let (Some(refresh_token), Some(client_id)) = (
        request.refresh_token.as_deref(),
        request.client_id.as_deref(),
    ) else {
        return oauth_token_error(
            "invalid_request",
            "refresh_token and client_id are required",
        );
    };
    let replacement = match random_oauth_secret() {
        Ok(value) => value,
        Err(_) => return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    let replacement_id = Uuid::new_v4().to_string();
    let mut tx = match state.db.begin().await {
        Ok(tx) => tx,
        Err(_) => return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    let row = match sqlx::query(
        "SELECT refresh_token_id, family_id, installation_id, scope
         FROM mcp_oauth_refresh_tokens
         WHERE token_hash=$1 AND client_id=$2 AND resource=$3
           AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at>NOW()
         FOR UPDATE",
    )
    .bind(hash_oauth_secret(refresh_token))
    .bind(client_id)
    .bind(state.config.mcp_resource_url())
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            // A replay of a rotated token revokes the complete token family.
            // The response remains opaque for random or expired tokens.
            let _ = sqlx::query(
                "UPDATE mcp_oauth_refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW())
                 WHERE family_id=(SELECT family_id FROM mcp_oauth_refresh_tokens
                                  WHERE token_hash=$1 AND client_id=$2 AND resource=$3 LIMIT 1)",
            )
            .bind(hash_oauth_secret(refresh_token))
            .bind(client_id)
            .bind(state.config.mcp_resource_url())
            .execute(&mut *tx)
            .await;
            let _ = tx.commit().await;
            return oauth_token_error("invalid_grant", "refresh token is invalid or expired");
        }
        Err(error) => {
            tracing::error!(%error, "MCP refresh-token rotation failed");
            return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
        }
    };
    let original_id: String = row.try_get("refresh_token_id").unwrap_or_default();
    let family_id: String = row.try_get("family_id").unwrap_or_default();
    let installation_id: String = row.try_get("installation_id").unwrap_or_default();
    let original_scope: String = row.try_get("scope").unwrap_or_default();
    let scope = match request.scope.as_deref() {
        None => original_scope,
        Some(raw) => match narrowed_scope(&original_scope, raw) {
            Ok(value) => value,
            Err(message) => return oauth_token_error("invalid_scope", &message),
        },
    };
    let installation = match active_installation(&mut tx, &installation_id).await {
        Ok(Some(value)) => value,
        _ => return oauth_token_error("invalid_grant", "installation is no longer active"),
    };
    if let Err(error) = sqlx::query(
        "INSERT INTO mcp_oauth_refresh_tokens
         (refresh_token_id,family_id,token_hash,installation_id,client_id,scope,resource,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    )
    .bind(&replacement_id)
    .bind(&family_id)
    .bind(hash_oauth_secret(&replacement))
    .bind(&installation_id)
    .bind(client_id)
    .bind(&scope)
    .bind(state.config.mcp_resource_url())
    .bind(Utc::now() + Duration::days(MCP_REFRESH_TOKEN_TTL_DAYS))
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "MCP rotated refresh-token persistence failed");
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    if let Err(error) = sqlx::query(
        "UPDATE mcp_oauth_refresh_tokens SET rotated_at=NOW(), replaced_by_id=$1
         WHERE refresh_token_id=$2 AND rotated_at IS NULL AND revoked_at IS NULL",
    )
    .bind(&replacement_id)
    .bind(&original_id)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "MCP old refresh-token finalization failed");
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    if tx.commit().await.is_err() {
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    mint_mcp_access_token(
        state,
        installation.0,
        installation_id,
        installation.1,
        scope,
        Some(replacement),
    )
}

async fn active_installation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    installation_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT i.bot_id, i.credential_hash
         FROM terminal_installations i JOIN bot_accounts b ON b.bot_id=i.bot_id
         WHERE i.installation_id=$1 AND i.status='active' AND i.revoked_at IS NULL
           AND i.credential_hash IS NOT NULL AND b.is_disabled=FALSE",
    )
    .bind(installation_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.and_then(|row| {
        Some((
            row.try_get("bot_id").ok()?,
            row.try_get("credential_hash").ok()?,
        ))
    }))
}

fn narrowed_scope(original: &str, requested: &str) -> Result<String, String> {
    let original =
        parse_requested_scopes(original).ok_or_else(|| "stored scope is invalid".to_string())?;
    let requested = parse_requested_scopes(requested)
        .ok_or_else(|| "requested scope is invalid".to_string())?;
    if requested.iter().any(|scope| !original.contains(scope)) {
        return Err("refresh requests may only narrow the existing grant".into());
    }
    Ok(requested.join(" "))
}

/// Stateless MCP 2026-07-28 HTTP endpoint. Every request carries protocol and
/// client capability metadata; no initialize/session state is retained.
pub async fn mcp_http(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if !origin_allowed(&state, &headers) {
        return mcp_http_error(StatusCode::FORBIDDEN, "origin is not allowed");
    }
    if !is_json_content_type(&headers) {
        return rpc_error_response(
            StatusCode::BAD_REQUEST,
            Value::Null,
            -32600,
            "Content-Type must be application/json",
            None,
        );
    }
    let identity = match authenticate_mcp(&state, &headers).await {
        Ok(identity) => identity,
        Err(AuthMcpError::Unauthorized) => return unauthorized_mcp_response(&state),
        Err(AuthMcpError::Internal) => {
            return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    };
    tracing::debug!(bot_id=%identity.bot_id, installation_id=%identity.installation_id, "authorized MCP request");

    let request: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return rpc_error_response(
                StatusCode::BAD_REQUEST,
                Value::Null,
                -32700,
                "Parse error",
                None,
            )
        }
    };
    let Some(object) = request.as_object() else {
        return rpc_error_response(
            StatusCode::BAD_REQUEST,
            Value::Null,
            -32600,
            "Invalid Request",
            None,
        );
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !matches!(id, Value::String(_) | Value::Number(_))
    {
        return rpc_error_response(StatusCode::BAD_REQUEST, id, -32600, "Invalid Request", None);
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return rpc_error_response(StatusCode::BAD_REQUEST, id, -32600, "Invalid Request", None);
    };
    let params = match object.get("params") {
        Some(Value::Object(params)) => params,
        _ => {
            return rpc_error_response(
                StatusCode::BAD_REQUEST,
                id,
                -32602,
                "params and params._meta are required",
                None,
            )
        }
    };

    if let Err(error) = validate_request_metadata(&headers, method, params) {
        return rpc_error_response(
            StatusCode::BAD_REQUEST,
            id,
            error.code,
            error.message,
            error.data,
        );
    }

    let required_scope = if method == "tools/call" {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return invalid_params(id, "name is required");
        };
        let scope = required_scope_for_tool(name).or_else(|| {
            (conformance_fixtures_enabled() && is_conformance_tool(name)).then_some(SCOPE_READ)
        });
        let Some(scope) = scope else {
            return rpc_error_response(StatusCode::NOT_FOUND, id, -32602, "Unknown tool", None);
        };
        scope
    } else {
        SCOPE_READ
    };
    if !identity.scopes.contains(required_scope) {
        return insufficient_scope_response(&state, id, required_scope);
    }

    let result = match method {
        "server/discover" => json!({
            "resultType": "complete",
            "supportedVersions": [MCP_PROTOCOL_VERSION],
            "capabilities": {
                "resources": {"subscribe": false, "listChanged": false},
                "tools": {"listChanged": false},
                "prompts": {"listChanged": false},
                "completions": {}
            },
            "instructions": "Read Cheers resources and call Cheers tools. OAuth scopes are an upper bound; channel membership and role are enforced for every operation.",
            "ttlMs": MCP_CATALOG_TTL_MS,
            "cacheScope": "private",
            "_meta": result_meta()
        }),
        "resources/list" => {
            if params.contains_key("cursor") {
                return invalid_params(id, "cursor is not valid for this unpaginated catalog");
            }
            json!({
                "resultType": "complete",
                "resources": mcp_resource_definitions(),
                "ttlMs": MCP_CATALOG_TTL_MS,
                "cacheScope": "private",
                "_meta": result_meta()
            })
        }
        "resources/templates/list" => {
            if params.contains_key("cursor") {
                return invalid_params(id, "cursor is not valid for this unpaginated catalog");
            }
            json!({
                "resultType": "complete",
                "resourceTemplates": mcp_resource_template_definitions(),
                "ttlMs": MCP_CATALOG_TTL_MS,
                "cacheScope": "private",
                "_meta": result_meta()
            })
        }
        "resources/read" => {
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return invalid_params(id, "uri is required");
            };
            match read_resource(&state, identity.bot_id, uri).await {
                Ok(content) => json!({
                    "resultType": "complete",
                    "contents": [content],
                    "ttlMs": 0,
                    "cacheScope": "private",
                    "_meta": result_meta()
                }),
                Err(ResourceReadError::Invalid(message)) => return invalid_params(id, &message),
                Err(ResourceReadError::Unavailable) => {
                    return rpc_error_response(
                        StatusCode::OK,
                        id,
                        -32602,
                        "resource is unavailable",
                        None,
                    )
                }
                Err(ResourceReadError::NotFound(uri)) => {
                    return rpc_error_response(
                        StatusCode::OK,
                        id,
                        -32602,
                        "Resource not found",
                        Some(json!({"uri": uri})),
                    )
                }
                Err(ResourceReadError::Internal) => {
                    return rpc_error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        id,
                        -32603,
                        "Internal error",
                        None,
                    )
                }
            }
        }
        "tools/list" => {
            if params.contains_key("cursor") {
                return invalid_params(id, "cursor is not valid for this unpaginated catalog");
            }
            json!({
                "resultType": "complete",
                "tools": mcp_tool_definitions(),
                "ttlMs": MCP_CATALOG_TTL_MS,
                "cacheScope": "private",
                "_meta": result_meta()
            })
        }
        "prompts/list" => {
            if params.contains_key("cursor") {
                return invalid_params(id, "cursor is not valid for this unpaginated catalog");
            }
            json!({
                "resultType": "complete",
                "prompts": prompt_definitions(),
                "ttlMs": MCP_CATALOG_TTL_MS,
                "cacheScope": "private",
                "_meta": result_meta()
            })
        }
        "prompts/get" => match get_prompt(&state, identity.bot_id, params).await {
            Ok(result) => result,
            Err(message) => return invalid_params(id, &message),
        },
        "completion/complete" => match complete_argument(&state, identity.bot_id, params).await {
            Ok(result) => result,
            Err(message) => return invalid_params(id, &message),
        },
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .expect("validated above");
            let arguments = match params.get("arguments") {
                None => Map::new(),
                Some(Value::Object(arguments)) => arguments.clone(),
                Some(_) => return invalid_params(id, "arguments must be an object"),
            };
            if conformance_fixtures_enabled() {
                match conformance_tool_result(&state, name, params, &headers) {
                    Ok(Some(result)) => result,
                    Err(error) => {
                        return rpc_error_response(
                            error.status,
                            id,
                            error.code,
                            error.message,
                            error.data,
                        )
                    }
                    Ok(None) => match call_tool(&state, identity.bot_id, name, &arguments).await {
                        Ok(data) => complete_tool_result(data),
                        Err(ToolCallFailure::Invalid(message)) => {
                            return invalid_params(id, &message)
                        }
                        Err(ToolCallFailure::Domain { code, message }) => {
                            tool_error_result(&code, &message)
                        }
                    },
                }
            } else {
                match call_tool(&state, identity.bot_id, name, &arguments).await {
                    Ok(data) => complete_tool_result(data),
                    Err(ToolCallFailure::Invalid(message)) => return invalid_params(id, &message),
                    Err(ToolCallFailure::Domain { code, message }) => {
                        tool_error_result(&code, &message)
                    }
                }
            }
        }
        _ => {
            return rpc_error_response(StatusCode::NOT_FOUND, id, -32601, "Method not found", None)
        }
    };

    let final_response = json!({"jsonrpc": "2.0", "id": id, "result": result});
    if method == "tools/call" {
        if let Some(progress_token) = params
            .get("_meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("progressToken"))
        {
            return progress_sse_response(progress_token, final_response);
        }
        if conformance_fixtures_enabled()
            && params.get("name").and_then(Value::as_str) == Some("test_streaming_elicitation")
        {
            return progress_sse_response(&json!("token-abc"), final_response);
        }
    }
    private_json_response(StatusCode::OK, final_response)
}

fn complete_tool_result(data: Value) -> Value {
    json!({
        "resultType": "complete",
        "content": tool_content(&data),
        "structuredContent": data,
        "isError": false,
        "ttlMs": 0,
        "cacheScope": "private",
        "_meta": result_meta()
    })
}

fn tool_error_result(code: &str, message: &str) -> Value {
    json!({
        "resultType": "complete",
        "content": [{"type": "text", "text": format!("[{code}] {message}")}],
        "isError": true,
        "ttlMs": 0,
        "cacheScope": "private",
        "_meta": result_meta()
    })
}

const TEST_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TEST_WAV_BASE64: &str = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

fn is_conformance_tool(name: &str) -> bool {
    matches!(
        name,
        "test_simple_text"
            | "test_image_content"
            | "test_audio_content"
            | "test_embedded_resource"
            | "test_multiple_content_types"
            | "test_error_handling"
            | "test_tool_with_progress"
            | "json_schema_2020_12_tool"
            | "test_headers"
            | "test_missing_capability"
            | "test_streaming_elicitation"
            | "test_logging_tool"
            | "test_input_required_result_elicitation"
            | "test_input_required_result_sampling"
            | "test_input_required_result_list_roots"
            | "test_input_required_result_request_state"
            | "test_input_required_result_multiple_inputs"
            | "test_input_required_result_multi_round"
            | "test_input_required_result_tampered_state"
            | "test_input_required_result_capabilities"
    )
}

fn fixture_tool(name: &str, description: &str) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":{},"additionalProperties":false}})
}

fn mcp_tool_definitions() -> Vec<Value> {
    let tools = tool_definitions();
    if !conformance_fixtures_enabled() {
        return tools;
    }
    let mut fixtures = vec![
        fixture_tool("test_simple_text", "Tests simple text content response"),
        fixture_tool("test_image_content", "Tests image content response"),
        fixture_tool("test_audio_content", "Tests audio content response"),
        fixture_tool(
            "test_embedded_resource",
            "Tests embedded resource content response",
        ),
        fixture_tool(
            "test_multiple_content_types",
            "Tests mixed content response",
        ),
        fixture_tool("test_error_handling", "Tests tool error result"),
        fixture_tool("test_tool_with_progress", "Tests request-scoped progress"),
        fixture_tool(
            "test_missing_capability",
            "Requires the sampling client capability",
        ),
        fixture_tool(
            "test_streaming_elicitation",
            "Tests response stream framing",
        ),
        fixture_tool("test_logging_tool", "Tests request-scoped logging"),
    ];
    for name in [
        "test_input_required_result_elicitation",
        "test_input_required_result_sampling",
        "test_input_required_result_list_roots",
        "test_input_required_result_request_state",
        "test_input_required_result_multiple_inputs",
        "test_input_required_result_multi_round",
        "test_input_required_result_tampered_state",
        "test_input_required_result_capabilities",
    ] {
        fixtures.push(fixture_tool(name, "Tests stateless input-required results"));
    }
    fixtures.push(json!({
        "name":"test_headers",
        "description":"Tests SEP-2243 custom parameter headers",
        "inputSchema":{"type":"object","properties":{"value":{"type":"string","x-mcp-header":"Value"}},"required":["value"],"additionalProperties":false}
    }));
    fixtures.push(json!({
        "name":"json_schema_2020_12_tool",
        "description":"Tool with JSON Schema 2020-12 features",
        "inputSchema":{
            "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
            "$defs":{"address":{"$anchor":"addressDef","type":"object","properties":{"street":{"type":"string"},"city":{"type":"string"}}}},
            "properties":{"name":{"type":"string"},"address":{"$ref":"#/$defs/address"},"contactMethod":{"type":"string","enum":["phone","email"]},"phone":{"type":"string"},"email":{"type":"string"}},
            "allOf":[{"anyOf":[{"required":["phone"]},{"required":["email"]}]}],
            "if":{"properties":{"contactMethod":{"const":"phone"}},"required":["contactMethod"]},
            "then":{"required":["phone"]},"else":{"required":["email"]},"additionalProperties":false
        }
    }));
    // The standard-header scenario invokes the first listed tool with no
    // arguments, so keep a harmless fixture first in conformance mode.
    fixtures.extend(tools);
    fixtures
}

struct ConformanceRpcError {
    status: StatusCode,
    code: i64,
    message: &'static str,
    data: Option<Value>,
}

fn conformance_complete(content: Vec<Value>) -> Value {
    json!({"resultType":"complete","content":content,"isError":false,"ttlMs":0,"cacheScope":"private","_meta":result_meta()})
}

fn input_required(requests: Value, state: Option<String>) -> Value {
    let mut value =
        json!({"resultType":"input_required","inputRequests":requests,"_meta":result_meta()});
    if let Some(state) = state {
        value["requestState"] = Value::String(state);
    }
    value
}

fn elicitation_request(message: &str, property: &str, property_type: &str) -> Value {
    json!({"method":"elicitation/create","params":{"message":message,"requestedSchema":{"type":"object","properties":{property:{"type":property_type}},"required":[property]}}})
}

fn signed_request_state(state: &AppState, payload: Value) -> String {
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap_or_default());
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(state.config.jwt_private_key_pem.as_bytes())
        .expect("HMAC accepts arbitrary keys");
    mac.update(encoded.as_bytes());
    format!(
        "{encoded}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

fn verify_request_state(state: &AppState, signed: &str) -> Option<Value> {
    let (encoded, signature) = signed.split_once('.')?;
    let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac =
        Hmac::<sha2::Sha256>::new_from_slice(state.config.jwt_private_key_pem.as_bytes()).ok()?;
    mac.update(encoded.as_bytes());
    mac.verify_slice(&signature).ok()?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()
}

fn conformance_tool_result(
    state: &AppState,
    name: &str,
    params: &Map<String, Value>,
    headers: &HeaderMap,
) -> Result<Option<Value>, ConformanceRpcError> {
    let responses = params.get("inputResponses").and_then(Value::as_object);
    let request_state = params.get("requestState").and_then(Value::as_str);
    let text = |value: &str| conformance_complete(vec![json!({"type":"text","text":value})]);
    let result = match name {
        "test_simple_text" => text("This is a simple text response for testing."),
        "test_image_content" => conformance_complete(vec![
            json!({"type":"image","data":TEST_PNG_BASE64,"mimeType":"image/png"}),
        ]),
        "test_audio_content" => conformance_complete(vec![
            json!({"type":"audio","data":TEST_WAV_BASE64,"mimeType":"audio/wav"}),
        ]),
        "test_embedded_resource" => conformance_complete(vec![
            json!({"type":"resource","resource":{"uri":"test://embedded-resource","mimeType":"text/plain","text":"This is an embedded resource content."}}),
        ]),
        "test_multiple_content_types" => conformance_complete(vec![
            json!({"type":"text","text":"Multiple content types test:"}),
            json!({"type":"image","data":TEST_PNG_BASE64,"mimeType":"image/png"}),
            json!({"type":"resource","resource":{"uri":"test://mixed-content-resource","mimeType":"application/json","text":"{\"test\":\"data\",\"value\":123}"}}),
        ]),
        "test_error_handling" => {
            json!({"resultType":"complete","content":[{"type":"text","text":"Intentional test error"}],"isError":true,"_meta":result_meta()})
        }
        "test_tool_with_progress"
        | "test_streaming_elicitation"
        | "test_logging_tool"
        | "json_schema_2020_12_tool" => text("Success"),
        "test_headers" => {
            let body = params
                .get("arguments")
                .and_then(Value::as_object)
                .and_then(|a| a.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let raw = headers
                .get("mcp-param-value")
                .and_then(|h| h.to_str().ok())
                .ok_or(ConformanceRpcError {
                    status: StatusCode::BAD_REQUEST,
                    code: -32020,
                    message: "Mcp-Param-Value is required",
                    data: None,
                })?;
            let decoded = decode_mcp_param(raw).ok_or(ConformanceRpcError {
                status: StatusCode::BAD_REQUEST,
                code: -32020,
                message: "invalid Mcp-Param Base64 value",
                data: None,
            })?;
            if decoded != body {
                return Err(ConformanceRpcError {
                    status: StatusCode::BAD_REQUEST,
                    code: -32020,
                    message: "Mcp-Param-Value does not match arguments.value",
                    data: None,
                });
            }
            text("Headers validated")
        }
        "test_missing_capability" => {
            let caps = params
                .get("_meta")
                .and_then(Value::as_object)
                .and_then(|m| m.get("io.modelcontextprotocol/clientCapabilities"))
                .and_then(Value::as_object);
            if !caps.is_some_and(|caps| caps.contains_key("sampling")) {
                return Err(ConformanceRpcError {
                    status: StatusCode::BAD_REQUEST,
                    code: -32021,
                    message: "MissingRequiredClientCapabilityError",
                    data: Some(json!({"requiredCapabilities":{"sampling":{}}})),
                });
            }
            text("Success")
        }
        "test_input_required_result_elicitation" => {
            if responses.is_some_and(|r| r.contains_key("user_name")) {
                text("Hello, Alice!")
            } else {
                input_required(
                    json!({"user_name":elicitation_request("What is your name?","name","string")}),
                    None,
                )
            }
        }
        "test_input_required_result_sampling" => {
            if responses.is_some_and(|r| r.contains_key("capital_question")) {
                text("Sampling result received")
            } else {
                input_required(
                    json!({"capital_question":{"method":"sampling/createMessage","params":{"messages":[{"role":"user","content":{"type":"text","text":"What is the capital of France?"}}],"maxTokens":100}}}),
                    None,
                )
            }
        }
        "test_input_required_result_list_roots" => {
            if responses.is_some_and(|r| r.contains_key("client_roots")) {
                text("Roots received")
            } else {
                input_required(
                    json!({"client_roots":{"method":"roots/list","params":{}}}),
                    None,
                )
            }
        }
        "test_input_required_result_request_state" => {
            if let (Some(signed), Some(r)) = (request_state, responses) {
                if verify_request_state(state, signed).is_some() && r.contains_key("confirm") {
                    text("state-ok: requestState validated")
                } else {
                    return Err(ConformanceRpcError {
                        status: StatusCode::BAD_REQUEST,
                        code: -32602,
                        message: "requestState integrity check failed",
                        data: None,
                    });
                }
            } else {
                input_required(
                    json!({"confirm":elicitation_request("Please confirm","ok","boolean")}),
                    Some(signed_request_state(state, json!({"kind":"request-state"}))),
                )
            }
        }
        "test_input_required_result_multiple_inputs" => {
            if request_state
                .and_then(|s| verify_request_state(state, s))
                .is_some()
                && responses.is_some_and(|r| {
                    r.contains_key("user_name")
                        && r.contains_key("greeting")
                        && r.contains_key("client_roots")
                })
            {
                text("All inputs received")
            } else {
                input_required(
                    json!({"user_name":elicitation_request("What is your name?","name","string"),"greeting":{"method":"sampling/createMessage","params":{"messages":[{"role":"user","content":{"type":"text","text":"Generate a greeting"}}],"maxTokens":50}},"client_roots":{"method":"roots/list","params":{}}}),
                    Some(signed_request_state(
                        state,
                        json!({"kind":"multiple-inputs"}),
                    )),
                )
            }
        }
        "test_input_required_result_multi_round" => {
            match request_state
                .and_then(|s| verify_request_state(state, s))
                .and_then(|v| v.get("round").and_then(Value::as_u64))
            {
                None => input_required(
                    json!({"step1":elicitation_request("Step 1: What is your name?","name","string")}),
                    Some(signed_request_state(state, json!({"round":1}))),
                ),
                Some(1) if responses.is_some_and(|r| r.contains_key("step1")) => input_required(
                    json!({"step2":elicitation_request("Step 2: What is your favorite color?","color","string")}),
                    Some(signed_request_state(state, json!({"round":2}))),
                ),
                Some(2) if responses.is_some_and(|r| r.contains_key("step2")) => {
                    text("Multi-round complete")
                }
                _ => {
                    return Err(ConformanceRpcError {
                        status: StatusCode::BAD_REQUEST,
                        code: -32602,
                        message: "invalid requestState",
                        data: None,
                    })
                }
            }
        }
        "test_input_required_result_tampered_state" => {
            if let Some(signed) = request_state {
                if verify_request_state(state, signed).is_none() {
                    return Err(ConformanceRpcError {
                        status: StatusCode::BAD_REQUEST,
                        code: -32602,
                        message: "requestState integrity check failed",
                        data: None,
                    });
                }
                text("integrity-ok: state verified")
            } else {
                input_required(
                    json!({"confirm":elicitation_request("Please confirm","ok","boolean")}),
                    Some(signed_request_state(state, json!({"kind":"tamper-test"}))),
                )
            }
        }
        "test_input_required_result_capabilities" => {
            if responses.is_some_and(|r| !r.is_empty()) {
                text("capabilities-ok")
            } else {
                let caps = params
                    .get("_meta")
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("io.modelcontextprotocol/clientCapabilities"))
                    .and_then(Value::as_object);
                let mut requests = Map::new();
                if caps.is_some_and(|c| c.contains_key("elicitation")) {
                    requests.insert(
                        "elicit_input".into(),
                        elicitation_request("Elicitation input", "value", "string"),
                    );
                }
                if caps.is_some_and(|c| c.contains_key("sampling")) {
                    requests.insert("sample_input".into(),json!({"method":"sampling/createMessage","params":{"messages":[{"role":"user","content":{"type":"text","text":"Sample request"}}],"maxTokens":50}}));
                }
                input_required(
                    Value::Object(requests),
                    Some(signed_request_state(
                        state,
                        json!({"kind":"capabilities-test"}),
                    )),
                )
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

fn decode_mcp_param(raw: &str) -> Option<String> {
    if let Some(encoded) = raw
        .strip_prefix("=?base64?")
        .and_then(|v| v.strip_suffix("?="))
    {
        if encoded.len() % 4 != 0
            || !encoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            return None;
        }
        String::from_utf8(STANDARD.decode(encoded).ok()?).ok()
    } else {
        Some(raw.to_string())
    }
}

fn prompt_definitions() -> Vec<Value> {
    let mut prompts = vec![
        json!({
            "name": "channel_brief",
            "title": "Channel brief",
            "description": "Prepare a concise brief from a Cheers channel's current messages and context.",
            "arguments": [{
                "name": "channel_id",
                "description": "Cheers channel UUID",
                "required": true
            }]
        }),
        json!({
            "name": "review_attachment",
            "title": "Review channel attachment",
            "description": "Review one channel attachment using its standard MCP resource content.",
            "arguments": [
                {"name": "channel_id", "description": "Cheers channel UUID", "required": true},
                {"name": "file_id", "description": "Attachment UUID", "required": true}
            ]
        }),
    ];
    if conformance_fixtures_enabled() {
        prompts.extend([
            json!({"name":"test_simple_prompt","description":"A simple prompt with no arguments"}),
            json!({
                "name":"test_prompt_with_arguments",
                "description":"A prompt with arguments",
                "arguments":[
                    {"name":"arg1","description":"First argument","required":true},
                    {"name":"arg2","description":"Second argument","required":false}
                ]
            }),
            json!({"name":"test_prompt_with_embedded_resource","description":"A prompt with an embedded resource","arguments":[{"name":"resourceUri","required":true}]}),
            json!({"name":"test_prompt_with_image","description":"A prompt with image content"}),
            json!({"name":"test_input_required_result_prompt","description":"A prompt requiring ephemeral client input"}),
        ]);
    }
    prompts.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    prompts
}

async fn get_prompt(
    state: &AppState,
    bot_id: Uuid,
    params: &Map<String, Value>,
) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "name is required".to_string())?;
    let args = match params.get("arguments") {
        None => Map::new(),
        Some(Value::Object(value)) if value.values().all(Value::is_string) => value.clone(),
        _ => return Err("arguments must be an object of strings".into()),
    };
    let text_message = |text: String| {
        json!({
            "resultType":"complete",
            "messages":[{"role":"user","content":{"type":"text","text":text}}],
            "_meta":result_meta()
        })
    };
    match name {
        "test_simple_prompt" if conformance_fixtures_enabled() => Ok(text_message(
            "This is a simple prompt without arguments.".into(),
        )),
        "test_prompt_with_arguments" if conformance_fixtures_enabled() => {
            let arg1 = required_string(&args, "arg1")?;
            let arg2 = args.get("arg2").and_then(Value::as_str).unwrap_or("");
            Ok(text_message(format!("Arguments: arg1={arg1}, arg2={arg2}")))
        }
        "test_prompt_with_embedded_resource" if conformance_fixtures_enabled() => {
            let uri = required_string(&args, "resourceUri")?;
            Ok(json!({"resultType":"complete","messages":[
                {"role":"user","content":{"type":"resource","resource":{"uri":uri,"mimeType":"text/plain","text":"Embedded resource content for testing."}}},
                {"role":"user","content":{"type":"text","text":"Please process the embedded resource above."}}
            ],"_meta":result_meta()}))
        }
        "test_prompt_with_image" if conformance_fixtures_enabled() => Ok(json!({
            "resultType":"complete","messages":[
                {"role":"user","content":{"type":"image","data":TEST_PNG_BASE64,"mimeType":"image/png"}},
                {"role":"user","content":{"type":"text","text":"Please analyze the image above."}}
            ],"_meta":result_meta()
        })),
        "test_input_required_result_prompt" if conformance_fixtures_enabled() => {
            if params
                .get("inputResponses")
                .and_then(Value::as_object)
                .is_some_and(|r| r.contains_key("user_context"))
            {
                Ok(text_message("Prompt with supplied context".into()))
            } else {
                Ok(input_required(
                    json!({"user_context":elicitation_request("What context should the prompt use?","context","string")}),
                    None,
                ))
            }
        }
        "channel_brief" => {
            let channel_id = required_uuid_string(&args, "channel_id")?;
            // Authorize now, rather than returning a prompt that points at a
            // channel the Bot cannot read.
            read_resource(
                state,
                bot_id,
                &format!("cheers://channel/{channel_id}/info"),
            )
            .await
            .map_err(|_| "channel is unavailable".to_string())?;
            Ok(text_message(format!(
                "Prepare a concise brief using cheers://channel/{channel_id}/context and cheers://channel/{channel_id}/messages?limit=100. Distinguish facts, open decisions, risks, and next actions."
            )))
        }
        "review_attachment" => {
            let channel_id = required_uuid_string(&args, "channel_id")?;
            let file_id = required_uuid_string(&args, "file_id")?;
            let uri = format!("cheers://channel/{channel_id}/files/{file_id}?as_base64=true");
            let resource = read_resource(state, bot_id, &uri)
                .await
                .map_err(|_| "attachment is unavailable".to_string())?;
            let content = resource_prompt_content(resource);
            Ok(json!({
                "resultType":"complete",
                "description":"Review the attached channel file.",
                "messages":[
                    {"role":"user","content":{"type":"text","text":"Review this attachment. Summarize it, identify risks, and propose concrete next actions."}},
                    {"role":"user","content":content}
                ],
                "_meta":result_meta()
            }))
        }
        _ => Err("unknown prompt".into()),
    }
}

async fn complete_argument(
    state: &AppState,
    bot_id: Uuid,
    params: &Map<String, Value>,
) -> Result<Value, String> {
    let argument = params
        .get("argument")
        .and_then(Value::as_object)
        .ok_or_else(|| "argument is required".to_string())?;
    let name = argument
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "argument.name is required".to_string())?;
    let prefix = argument
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| "argument.value is required".to_string())?;
    let mut values = Vec::new();
    if name == "channel_id" {
        let rows = sqlx::query(
            "SELECT channel_id FROM channel_memberships
             WHERE member_type = 'bot' AND member_id = $1
             ORDER BY channel_id LIMIT 100",
        )
        .bind(bot_id.to_string())
        .fetch_all(&state.db)
        .await
        .map_err(|_| "completion is unavailable".to_string())?;
        values.extend(
            rows.into_iter()
                .filter_map(|row| row.try_get::<String, _>("channel_id").ok()),
        );
    } else if conformance_fixtures_enabled() {
        values.extend(
            ["apple", "apricot", "banana"]
                .into_iter()
                .map(str::to_string),
        );
    }
    values.retain(|value| value.starts_with(prefix));
    values.sort();
    values.dedup();
    values.truncate(100);
    let total = values.len();
    Ok(json!({
        "resultType":"complete",
        "completion":{"values":values,"total":total,"hasMore":false},
        "_meta":result_meta()
    }))
}

fn required_string<'a>(args: &'a Map<String, Value>, name: &str) -> Result<&'a str, String> {
    args.get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("argument {name} is required"))
}

fn required_uuid_string(args: &Map<String, Value>, name: &str) -> Result<String, String> {
    let value = required_string(args, name)?;
    Uuid::parse_str(value).map_err(|_| format!("argument {name} must be a UUID"))?;
    Ok(value.to_string())
}

fn resource_prompt_content(resource: Value) -> Value {
    if let (Some(blob), Some(mime)) = (
        resource.get("blob").and_then(Value::as_str),
        resource.get("mimeType").and_then(Value::as_str),
    ) {
        if mime.starts_with("image/") {
            return json!({"type":"image","data":blob,"mimeType":mime});
        }
        if mime.starts_with("audio/") {
            return json!({"type":"audio","data":blob,"mimeType":mime});
        }
    }
    json!({"type":"resource","resource":resource})
}

fn tool_content(data: &Value) -> Vec<Value> {
    if data.get("data_b64").and_then(Value::as_str).is_some() {
        let resource = resource_content("cheers://tool-result", data);
        return vec![resource_prompt_content(resource)];
    }
    vec![json!({
        "type":"text",
        "text":serde_json::to_string_pretty(data).unwrap_or_else(|_| data.to_string())
    })]
}

fn progress_sse_response(progress_token: &Value, final_response: Value) -> Response {
    let progress = |value: u8, message: &str| {
        json!({
            "jsonrpc":"2.0",
            "method":"notifications/progress",
            "params":{"progressToken":progress_token,"progress":value,"total":100,"message":message}
        })
    };
    let body = [
        progress(0, "Request accepted"),
        progress(50, "Request in progress"),
        progress(100, "Request completed"),
        final_response,
    ]
    .into_iter()
    .map(|message| format!("data: {}\n\n", message))
    .collect::<String>();
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

enum AuthMcpError {
    Unauthorized,
    Internal,
}

struct McpIdentity {
    bot_id: Uuid,
    installation_id: Uuid,
    scopes: HashSet<String>,
}

fn parse_requested_scopes(raw: &str) -> Option<Vec<&str>> {
    let mut scopes = Vec::new();
    let mut seen = HashSet::new();
    for scope in raw.split_ascii_whitespace() {
        if !ALL_OAUTH_SCOPES.contains(&scope) || !seen.insert(scope) {
            return None;
        }
        scopes.push(scope);
    }
    if scopes.is_empty() {
        None
    } else {
        scopes.sort_unstable();
        Some(scopes)
    }
}

async fn authenticate_mcp(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<McpIdentity, AuthMcpError> {
    let token = bearer_token(headers).ok_or(AuthMcpError::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_exp = true;
    validation.validate_nbf = true;
    let issuer = state.config.mcp_authorization_issuer();
    validation.set_issuer(&[issuer]);
    let audience = state.config.mcp_resource_url();
    validation.set_audience(&[audience]);
    let claims = decode::<McpAccessClaims>(token, &state.config.jwt.decoding, &validation)
        .map_err(|_| AuthMcpError::Unauthorized)?
        .claims;
    let Some(scopes) = parse_requested_scopes(&claims.scope) else {
        return Err(AuthMcpError::Unauthorized);
    };
    if claims.token_use != MCP_TOKEN_USE {
        return Err(AuthMcpError::Unauthorized);
    }
    let bot_id = Uuid::parse_str(&claims.sub).map_err(|_| AuthMcpError::Unauthorized)?;
    let installation_id =
        Uuid::parse_str(&claims.installation_id).map_err(|_| AuthMcpError::Unauthorized)?;
    let row = sqlx::query(
        "SELECT b.is_disabled
         FROM terminal_installations i
         JOIN bot_accounts b ON b.bot_id = i.bot_id
         WHERE i.installation_id = $1 AND i.bot_id = $2
           AND i.credential_hash = $3 AND i.status = 'active'
           AND i.revoked_at IS NULL",
    )
    .bind(installation_id.to_string())
    .bind(bot_id.to_string())
    .bind(&claims.credential_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "MCP access-token revocation lookup failed");
        AuthMcpError::Internal
    })?;
    match row {
        Some(row) if !row.try_get::<bool, _>("is_disabled").unwrap_or(true) => Ok(McpIdentity {
            bot_id,
            installation_id,
            scopes: scopes.into_iter().map(str::to_string).collect(),
        }),
        _ => Err(AuthMcpError::Unauthorized),
    }
}

struct MetadataError {
    code: i64,
    message: &'static str,
    data: Option<Value>,
}

fn validate_request_metadata(
    headers: &HeaderMap,
    method: &str,
    params: &Map<String, Value>,
) -> Result<(), MetadataError> {
    let header_version =
        header_string(headers, MCP_PROTOCOL_VERSION_HEADER).ok_or(MetadataError {
            code: -32020,
            message: "MCP-Protocol-Version header is required",
            data: None,
        })?;
    let header_method = header_string(headers, MCP_METHOD_HEADER).ok_or(MetadataError {
        code: -32020,
        message: "Mcp-Method header is required",
        data: None,
    })?;
    if header_method != method {
        return Err(MetadataError {
            code: -32020,
            message: "Mcp-Method header does not match the request method",
            data: None,
        });
    }
    let expected_name = match method {
        "resources/read" => params.get("uri").and_then(Value::as_str),
        "tools/call" | "prompts/get" => params.get("name").and_then(Value::as_str),
        _ => None,
    };
    match (expected_name, header_string(headers, MCP_NAME_HEADER)) {
        (Some(expected), Some(actual)) if expected == actual => {}
        (Some(_), _) => {
            return Err(MetadataError {
                code: -32020,
                message: "Mcp-Name header is missing or does not match the requested name",
                data: None,
            })
        }
        (None, Some(_)) => {
            return Err(MetadataError {
                code: -32020,
                message: "Mcp-Name is not valid for this method",
                data: None,
            })
        }
        (None, None) => {}
    }
    let meta = params
        .get("_meta")
        .and_then(Value::as_object)
        .ok_or(MetadataError {
            code: -32602,
            message: "params._meta is required",
            data: None,
        })?;
    let body_version = meta
        .get("io.modelcontextprotocol/protocolVersion")
        .and_then(Value::as_str)
        .ok_or(MetadataError {
            code: -32602,
            message: "request protocolVersion metadata is required",
            data: None,
        })?;
    if header_version != body_version {
        return Err(MetadataError {
            code: -32020,
            message: "protocol version header does not match request metadata",
            data: None,
        });
    }
    if body_version != MCP_PROTOCOL_VERSION {
        return Err(MetadataError {
            code: -32022,
            message: "Unsupported protocol version",
            data: Some(json!({
                "supported": [MCP_PROTOCOL_VERSION],
                "requested": body_version
            })),
        });
    }
    if !matches!(
        meta.get("io.modelcontextprotocol/clientCapabilities"),
        Some(Value::Object(_))
    ) {
        return Err(MetadataError {
            code: -32602,
            message: "clientCapabilities metadata is required",
            data: None,
        });
    }
    if let Some(client_info) = meta.get("io.modelcontextprotocol/clientInfo") {
        let valid = client_info
            .as_object()
            .map(|info| {
                info.get("name").and_then(Value::as_str).is_some()
                    && info.get("version").and_then(Value::as_str).is_some()
            })
            .unwrap_or(false);
        if !valid {
            return Err(MetadataError {
                code: -32602,
                message: "clientInfo metadata is malformed",
                data: None,
            });
        }
    }
    Ok(())
}

enum ResourceReadError {
    Invalid(String),
    NotFound(String),
    Unavailable,
    Internal,
}

enum ToolCallFailure {
    Invalid(String),
    Domain { code: String, message: String },
}

async fn call_tool(
    state: &AppState,
    bot_id: Uuid,
    name: &str,
    arguments: &Map<String, Value>,
) -> Result<Value, ToolCallFailure> {
    let call = build_tool_resource_call(name, arguments)
        .map_err(|error| ToolCallFailure::Invalid(error.message))?;
    let frame = json!({
        "type": "resource_req",
        "v": 1,
        "req_id": Uuid::new_v4().to_string(),
        "resource": call.resource,
        "params": call.params
    });
    let response = crate::gateway::resource_effects::dispatch_with_effects(
        state,
        Principal::bot(bot_id),
        &frame,
    )
    .await;
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(response.get("data").cloned().unwrap_or(Value::Null));
    }
    Err(ToolCallFailure::Domain {
        code: response
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("TOOL_ERROR")
            .to_string(),
        message: response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("tool call failed")
            .to_string(),
    })
}

async fn read_resource(
    state: &AppState,
    bot_id: Uuid,
    uri: &str,
) -> Result<Value, ResourceReadError> {
    if conformance_fixtures_enabled() {
        match uri {
            "test://static-text" => {
                return Ok(json!({
                    "uri": uri,
                    "mimeType": "text/plain",
                    "text": "This is the content of the static text resource."
                }))
            }
            "test://static-binary" => {
                return Ok(json!({
                    "uri": uri,
                    "mimeType": "image/png",
                    // A valid 1x1 transparent PNG. This fixture is reachable
                    // only when the explicit conformance switch is enabled.
                    "blob": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                }));
            }
            "test://template/123/data" => {
                return Ok(json!({
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": "{\"id\":\"123\",\"templateTest\":true,\"data\":\"Data for ID: 123\"}"
                }))
            }
            _ => {}
        }
    }
    if uri == RESOURCE_GUIDE_URI {
        return Ok(json!({
            "uri": uri,
            "mimeType": "text/markdown",
            "text": resource_help_text()
        }));
    }
    let call = build_uri_resource_call(uri).map_err(|error| {
        if error.code == "UNSUPPORTED_URI" {
            ResourceReadError::NotFound(uri.to_string())
        } else {
            ResourceReadError::Invalid(error.message)
        }
    })?;
    let req_id = Uuid::new_v4().to_string();
    let frame = json!({
        "type": "resource_req",
        "v": 1,
        "req_id": req_id,
        "resource": call.resource,
        "params": call.params
    });
    let response = resource::dispatch(&state.db, Principal::bot(bot_id), &frame).await;
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        let data = response.get("data").cloned().unwrap_or(Value::Null);
        return Ok(resource_content(uri, &data));
    }
    let code = response.get("code").and_then(Value::as_str).unwrap_or("");
    if code == "INTERNAL_ERROR" {
        Err(ResourceReadError::Internal)
    } else {
        // Do not disclose whether the channel/file exists or the caller simply
        // lacks membership. The same opaque result prevents resource probing.
        Err(ResourceReadError::Unavailable)
    }
}

fn conformance_fixtures_enabled() -> bool {
    std::env::var("CHEERS_MCP_CONFORMANCE_FIXTURES").as_deref() == Ok("1")
}

fn mcp_resource_definitions() -> Vec<Value> {
    let mut resources = resource_definitions();
    if conformance_fixtures_enabled() {
        resources.extend([
            json!({
                "uri": "test://static-text",
                "name": "Conformance static text",
                "description": "Official MCP Resources text fixture.",
                "mimeType": "text/plain"
            }),
            json!({
                "uri": "test://static-binary",
                "name": "Conformance static binary",
                "description": "Official MCP Resources binary fixture.",
                "mimeType": "image/png"
            }),
        ]);
    }
    resources
}

fn mcp_resource_template_definitions() -> Vec<Value> {
    let mut templates = resource_template_definitions();
    if conformance_fixtures_enabled() {
        templates.push(json!({
            "uriTemplate": "test://template/{id}/data",
            "name": "Conformance template",
            "description": "Official MCP Resources URI-template fixture."
        }));
    }
    templates
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn basic_client_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let encoded = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Basic ")?
        .trim();
    let decoded = STANDARD.decode(encoded).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (client_id, client_secret) = decoded.split_once(':')?;
    if client_id.is_empty() || client_secret.is_empty() {
        return None;
    }
    Some((client_id.to_string(), client_secret.to_string()))
}

fn header_string<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
}

fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    state
        .config
        .allowed_origins()
        .iter()
        .any(|allowed| allowed == origin)
}

fn invalid_params(id: Value, message: &str) -> Response {
    rpc_error_response(StatusCode::BAD_REQUEST, id, -32602, message, None)
}

fn rpc_error_response(
    status: StatusCode,
    id: Value,
    code: i64,
    message: &str,
    data: Option<Value>,
) -> Response {
    let mut error = json!({"code": code, "message": message});
    if let Some(data) = data {
        error["data"] = data;
    }
    private_json_response(status, json!({"jsonrpc": "2.0", "id": id, "error": error}))
}

fn unauthorized_response() -> Response {
    let mut response = mcp_http_error(StatusCode::UNAUTHORIZED, "unauthorized");
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"cheers-mcp\""),
    );
    response
}

fn oauth_token_error(error: &str, description: &str) -> Response {
    let mut response = private_json_response(
        StatusCode::BAD_REQUEST,
        json!({"error": error, "error_description": description}),
    );
    if error == "invalid_client" {
        *response.status_mut() = StatusCode::UNAUTHORIZED;
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"cheers-mcp-oauth\""),
        );
    }
    response
}

fn unauthorized_mcp_response(state: &AppState) -> Response {
    let mut response = mcp_http_error(StatusCode::UNAUTHORIZED, "unauthorized");
    let challenge = unauthorized_mcp_challenge(&state.config.mcp_resource_metadata_url());
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

fn insufficient_scope_response(state: &AppState, id: Value, required_scope: &str) -> Response {
    let mut response = rpc_error_response(
        StatusCode::FORBIDDEN,
        id,
        -32003,
        "Insufficient OAuth scope",
        Some(json!({"requiredScopes": [required_scope]})),
    );
    let challenge =
        insufficient_scope_challenge(&state.config.mcp_resource_metadata_url(), required_scope);
    if let Ok(challenge) = HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, challenge);
    }
    response
}

fn unauthorized_mcp_challenge(metadata_url: &str) -> String {
    format!("Bearer resource_metadata=\"{metadata_url}\", scope=\"{SCOPE_READ}\"")
}

fn insufficient_scope_challenge(metadata_url: &str, required_scope: &str) -> String {
    format!(
        "Bearer error=\"insufficient_scope\", scope=\"{required_scope}\", resource_metadata=\"{metadata_url}\""
    )
}

fn mcp_http_error(status: StatusCode, detail: &str) -> Response {
    private_json_response(status, json!({"detail": detail}))
}

fn private_json_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response.headers_mut().insert(
        HeaderName::from_static("pragma"),
        HeaderValue::from_static("no-cache"),
    );
    response
}

#[derive(Deserialize)]
pub struct McpInput {
    pub config: Option<Value>,
    pub content: Option<String>,
    pub raw: Option<String>,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: Option<Value>,
}

fn parse_input(body: McpInput) -> Result<Value, AppError> {
    if let Some(config) = body.config {
        return Ok(config);
    }
    if let Some(content) = body.content.or(body.raw) {
        return serde_json::from_str(&content)
            .map_err(|e| AppError::BadRequest(format!("invalid JSON: {e}")));
    }
    if let Some(servers) = body.mcp_servers {
        return Ok(json!({"mcpServers": servers}));
    }
    Err(AppError::BadRequest("MCP config is required".into()))
}

fn preview(config: Value, source: &str) -> Result<Value, AppError> {
    let root = config
        .as_object()
        .ok_or_else(|| AppError::BadRequest("MCP config must be an object".into()))?;
    let servers_value = root
        .get("mcpServers")
        .or_else(|| root.get("mcp_servers"))
        .unwrap_or(&config);
    let servers = servers_value
        .as_object()
        .ok_or_else(|| AppError::BadRequest("mcpServers must be an object".into()))?;
    let mut normalized = Map::new();
    let mut previews = Vec::new();
    let mut errors = Vec::new();
    for (name, item) in servers {
        let Some(obj) = item.as_object() else {
            errors.push(format!("{name}: server config must be an object"));
            continue;
        };
        let command = obj
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string);
        let url = obj.get("url").and_then(Value::as_str).map(str::to_string);
        if command.is_none() && url.is_none() {
            errors.push(format!("{name}: either command or url is required"));
        }
        let args = obj
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let env_keys = obj
            .get("env")
            .and_then(Value::as_object)
            .map(|env| {
                let mut keys = env.keys().cloned().collect::<Vec<_>>();
                keys.sort();
                keys
            })
            .unwrap_or_default();
        let transport = obj
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or(if url.is_some() { "http" } else { "stdio" });
        normalized.insert(name.clone(), json!({
            "command": command,
            "args": args,
            "url": url,
            "transport": transport,
            "env": env_keys.iter().map(|k| (k.clone(), Value::String("***".into()))).collect::<Map<_, _>>(),
        }));
        previews.push(json!({
            "name": name,
            "transport": transport,
            "command": command,
            "args": args,
            "url": url,
            "env_keys": env_keys,
            "has_env": !env_keys.is_empty(),
        }));
    }
    Ok(json!({
        "source": source,
        "server_count": previews.len(),
        "is_valid": errors.is_empty(),
        "servers": previews,
        "warnings": [],
        "errors": errors,
        "normalized_config": {"mcpServers": normalized},
    }))
}

pub async fn preview_mcp_config(
    Extension(_claims): Extension<Claims>,
    Json(body): Json<McpInput>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(preview(parse_input(body)?, "mcp")?))
}

pub async fn parse_claude_config(
    Extension(_claims): Extension<Claims>,
    Json(body): Json<McpInput>,
) -> Result<Json<Value>, AppError> {
    Ok(Json(preview(parse_input(body)?, "claude_desktop")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modern_headers(method: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            MCP_PROTOCOL_VERSION_HEADER,
            HeaderValue::from_static(MCP_PROTOCOL_VERSION),
        );
        headers.insert(MCP_METHOD_HEADER, HeaderValue::from_static(method));
        headers
    }

    fn modern_params() -> Map<String, Value> {
        json!({
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientInfo": {
                    "name": "test-client",
                    "version": "1.0.0"
                },
                "io.modelcontextprotocol/clientCapabilities": {}
            }
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn accepts_stateless_request_metadata() {
        let headers = modern_headers("resources/list");
        assert!(validate_request_metadata(&headers, "resources/list", &modern_params()).is_ok());
    }

    #[test]
    fn validates_resource_name_header_against_uri() {
        let mut headers = modern_headers("resources/read");
        headers.insert(MCP_NAME_HEADER, HeaderValue::from_static("test://resource"));
        let mut params = modern_params();
        params.insert("uri".to_string(), json!("test://resource"));
        assert!(validate_request_metadata(&headers, "resources/read", &params).is_ok());

        headers.insert(MCP_NAME_HEADER, HeaderValue::from_static("test://other"));
        assert_eq!(
            validate_request_metadata(&headers, "resources/read", &params)
                .unwrap_err()
                .code,
            -32020
        );
    }

    #[test]
    fn validates_tool_name_header_against_call_name() {
        let mut headers = modern_headers("tools/call");
        headers.insert(MCP_NAME_HEADER, HeaderValue::from_static("post_message"));
        let mut params = modern_params();
        params.insert("name".to_string(), json!("post_message"));
        params.insert("arguments".to_string(), json!({}));
        assert!(validate_request_metadata(&headers, "tools/call", &params).is_ok());

        headers.insert(MCP_NAME_HEADER, HeaderValue::from_static("desk_rm"));
        assert_eq!(
            validate_request_metadata(&headers, "tools/call", &params)
                .unwrap_err()
                .code,
            -32020
        );
    }

    #[test]
    fn oauth_token_scope_parser_is_allowlisted_and_canonical() {
        assert_eq!(
            parse_requested_scopes("cheers:workspace:write cheers:read"),
            Some(vec!["cheers:read", "cheers:workspace:write"])
        );
        assert!(parse_requested_scopes("cheers:read cheers:read").is_none());
        assert!(parse_requested_scopes("admin").is_none());
        assert!(parse_requested_scopes("").is_none());
    }

    #[test]
    fn validates_prompt_name_header_against_prompt_name() {
        let mut headers = modern_headers("prompts/get");
        headers.insert(MCP_NAME_HEADER, HeaderValue::from_static("channel_brief"));
        let mut params = modern_params();
        params.insert("name".to_string(), json!("channel_brief"));
        assert!(validate_request_metadata(&headers, "prompts/get", &params).is_ok());
    }

    #[test]
    fn custom_mcp_parameter_decoder_is_strict() {
        assert_eq!(decode_mcp_param("plain"), Some("plain".into()));
        assert_eq!(
            decode_mcp_param("=?base64?SGVsbG8=?="),
            Some("Hello".into())
        );
        assert_eq!(decode_mcp_param("=?base64?SGVsbG8?="), None);
        assert_eq!(decode_mcp_param("=?base64?SGVs!!!bG8=?="), None);
    }

    #[test]
    fn cimd_ssrf_filter_rejects_private_and_ipv4_mapped_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "198.18.0.1",
            "::1",
            "fc00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn scope_challenges_include_protected_resource_metadata() {
        assert_eq!(
            insufficient_scope_challenge(
                "https://cheers.example/.well-known/oauth-protected-resource",
                "cheers:messages:write"
            ),
            "Bearer error=\"insufficient_scope\", scope=\"cheers:messages:write\", resource_metadata=\"https://cheers.example/.well-known/oauth-protected-resource\""
        );
        assert_eq!(
            unauthorized_mcp_challenge(
                "https://cheers.example/.well-known/oauth-protected-resource"
            ),
            "Bearer resource_metadata=\"https://cheers.example/.well-known/oauth-protected-resource\", scope=\"cheers:read\""
        );
    }

    #[test]
    fn protected_resource_metadata_is_rfc9728_shaped() {
        let metadata = protected_resource_metadata_document(
            "https://cheers.example/mcp",
            Some("https://auth.cheers.example"),
        );
        assert_eq!(metadata["resource"], "https://cheers.example/mcp");
        assert_eq!(
            metadata["authorization_servers"],
            json!(["https://auth.cheers.example"])
        );
        assert_eq!(metadata["bearer_methods_supported"], json!(["header"]));
        assert_eq!(metadata["scopes_supported"], json!(ALL_OAUTH_SCOPES));

        let without_issuer =
            protected_resource_metadata_document("http://localhost:8000/mcp", None);
        assert!(without_issuer.get("authorization_servers").is_none());
    }

    #[test]
    fn rejects_header_body_version_mismatch() {
        let headers = modern_headers("resources/list");
        let mut params = modern_params();
        params["_meta"]["io.modelcontextprotocol/protocolVersion"] = json!("2025-11-25");
        let error = validate_request_metadata(&headers, "resources/list", &params).unwrap_err();
        assert_eq!(error.code, -32020);
    }

    #[test]
    fn rejects_unsupported_matching_version_with_supported_list() {
        let mut headers = modern_headers("resources/list");
        headers.insert(
            MCP_PROTOCOL_VERSION_HEADER,
            HeaderValue::from_static("2099-01-01"),
        );
        let mut params = modern_params();
        params["_meta"]["io.modelcontextprotocol/protocolVersion"] = json!("2099-01-01");
        let error = validate_request_metadata(&headers, "resources/list", &params).unwrap_err();
        assert_eq!(error.code, -32022);
        assert_eq!(
            error.data.unwrap()["supported"],
            json!([MCP_PROTOCOL_VERSION])
        );
    }

    #[test]
    fn catalog_results_are_private_and_cacheable() {
        let result = json!({
            "resultType": "complete",
            "resources": mcp_resource_definitions(),
            "ttlMs": MCP_CATALOG_TTL_MS,
            "cacheScope": "private"
        });
        assert_eq!(result["resultType"], "complete");
        assert!(result["ttlMs"].as_u64().is_some());
        assert_eq!(result["cacheScope"], "private");
    }

    #[test]
    fn remote_tool_catalog_exposes_scoped_reads_and_writes() {
        let tools = tool_definitions();
        let find = |name: &str| {
            tools
                .iter()
                .find(|tool| tool["name"] == name)
                .expect("tool should be present")
        };
        assert_eq!(
            find("read_messages")["_meta"]["io.cheers/requiredScopes"],
            json!(["cheers:read"])
        );
        assert_eq!(
            find("post_message")["_meta"]["io.cheers/requiredScopes"],
            json!(["cheers:messages:write"])
        );
        assert_eq!(
            find("desk_rm")["_meta"]["io.cheers/requiredScopes"],
            json!(["cheers:workspace:write"])
        );
    }

    #[test]
    fn unsupported_resource_uri_is_not_found_not_an_empty_result() {
        let error = build_uri_resource_call("test://missing").unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_URI");
    }
}
