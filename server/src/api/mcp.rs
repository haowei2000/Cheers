use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use cheers_mcp_server::{
    build_uri_resource_call, required_scope_for_tool, resource_content, resource_definitions,
    resource_help_text, resource_template_definitions,
    tools::{build_resource_call as build_tool_resource_call, definitions as tool_definitions},
    ALL_OAUTH_SCOPES, RESOURCE_GUIDE_URI, SCOPE_READ,
};
use jsonwebtoken::{decode, encode, Algorithm, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::collections::HashSet;
use uuid::Uuid;

use crate::{
    api::middleware::{Claims, JWT_ISSUER},
    app_state::AppState,
    errors::AppError,
    infra::crypto::hash_bot_token,
    resource::{self, Principal},
};

const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
const MCP_TOKEN_USE: &str = "mcp_access";
const MCP_ACCESS_TOKEN_TTL_SECS: u64 = 10 * 60;
const MCP_CATALOG_TTL_MS: u64 = 30_000;
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
    let metadata = protected_resource_metadata_document(
        &resource,
        state.config.mcp_authorization_server_issuer.as_deref(),
    );
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

#[derive(Debug, Serialize, Deserialize)]
struct McpAccessClaims {
    sub: String,
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
}

#[derive(Default, Deserialize)]
struct McpTokenRequest {
    /// Transitional Bot-credential exchange. Production OAuth clients obtain
    /// these scopes from the authorization server instead.
    scope: Option<String>,
}

/// Exchange the long-lived bot credential for a narrowly scoped, short-lived
/// MCP access token. The credential hash is embedded and re-checked on every
/// MCP request, so rotating the bot token revokes already-issued access tokens.
pub async fn issue_mcp_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(bot_token) = bearer_token(&headers) else {
        return unauthorized_response();
    };
    let credential_hash = hash_bot_token(bot_token);
    let row =
        match sqlx::query("SELECT bot_id, is_disabled FROM bot_accounts WHERE bot_token_hash = $1")
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
    if Uuid::parse_str(&bot_id).is_err() {
        tracing::error!("MCP token exchange found invalid bot UUID");
        return mcp_http_error(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }

    let request = if body.is_empty() {
        McpTokenRequest::default()
    } else {
        match serde_json::from_slice::<McpTokenRequest>(&body) {
            Ok(request) => request,
            Err(_) => return mcp_http_error(StatusCode::BAD_REQUEST, "invalid token request"),
        }
    };
    let requested_scopes = request.scope.as_deref().unwrap_or(SCOPE_READ);
    let scopes = match parse_requested_scopes(requested_scopes) {
        Some(scopes) => scopes,
        None => return mcp_http_error(StatusCode::BAD_REQUEST, "invalid or unknown scope"),
    };
    let scope = scopes.join(" ");

    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let claims = McpAccessClaims {
        sub: bot_id,
        credential_hash,
        scope: scope.clone(),
        aud: state.config.mcp_resource_url(),
        iss: JWT_ISSUER.to_string(),
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
        }),
    )
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
        let Some(scope) = required_scope_for_tool(name) else {
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
                "tools": {"listChanged": false}
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
                "tools": tool_definitions(),
                "ttlMs": MCP_CATALOG_TTL_MS,
                "cacheScope": "private",
                "_meta": result_meta()
            })
        }
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
            match call_tool(&state, identity.bot_id, name, &arguments).await {
                Ok(data) => json!({
                    "resultType": "complete",
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
                    }],
                    "structuredContent": data,
                    "isError": false,
                    "ttlMs": 0,
                    "cacheScope": "private",
                    "_meta": result_meta()
                }),
                Err(ToolCallFailure::Invalid(message)) => return invalid_params(id, &message),
                Err(ToolCallFailure::Domain { code, message }) => json!({
                    "resultType": "complete",
                    "content": [{"type": "text", "text": format!("[{code}] {message}")}],
                    "isError": true,
                    "ttlMs": 0,
                    "cacheScope": "private",
                    "_meta": result_meta()
                }),
            }
        }
        _ => {
            return rpc_error_response(StatusCode::NOT_FOUND, id, -32601, "Method not found", None)
        }
    };

    private_json_response(
        StatusCode::OK,
        json!({"jsonrpc": "2.0", "id": id, "result": result}),
    )
}

enum AuthMcpError {
    Unauthorized,
    Internal,
}

struct McpIdentity {
    bot_id: Uuid,
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
    validation.set_issuer(&[JWT_ISSUER]);
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
    let row = sqlx::query(
        "SELECT is_disabled FROM bot_accounts WHERE bot_id = $1 AND bot_token_hash = $2",
    )
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
        "tools/call" => params.get("name").and_then(Value::as_str),
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
    fn transitional_token_scope_parser_is_allowlisted_and_canonical() {
        assert_eq!(
            parse_requested_scopes("cheers:workspace:write cheers:read"),
            Some(vec!["cheers:read", "cheers:workspace:write"])
        );
        assert!(parse_requested_scopes("cheers:read cheers:read").is_none());
        assert!(parse_requested_scopes("admin").is_none());
        assert!(parse_requested_scopes("").is_none());
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
