use std::collections::BTreeMap;

use base64::{
    engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD, Engine as _,
};
use chrono::{DateTime, Utc};
use ed25519_dalek::{PublicKey, Signature, Verifier};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::domain::sessions;
use crate::errors::AppError;

const CAPABILITY_CLOCK_TOLERANCE_SECS: i64 = 5 * 60;
const CAPABILITY_ACTION_WILDCARD: &str = "*";
pub const CAPABILITY_SUPPORTED_ALGORITHM: &str = "ed25519";
pub const CAPABILITY_SCOPE_GLOBAL: &str = "global";
pub const CAPABILITY_SCOPE_WORKSPACE: &str = "workspace";
pub const CAPABILITY_SCOPE_CHANNEL: &str = "channel";
pub const CAPABILITY_SCOPE_SESSION: &str = "session";
pub const CAPABILITY_SCOPE_USER: &str = "user";
const CAPABILITY_SESSION_PROVIDER: &str = "acp";

#[derive(Debug, Clone)]
pub struct CapabilityDecisionContext {
    pub delegation_id: String,
    pub delegation_scope_type: String,
    pub delegation_scope_id: Option<String>,
    pub request_id: Option<String>,
    pub action: String,
    pub frame_type: String,
    pub resource: Option<String>,
    pub request_session_id: Option<String>,
    pub resolved_session_id: Option<String>,
    pub resolved_session_status: Option<String>,
    pub resolved_session_scope_type: Option<String>,
    pub resolved_session_scope_id: Option<String>,
    pub session_locator_source: Option<String>,
    pub session_locator_value: Option<String>,
}

#[derive(Debug)]
struct CapabilityEnvelope {
    delegation_id: String,
    request_id: Option<String>,
    ts_secs: i64,
    nonce: String,
    signature: String,
}

#[derive(Debug)]
struct DelegationRecord {
    delegation_id: Uuid,
    bot_id: Uuid,
    scope_type: String,
    scope_id: Option<String>,
    session_id: Option<String>,
    allowed_actions: Vec<String>,
    allowed_resources: Vec<String>,
    max_uses: Option<i64>,
    use_count: i64,
    expires_at: Option<DateTime<Utc>>,
    public_key: String,
    algorithm: String,
    delegated_to: Option<String>,
    status: String,
    revoked: bool,
}

#[derive(Debug)]
struct SessionContext {
    session_id: Uuid,
    status: String,
    current_scope_type: Option<String>,
    current_scope_id: Option<String>,
    provider_session_key: Option<String>,
}

#[derive(Debug)]
pub enum CapabilityError {
    InvalidSignature(String),
    Denied(String),
    DeniedWithContext {
        message: String,
        context: CapabilityDecisionContext,
    },
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSignature(msg) => write!(f, "{msg}"),
            Self::Denied(msg) => write!(f, "{msg}"),
            Self::DeniedWithContext { message, .. } => write!(f, "{message}"),
        }
    }
}

impl CapabilityError {
    pub fn decision_context(&self) -> Option<&CapabilityDecisionContext> {
        match self {
            Self::DeniedWithContext { context, .. } => Some(context),
            _ => None,
        }
    }
}

fn denied_with_context(
    message: impl Into<String>,
    context: CapabilityDecisionContext,
) -> CapabilityError {
    CapabilityError::DeniedWithContext {
        message: message.into(),
        context,
    }
}

#[derive(Debug, Clone)]
enum SessionLocator {
    SessionId(Uuid),
    ProviderSessionKey(String),
    ProviderSessionId(String),
}

impl SessionLocator {
    fn source(&self) -> &'static str {
        match self {
            Self::SessionId(_) => "session_id",
            Self::ProviderSessionKey(_) => "provider_session_key",
            Self::ProviderSessionId(_) => "provider_session_id",
        }
    }

    fn value(&self) -> String {
        match self {
            Self::SessionId(value) => value.to_string(),
            Self::ProviderSessionKey(value) | Self::ProviderSessionId(value) => value.clone(),
        }
    }
}

fn build_decision_context(
    delegation: &DelegationRecord,
    frame_type: &str,
    action: &str,
    resource: Option<&str>,
    request_id: Option<&str>,
    locator: Option<&SessionLocator>,
    session_context: Option<&SessionContext>,
) -> CapabilityDecisionContext {
    CapabilityDecisionContext {
        delegation_id: delegation.delegation_id.to_string(),
        delegation_scope_type: delegation.scope_type.clone(),
        delegation_scope_id: delegation.scope_id.clone(),
        request_id: request_id.map(ToString::to_string),
        action: action.to_string(),
        frame_type: frame_type.to_string(),
        resource: resource.map(ToString::to_string),
        request_session_id: delegation.session_id.clone(),
        resolved_session_id: session_context.map(|ctx| ctx.session_id.to_string()),
        resolved_session_status: session_context.map(|ctx| ctx.status.clone()),
        resolved_session_scope_type: session_context.and_then(|ctx| ctx.current_scope_type.clone()),
        resolved_session_scope_id: session_context.and_then(|ctx| ctx.current_scope_id.clone()),
        session_locator_source: locator.map(SessionLocator::source).map(ToString::to_string),
        session_locator_value: locator.map(|loc| loc.value()),
    }
}

fn decode_b64(input: &str) -> Result<Vec<u8>, CapabilityError> {
    STANDARD
        .decode(input)
        .or_else(|_| URL_SAFE_NO_PAD.decode(input))
        .map_err(|_| CapabilityError::InvalidSignature("invalid base64 payload".into()))
}

pub fn validate_public_key(algorithm: &str, public_key: &str) -> Result<(), CapabilityError> {
    if algorithm.to_lowercase().as_str() != CAPABILITY_SUPPORTED_ALGORITHM {
        return Err(CapabilityError::InvalidSignature(format!(
            "unsupported capability algorithm: {algorithm}"
        )));
    }

    let bytes = decode_b64(public_key)?;
    if bytes.len() != 32 {
        return Err(CapabilityError::InvalidSignature(
            "ed25519 public key must be 32 bytes".into(),
        ));
    }
    let key_arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| CapabilityError::InvalidSignature("invalid ed25519 public key".into()))?;
    PublicKey::from_bytes(&key_arr)
        .map(|_| ())
        .map_err(|_| CapabilityError::InvalidSignature("invalid ed25519 public key".into()))
}

fn parse_envelope(frame: &Value) -> Result<CapabilityEnvelope, CapabilityError> {
    let obj = frame
        .get("acp_capability")
        .and_then(Value::as_object)
        .ok_or_else(|| CapabilityError::Denied("missing acp_capability envelope".into()))?;

    let delegation_id = obj
        .get("delegation_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CapabilityError::Denied("missing delegation_id".into()))?
        .to_string();
    if Uuid::parse_str(&delegation_id).is_err() {
        return Err(CapabilityError::Denied("delegation_id must be UUID".into()));
    }

    let ts_value = obj
        .get("ts")
        .ok_or_else(|| CapabilityError::Denied("missing ts".into()))?;
    let ts_secs = parse_unix_seconds(ts_value)
        .ok_or_else(|| CapabilityError::Denied("ts must be unix seconds or RFC3339".into()))?;

    let nonce = obj
        .get("nonce")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| CapabilityError::Denied("missing nonce".into()))?;

    let signature = obj
        .get("signature")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| CapabilityError::Denied("missing signature".into()))?;

    let request_id = obj
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    Ok(CapabilityEnvelope {
        delegation_id,
        request_id,
        ts_secs,
        nonce,
        signature,
    })
}

fn parse_unix_seconds(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value.as_str().and_then(|raw| {
            DateTime::parse_from_rfc3339(raw)
                .map(|t| t.timestamp())
                .ok()
        })
    })
}

fn now_epoch() -> i64 {
    Utc::now().timestamp()
}

fn extract_frame_type(frame: &Value) -> &str {
    frame.get("type").and_then(Value::as_str).unwrap_or("")
}

fn frame_needs_capability(frame_type: &str) -> bool {
    matches!(
        frame_type,
        "send"
            | "delta"
            | "done"
            | "resource_req"
            | "session_update"
            | "permission_request"
            | "trace"
    )
}

fn frame_action(frame_type: &str) -> Option<&str> {
    match frame_type {
        "send" => Some("send"),
        "delta" => Some("stream"),
        "done" => Some("stream"),
        "resource_req" => Some("resource_req"),
        "session_update" => Some("session_update"),
        "permission_request" => Some("permission_request"),
        "trace" => Some("trace"),
        _ => None,
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(values) => {
            let mut out = String::from("[");
            for i in 0..values.len() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&canonical_json(&values[i]));
            }
            out.push(']');
            out
        }
        Value::Object(obj) => {
            let mut entries: Vec<_> = obj.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));

            let mut out = String::from("{");
            let mut first = true;
            for (key, value) in entries {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                out.push_str(&canonical_json(value));
            }
            out.push('}');
            out
        }
    }
}

fn signing_payload(frame_type: &str, envelope: &CapabilityEnvelope, frame: &Value) -> String {
    let mut sanitized = frame.clone();
    if let Value::Object(map) = &mut sanitized {
        map.remove("acp_capability");
    }
    let payload = canonical_json(&sanitized);
    format!(
        "anx-cap|v1|type={}|kid={}|ts={}|nonce={}|request={}|payload={}",
        frame_type,
        envelope.delegation_id,
        envelope.ts_secs,
        envelope.nonce,
        envelope.request_id.as_deref().unwrap_or(""),
        payload
    )
}

fn action_allowed(allowed: &[String], action: &str) -> bool {
    if allowed
        .iter()
        .any(|v| v == CAPABILITY_ACTION_WILDCARD || v == action)
    {
        return true;
    }
    false
}

fn resource_matches(grant_resource: &str, requested: &str) -> bool {
    if grant_resource == CAPABILITY_ACTION_WILDCARD {
        return true;
    }
    if let Some(prefix) = grant_resource.strip_suffix(":*") {
        return requested.starts_with(&format!("{prefix}:")) || requested == prefix;
    }
    if let Some(prefix) = grant_resource.strip_suffix(".*") {
        return requested.starts_with(&format!("{prefix}.")) || requested == prefix;
    }
    grant_resource == requested
}

fn resource_allowed(resources: &[String], resource: &str) -> bool {
    resources.is_empty()
        || resources
            .iter()
            .any(|value| resource_matches(value, resource))
}

fn extract_channel_id(frame: &Value) -> Option<String> {
    frame
        .get("channel_id")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            frame
                .get("params")
                .and_then(|params| params.get("channel_id"))
                .and_then(Value::as_str)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

fn extract_session_id(frame: &Value) -> Option<String> {
    frame
        .get("session_id")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            frame
                .get("acp_session_id")
                .and_then(Value::as_str)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

fn extract_provider_session_key(frame: &Value) -> Option<String> {
    frame
        .get("provider_session_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn extract_provider_session_id(frame: &Value) -> Option<String> {
    frame
        .get("provider_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn extract_session_locator(frame: &Value) -> Option<SessionLocator> {
    if let Some(key) = extract_provider_session_key(frame) {
        return Some(SessionLocator::ProviderSessionKey(key));
    }
    if let Some(id) = extract_provider_session_id(frame) {
        return Some(SessionLocator::ProviderSessionId(id));
    }
    if let Some(value) = extract_session_id(frame) {
        if let Ok(uuid) = Uuid::parse_str(&value) {
            return Some(SessionLocator::SessionId(uuid));
        }
    }
    None
}

fn is_session_active(status: &str) -> bool {
    status == sessions::SESSION_STATUS_ACTIVE || status == sessions::SESSION_STATUS_BUSY
}

async fn resolve_active_session(
    db: &PgPool,
    bot_id: &Uuid,
    provider_account_id: &str,
    locator: SessionLocator,
) -> Result<SessionContext, CapabilityError> {
    let (query, value) = match locator {
        SessionLocator::SessionId(session_id) => (
            "SELECT session_id, status, current_scope_type, current_scope_id, provider_session_key
             FROM cheers_sessions
             WHERE bot_id = $1 AND provider = $2 AND provider_account_id = $3 AND session_id = $4
             LIMIT 1",
            session_id.to_string(),
        ),
        SessionLocator::ProviderSessionKey(provider_session_key) => (
            "SELECT session_id, status, current_scope_type, current_scope_id, provider_session_key
             FROM cheers_sessions
             WHERE bot_id = $1 AND provider = $2 AND provider_account_id = $3 AND provider_session_key = $4
             LIMIT 1",
            provider_session_key,
        ),
        SessionLocator::ProviderSessionId(provider_session_id) => (
            "SELECT session_id, status, current_scope_type, current_scope_id, provider_session_key
             FROM cheers_sessions
             WHERE bot_id = $1 AND provider = $2 AND provider_account_id = $3 AND provider_session_id = $4
             ORDER BY updated_at DESC
             LIMIT 1",
            provider_session_id,
        ),
    };

    let row = sqlx::query(query)
        .bind(bot_id.to_string())
        .bind(CAPABILITY_SESSION_PROVIDER)
        .bind(provider_account_id)
        .bind(&value)
        .fetch_optional(db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, ctx = "session lookup: select capability session", "acp_capability db error");
            CapabilityError::Denied("session lookup failed".into())
        })?
        .ok_or_else(|| CapabilityError::Denied("session not found".into()))?;

    let status: String = row
        .try_get("status")
        .unwrap_or_else(|_| sessions::SESSION_STATUS_IDLE.to_string());
    if !is_session_active(&status) {
        return Err(CapabilityError::Denied("session is not active".into()));
    }

    let session_id: Uuid = row
        .try_get("session_id")
        .map_err(|_| CapabilityError::Denied("invalid session".into()))?;

    Ok(SessionContext {
        session_id,
        status,
        current_scope_type: row.try_get("current_scope_type").ok(),
        current_scope_id: row.try_get("current_scope_id").ok(),
        provider_session_key: row.try_get("provider_session_key").ok(),
    })
}

fn extract_resource(frame: &Value) -> Option<String> {
    frame
        .get("resource")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn verify_scope_with_context(
    delegation: &DelegationRecord,
    frame_type: &str,
    action: &str,
    frame: &Value,
    resource: Option<&str>,
    request_id: Option<&str>,
    session_context: Option<&SessionContext>,
    locator: Option<&SessionLocator>,
) -> Result<(), CapabilityError> {
    let scope_id = delegation.scope_id.clone().unwrap_or_default();
    let context = build_decision_context(
        delegation,
        frame_type,
        action,
        resource,
        request_id,
        locator,
        session_context,
    );

    match delegation.scope_type.as_str() {
        CAPABILITY_SCOPE_GLOBAL => Ok(()),
        CAPABILITY_SCOPE_CHANNEL => {
            let frame_scope = extract_channel_id(frame).ok_or_else(|| {
                denied_with_context(
                    "channel-scoped delegation requires channel_id",
                    context.clone(),
                )
            })?;
            if frame_scope == scope_id {
                return Ok(());
            }
            Err(denied_with_context("channel scope mismatch", context))
        }
        CAPABILITY_SCOPE_SESSION => {
            let expected_session_id = delegation
                .session_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| {
                    denied_with_context(
                        "session-scoped delegation missing session_id",
                        context.clone(),
                    )
                })?;

            let session_context = session_context.ok_or_else(|| {
                denied_with_context(
                    "session context is required for session scope",
                    context.clone(),
                )
            })?;
            if session_context.session_id != expected_session_id {
                return Err(denied_with_context("session scope mismatch", context));
            }
            if !is_session_active(&session_context.status) {
                return Err(denied_with_context("session is not active", context));
            }
            Ok(())
        }
        CAPABILITY_SCOPE_USER => {
            if delegation.delegated_to.is_none() {
                return Err(denied_with_context(
                    "user-scoped delegation has no target",
                    context,
                ));
            }
            if action == "resource_req" {
                if let Some(res) = resource {
                    if !resource_allowed(&delegation.allowed_resources, res) {
                        return Err(denied_with_context(
                            "resource denied by user-scoped delegation",
                            context,
                        ));
                    }
                }
            }
            Ok(())
        }
        CAPABILITY_SCOPE_WORKSPACE => {
            if scope_id.trim().is_empty() {
                return Err(denied_with_context(
                    "workspace-scoped delegation missing scope_id",
                    context,
                ));
            }
            let session_context = session_context.ok_or_else(|| {
                denied_with_context("workspace scope requires session context", context.clone())
            })?;
            if session_context.current_scope_type.as_deref() != Some(CAPABILITY_SCOPE_WORKSPACE) {
                return Err(denied_with_context(
                    "session is not in workspace scope",
                    context,
                ));
            }
            if session_context.current_scope_id.as_deref() != Some(scope_id.as_str()) {
                return Err(denied_with_context("workspace scope mismatch", context));
            }
            Ok(())
        }
        _ => Err(denied_with_context(
            format!("unsupported scope_type {}", delegation.scope_type),
            context,
        )),
    }
}

async fn verify_scope(
    db: &PgPool,
    bot_id: &Uuid,
    provider_account_id: &str,
    delegation: &DelegationRecord,
    frame: &Value,
    action: &str,
    resource: Option<&str>,
    request_id: Option<&str>,
) -> Result<(), CapabilityError> {
    let locator = extract_session_locator(frame);
    let frame_type = extract_frame_type(frame);
    let base_context = build_decision_context(
        delegation,
        frame_type,
        action,
        resource,
        request_id,
        locator.as_ref(),
        None,
    );

    let mut session_context = None;
    if matches!(
        delegation.scope_type.as_str(),
        CAPABILITY_SCOPE_SESSION | CAPABILITY_SCOPE_WORKSPACE
    ) {
        let locator = locator
            .as_ref()
            .ok_or_else(|| denied_with_context("missing session context", base_context.clone()))?;
        session_context = Some(
            resolve_active_session(db, bot_id, provider_account_id, locator.clone())
                .await
                .map_err(|err| match err {
                    CapabilityError::Denied(msg) => denied_with_context(msg, base_context.clone()),
                    other => other,
                })?,
        );
    }

    verify_scope_with_context(
        delegation,
        frame_type,
        action,
        frame,
        resource,
        request_id,
        session_context.as_ref(),
        locator.as_ref(),
    )
}

fn verify_signature(
    delegation: &DelegationRecord,
    frame_type: &str,
    envelope: &CapabilityEnvelope,
    frame: &Value,
) -> Result<(), CapabilityError> {
    let alg = delegation.algorithm.to_lowercase();
    if alg != CAPABILITY_SUPPORTED_ALGORITHM {
        return Err(CapabilityError::Denied(format!(
            "unsupported delegation algorithm: {}",
            delegation.algorithm
        )));
    }

    let public_key_bytes = decode_b64(&delegation.public_key)?;
    let mut public_key_bytes_arr: [u8; 32] = [0u8; 32];
    public_key_bytes_arr.copy_from_slice(&public_key_bytes);
    let public_key = PublicKey::from_bytes(&public_key_bytes_arr)
        .map_err(|_| CapabilityError::InvalidSignature("invalid delegation public key".into()))?;

    let signature_bytes = decode_b64(&envelope.signature)?;
    if signature_bytes.len() != 64 {
        return Err(CapabilityError::InvalidSignature(
            "ed25519 signature must be 64 bytes".into(),
        ));
    }
    let mut signature_arr: [u8; 64] = [0u8; 64];
    signature_arr.copy_from_slice(&signature_bytes);
    let signature = Signature::from_bytes(&signature_arr)
        .map_err(|_| CapabilityError::InvalidSignature("invalid signature".into()))?;

    let message = signing_payload(frame_type, envelope, frame);
    public_key
        .verify(message.as_bytes(), &signature)
        .map_err(|_| CapabilityError::InvalidSignature("invalid signature".into()))
}

async fn load_delegation(
    db: &PgPool,
    bot_id: &Uuid,
    delegation_id: &str,
) -> Result<DelegationRecord, CapabilityError> {
    let row = sqlx::query(
        "SELECT delegation_id, bot_id, scope_type, scope_id, session_id, allowed_actions, allowed_resources,
                max_uses, use_count, expires_at, public_key, algorithm, delegated_to, status, revoked
         FROM acp_capability_delegations
         WHERE bot_id = $1 AND delegation_id = $2",
    )
    .bind(bot_id.to_string())
    .bind(delegation_id)
    .fetch_optional(db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, ctx = "load_delegation: select delegation", "acp_capability db error");
        CapabilityError::Denied("db error".into())
    })?
    .ok_or_else(|| CapabilityError::Denied("delegation not found".into()))?;

    Ok(DelegationRecord {
        delegation_id: row
            .try_get("delegation_id")
            .map_err(|_| CapabilityError::Denied("invalid delegation".into()))?,
        bot_id: row
            .try_get("bot_id")
            .map_err(|_| CapabilityError::Denied("invalid delegation".into()))?,
        scope_type: row
            .try_get("scope_type")
            .unwrap_or_else(|_| "global".to_string()),
        scope_id: row.try_get("scope_id").ok(),
        session_id: row.try_get("session_id").ok(),
        allowed_actions: row.try_get("allowed_actions").unwrap_or_default(),
        allowed_resources: row.try_get("allowed_resources").unwrap_or_default(),
        max_uses: row
            .try_get::<Option<i32>, _>("max_uses")
            .ok()
            .flatten()
            .map(|value| value as i64),
        use_count: row
            .try_get::<i32, _>("use_count")
            .map_err(|_| CapabilityError::Denied("invalid delegation".into()))?
            as i64,
        expires_at: row
            .try_get::<Option<DateTime<Utc>>, _>("expires_at")
            .map_err(|_| CapabilityError::Denied("invalid delegation".into()))?,
        public_key: row.try_get("public_key").unwrap_or_default(),
        algorithm: row
            .try_get("algorithm")
            .unwrap_or_else(|_| CAPABILITY_SUPPORTED_ALGORITHM.to_string()),
        delegated_to: row.try_get("delegated_to").ok(),
        status: row
            .try_get("status")
            .unwrap_or_else(|_| "active".to_string()),
        revoked: row.try_get("revoked").unwrap_or(false),
    })
}

async fn ensure_delegation_active(delegation: &DelegationRecord) -> Result<(), CapabilityError> {
    if delegation.revoked || delegation.status != "active" {
        return Err(CapabilityError::Denied("delegation is revoked".into()));
    }
    if let Some(expires_at) = delegation.expires_at {
        if expires_at < Utc::now() {
            return Err(CapabilityError::Denied("delegation expired".into()));
        }
    }

    if let (Some(max), use_count) = (delegation.max_uses, delegation.use_count) {
        if use_count >= max {
            return Err(CapabilityError::Denied("delegation uses exhausted".into()));
        }
    }
    Ok(())
}

async fn consume_nonce_and_bump(
    db: &PgPool,
    delegation_id: &Uuid,
    envelope: &CapabilityEnvelope,
    frame_type: &str,
    resource: Option<&str>,
) -> Result<(), CapabilityError> {
    let inserted = sqlx::query(
        "INSERT INTO acp_capability_nonce_log
            (delegation_id, nonce, request_id, frame_type, frame_resource, used_at, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT DO NOTHING",
    )
    .bind(delegation_id.to_string())
    .bind(&envelope.nonce)
    .bind(&envelope.request_id)
    .bind(frame_type)
    .bind(resource)
    .execute(db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, ctx = "consume_nonce_and_bump: insert nonce log", "acp_capability db error");
        CapabilityError::Denied("db error".into())
    })?
    .rows_affected();
    if inserted == 0 {
        return Err(CapabilityError::Denied("nonce replay detected".into()));
    }

    let updated = sqlx::query_scalar::<_, i64>(
        "UPDATE acp_capability_delegations
         SET use_count = use_count + 1, updated_at = NOW()
         WHERE delegation_id = $1
           AND (max_uses IS NULL OR use_count < max_uses)
         RETURNING use_count",
    )
    .bind(delegation_id.to_string())
    .fetch_optional(db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, ctx = "consume_nonce_and_bump: bump use_count", "acp_capability db error");
        CapabilityError::Denied("db error".into())
    })?
    .ok_or_else(|| CapabilityError::Denied("delegation exhausted".into()))?;

    let _updated = updated;
    Ok(())
}

pub async fn log_capability_reject(
    db: &PgPool,
    bot_id: &Uuid,
    provider_account_id: &str,
    frame_type: &str,
    reason: &str,
    action: Option<&str>,
    resource: Option<&str>,
    context: Option<&CapabilityDecisionContext>,
) -> sqlx::Result<()> {
    let delegation_id = context.and_then(|ctx| Some(ctx.delegation_id.as_str()));
    let decision_scope_type = context.and_then(|ctx| Some(ctx.delegation_scope_type.as_str()));
    let decision_scope_id = context.and_then(|ctx| ctx.delegation_scope_id.as_deref());
    let request_id = context.and_then(|ctx| ctx.request_id.as_deref());
    let action = action.or_else(|| context.map(|ctx| ctx.action.as_str()));
    let resource = resource.or_else(|| context.and_then(|ctx| ctx.resource.as_deref()));
    let request_session_id = context.and_then(|ctx| ctx.request_session_id.as_deref());
    let resolved_session_id = context.and_then(|ctx| ctx.resolved_session_id.as_deref());
    let resolved_session_status = context.and_then(|ctx| ctx.resolved_session_status.as_deref());
    let resolved_session_scope_type =
        context.and_then(|ctx| ctx.resolved_session_scope_type.as_deref());
    let resolved_session_scope_id =
        context.and_then(|ctx| ctx.resolved_session_scope_id.as_deref());
    let session_locator_source = context.and_then(|ctx| ctx.session_locator_source.as_deref());
    let session_locator_value = context.and_then(|ctx| ctx.session_locator_value.as_deref());

    sqlx::query(
        "INSERT INTO acp_capability_reject_logs (
            bot_id, provider_account_id, delegation_id, decision_scope_type, decision_scope_id,
            frame_type, action, request_id, request_session_id, resolved_session_id, resolved_session_status,
            resolved_session_scope_type, resolved_session_scope_id, session_locator_source, session_locator_value,
            resource, decision_reason
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
    )
    .bind(bot_id.to_string())
    .bind(provider_account_id)
    .bind(delegation_id)
    .bind(decision_scope_type)
    .bind(decision_scope_id)
    .bind(frame_type)
    .bind(action)
    .bind(request_id)
    .bind(request_session_id)
    .bind(resolved_session_id)
    .bind(resolved_session_status)
    .bind(resolved_session_scope_type)
    .bind(resolved_session_scope_id)
    .bind(session_locator_source)
    .bind(session_locator_value)
    .bind(resource)
    .bind(reason)
    .execute(db)
    .await
    .map(|_| ())
}

pub async fn authorize_data_frame(
    db: &PgPool,
    bot_id: &Uuid,
    provider_account_id: &str,
    frame: &Value,
) -> Result<(), CapabilityError> {
    let frame_type = extract_frame_type(frame);
    if !frame_needs_capability(frame_type) {
        return Ok(());
    }

    let envelope = parse_envelope(frame)?;
    let action = frame_action(frame_type)
        .ok_or_else(|| CapabilityError::Denied("unsupported frame type".into()))?;
    let request_id = envelope.request_id.as_deref();

    if (now_epoch() - envelope.ts_secs).abs() > CAPABILITY_CLOCK_TOLERANCE_SECS {
        return Err(CapabilityError::Denied(
            "timestamp too far from wall clock".into(),
        ));
    }

    let delegation_id = Uuid::parse_str(&envelope.delegation_id)
        .map_err(|_| CapabilityError::Denied("invalid delegation id".into()))?;
    let delegation = load_delegation(db, bot_id, &delegation_id.to_string()).await?;
    let resource = extract_resource(frame);

    validate_public_key(&delegation.algorithm, &delegation.public_key)?;
    verify_signature(&delegation, frame_type, &envelope, frame)?;
    verify_scope(
        db,
        bot_id,
        provider_account_id,
        &delegation,
        frame,
        action,
        resource.as_deref(),
        request_id,
    )
    .await?;

    ensure_delegation_active(&delegation).await?;

    if !action_allowed(&delegation.allowed_actions, action) {
        return Err(CapabilityError::Denied(format!(
            "action not allowed: {action}"
        )));
    }

    if action == "resource_req" {
        let resource = resource
            .clone()
            .ok_or_else(|| CapabilityError::Denied("missing resource".into()))?;
        if !resource_allowed(&delegation.allowed_resources, &resource) {
            return Err(CapabilityError::Denied("resource not allowed".into()));
        }
    }

    consume_nonce_and_bump(
        db,
        &delegation_id,
        &envelope,
        frame_type,
        resource.as_deref(),
    )
    .await?;
    Ok(())
}

pub fn to_public_json() -> Value {
    json!({
        "scope_types": ["global", "workspace", "channel", "session", "user"],
        "algorithms": [CAPABILITY_SUPPORTED_ALGORITHM],
    })
}

pub fn build_action_map() -> BTreeMap<&'static str, Vec<&'static str>> {
    BTreeMap::from([
        ("send", vec!["send"]),
        ("stream", vec!["delta", "done"]),
        ("resource_req", vec!["resource_req"]),
        ("session_update", vec!["session_update"]),
        ("permission_request", vec!["permission_request"]),
        ("trace", vec!["trace"]),
    ])
}

pub fn map_app_error(err: CapabilityError) -> AppError {
    match err {
        CapabilityError::InvalidSignature(message) => AppError::Unauthorized(message),
        CapabilityError::Denied(message) => AppError::Forbidden(message),
        CapabilityError::DeniedWithContext { message, .. } => AppError::Forbidden(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_delegation(
        scope_type: &str,
        scope_id: Option<&str>,
        session_id: Option<&str>,
        delegated_to: Option<&str>,
        allowed_resources: Vec<&str>,
    ) -> DelegationRecord {
        DelegationRecord {
            delegation_id: Uuid::new_v4(),
            bot_id: Uuid::new_v4(),
            scope_type: scope_type.to_string(),
            scope_id: scope_id.map(str::to_string),
            session_id: session_id.map(str::to_string),
            allowed_actions: vec![
                "send".to_string(),
                "stream".to_string(),
                "resource_req".to_string(),
            ],
            allowed_resources: allowed_resources.into_iter().map(str::to_string).collect(),
            max_uses: None,
            use_count: 0,
            expires_at: None,
            public_key: "test".into(),
            algorithm: CAPABILITY_SUPPORTED_ALGORITHM.to_string(),
            delegated_to: delegated_to.map(str::to_string),
            status: "active".into(),
            revoked: false,
        }
    }

    fn make_session_context(
        session_id: &str,
        status: &str,
        scope_type: Option<&str>,
        scope_id: Option<&str>,
    ) -> SessionContext {
        SessionContext {
            session_id: Uuid::parse_str(session_id).unwrap(),
            status: status.to_string(),
            current_scope_type: scope_type.map(str::to_string),
            current_scope_id: scope_id.map(str::to_string),
            provider_session_key: Some("provider-session-key".into()),
        }
    }

    struct VerifyScopeCase {
        name: &'static str,
        delegation: DelegationRecord,
        frame_type: &'static str,
        action: &'static str,
        frame: Value,
        resource: Option<&'static str>,
        locator: Option<SessionLocator>,
        session_context: Option<SessionContext>,
        expected_err: Option<&'static str>,
    }

    #[test]
    fn test_verify_scope_table_driven() {
        let ws = Uuid::new_v4().to_string();
        let ch = Uuid::new_v4().to_string();
        let sid = Uuid::new_v4().to_string();
        let sid2 = Uuid::new_v4().to_string();

        let cases = vec![
            VerifyScopeCase {
                name: "global scope passes",
                delegation: make_delegation(CAPABILITY_SCOPE_GLOBAL, None, None, None, vec![]),
                frame_type: "send",
                action: "send",
                frame: json!({"channel_id":"any"}),
                resource: None,
                locator: None,
                session_context: None,
                expected_err: None,
            },
            VerifyScopeCase {
                name: "channel scope passes",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_CHANNEL,
                    Some("c-1"),
                    None,
                    None,
                    vec![],
                ),
                frame_type: "send",
                action: "send",
                frame: json!({"channel_id":"c-1"}),
                resource: None,
                locator: None,
                session_context: None,
                expected_err: None,
            },
            VerifyScopeCase {
                name: "channel scope mismatch",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_CHANNEL,
                    Some("c-1"),
                    None,
                    None,
                    vec![],
                ),
                frame_type: "send",
                action: "send",
                frame: json!({"channel_id":"c-2"}),
                resource: None,
                locator: None,
                session_context: None,
                expected_err: Some("channel scope mismatch"),
            },
            VerifyScopeCase {
                name: "session scope passes",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_SESSION,
                    None,
                    Some(&sid),
                    None,
                    vec![],
                ),
                frame_type: "send",
                action: "send",
                frame: json!({"provider_session_key":"k-1"}),
                resource: None,
                locator: Some(SessionLocator::ProviderSessionKey("k-1".to_string())),
                session_context: Some(make_session_context(
                    &sid,
                    sessions::SESSION_STATUS_ACTIVE,
                    Some("channel"),
                    Some(&ch),
                )),
                expected_err: None,
            },
            VerifyScopeCase {
                name: "session scope mismatch",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_SESSION,
                    None,
                    Some(&sid),
                    None,
                    vec![],
                ),
                frame_type: "send",
                action: "send",
                frame: json!({"provider_session_key":"k-1"}),
                resource: None,
                locator: Some(SessionLocator::ProviderSessionKey("k-1".to_string())),
                session_context: Some(make_session_context(
                    &sid2,
                    sessions::SESSION_STATUS_ACTIVE,
                    Some("channel"),
                    Some(&ch),
                )),
                expected_err: Some("session scope mismatch"),
            },
            VerifyScopeCase {
                name: "session scope missing context",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_SESSION,
                    None,
                    Some(&sid),
                    None,
                    vec![],
                ),
                frame_type: "send",
                action: "send",
                frame: json!({"provider_session_key":"k-1"}),
                resource: None,
                locator: Some(SessionLocator::ProviderSessionKey("k-1".to_string())),
                session_context: None,
                expected_err: Some("session context is required"),
            },
            VerifyScopeCase {
                name: "workspace scope passes",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_WORKSPACE,
                    Some("ws-1"),
                    None,
                    None,
                    vec![],
                ),
                frame_type: "send",
                action: "send",
                frame: json!({"provider_session_key":"k-1"}),
                resource: None,
                locator: Some(SessionLocator::ProviderSessionKey("k-1".to_string())),
                session_context: Some(make_session_context(
                    &ws,
                    sessions::SESSION_STATUS_BUSY,
                    Some("workspace"),
                    Some("ws-1"),
                )),
                expected_err: None,
            },
            VerifyScopeCase {
                name: "workspace scope mismatch",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_WORKSPACE,
                    Some("ws-1"),
                    None,
                    None,
                    vec![],
                ),
                frame_type: "send",
                action: "send",
                frame: json!({"provider_session_key":"k-1"}),
                resource: None,
                locator: Some(SessionLocator::ProviderSessionKey("k-1".to_string())),
                session_context: Some(make_session_context(
                    &ws,
                    sessions::SESSION_STATUS_BUSY,
                    Some("workspace"),
                    Some("ws-2"),
                )),
                expected_err: Some("workspace scope mismatch"),
            },
            VerifyScopeCase {
                name: "user scope denied without target",
                delegation: make_delegation(CAPABILITY_SCOPE_USER, None, None, None, vec![]),
                frame_type: "resource_req",
                action: "resource_req",
                frame: json!({"resource":"channel.files.list"}),
                resource: Some("channel.files.list"),
                locator: None,
                session_context: None,
                expected_err: Some("user-scoped delegation has no target"),
            },
            VerifyScopeCase {
                name: "user scope resource denied",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_USER,
                    None,
                    None,
                    Some("user-b"),
                    vec!["channel.files.read:*"],
                ),
                frame_type: "resource_req",
                action: "resource_req",
                frame: json!({"resource":"channel.files.write"}),
                resource: Some("channel.files.write"),
                locator: None,
                session_context: None,
                expected_err: Some("resource denied by user-scoped delegation"),
            },
            VerifyScopeCase {
                name: "user scope resource allowed",
                delegation: make_delegation(
                    CAPABILITY_SCOPE_USER,
                    None,
                    None,
                    Some("user-b"),
                    vec!["channel.files.*"],
                ),
                frame_type: "resource_req",
                action: "resource_req",
                frame: json!({"resource":"channel.files.write"}),
                resource: Some("channel.files.write"),
                locator: None,
                session_context: None,
                expected_err: None,
            },
        ];

        for case in cases {
            let result = verify_scope_with_context(
                &case.delegation,
                case.frame_type,
                case.action,
                &case.frame,
                case.resource,
                None,
                case.session_context.as_ref(),
                case.locator.as_ref(),
            );
            if let Some(expected_err) = case.expected_err {
                let err = result.unwrap_err();
                assert!(
                    err.to_string().contains(expected_err),
                    "{name}: expect '{expected_err}', got '{err}'",
                    name = case.name
                );
            } else {
                if let Err(err) = result {
                    panic!("{name}: expected ok, got '{err}'", name = case.name);
                }
            }
        }
    }
}
