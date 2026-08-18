//! Generic inbound webhook receiver for service integrations.
//!
//! `POST /api/v1/integrations/:integration_id/:installation_id/events`
//!
//! Deliberately outside the browser JWT middleware, like the LiveKit webhook:
//! the provider authenticates with its own signature over the raw body.
//!
//! The order of operations is the security property. Look up the installation,
//! verify the signature over the **raw bytes**, and only then parse JSON. An
//! unauthenticated caller must never reach `serde_json`, and must never be able
//! to tell an unknown integration from a bad signature — both are the same
//! opaque rejection, so this endpoint cannot enumerate what is installed.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde_json::{json, Value};
use sqlx::Row;

use crate::{
    app_state::AppState,
    domain::integrations::{
        catalog::{self, EventField, IntegrationDescriptor},
        webhook::{self, SignatureScheme},
    },
    errors::AppError,
    infra::crypto,
};

/// One response for every rejection. See the module note: distinguishing them
/// would leak which integrations and installations exist.
fn rejected() -> AppError {
    AppError::Unauthorized("webhook rejected".into())
}

pub async fn receive(
    State(state): State<AppState>,
    Path((integration_id, installation_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AppError> {
    // Cap before anything else touches the bytes.
    if body.len() > webhook::MAX_BODY_BYTES {
        tracing::warn!(%integration_id, len = body.len(), "webhook body over cap");
        return Err(rejected());
    }

    let Some(descriptor) = catalog::find(&integration_id) else {
        tracing::warn!(%integration_id, "webhook for unknown integration");
        return Err(rejected());
    };

    let installation = load_installation(&state, &integration_id, &installation_id).await?;

    verify(&state, &descriptor, &installation, &headers, &body)?;

    // Only now is the body trusted enough to parse.
    let payload: Value = serde_json::from_slice(&body).map_err(|_| {
        tracing::warn!(%integration_id, "signed webhook carried invalid JSON");
        AppError::BadRequest("invalid webhook JSON".into())
    })?;

    let event_id = field(&descriptor.event_id, &headers, &payload)
        .ok_or_else(|| AppError::BadRequest("webhook is missing its event id".into()))?;
    let event_type = field(&descriptor.event_type, &headers, &payload)
        .ok_or_else(|| AppError::BadRequest("webhook is missing its event type".into()))?;

    let admitted = sqlx::query(
        "INSERT INTO integration_webhook_events
             (integration_id, installation_id, event_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (integration_id, installation_id, event_id) DO NOTHING",
    )
    .bind(&integration_id)
    .bind(&installation_id)
    .bind(&event_id)
    .bind(&event_type)
    .bind(&payload)
    .execute(&state.db)
    .await?
    .rows_affected()
        == 1;

    // A redelivery is a success, not an error: providers retry on non-2xx, and
    // answering 4xx to an event already handled causes an endless retry loop.
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "accepted": true, "duplicate": !admitted })),
    ))
}

struct Installation {
    webhook_secret_enc: Option<String>,
}

async fn load_installation(
    state: &AppState,
    integration_id: &str,
    installation_id: &str,
) -> Result<Installation, AppError> {
    let row = sqlx::query(
        "SELECT webhook_secret_enc
           FROM integration_installations
          WHERE installation_id = $1 AND integration_id = $2 AND disabled_at IS NULL",
    )
    .bind(installation_id)
    .bind(integration_id)
    .fetch_optional(&state.db)
    .await?;

    match row {
        Some(row) => Ok(Installation {
            webhook_secret_enc: row.try_get("webhook_secret_enc")?,
        }),
        None => {
            // Covers unknown, wrong-integration, and disabled alike.
            tracing::warn!(%integration_id, %installation_id, "webhook for unknown installation");
            Err(rejected())
        }
    }
}

fn verify(
    state: &AppState,
    descriptor: &IntegrationDescriptor,
    installation: &Installation,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), AppError> {
    let Some(blob) = installation.webhook_secret_enc.as_deref() else {
        tracing::warn!(
            integration = descriptor.id,
            "installation has no webhook secret"
        );
        return Err(rejected());
    };
    let key = crypto::derive_master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    );
    let secret = crypto::decrypt_secret(&key, blob).map_err(|error| {
        tracing::error!(integration = descriptor.id, %error, "webhook secret will not decrypt");
        rejected()
    })?;

    match &descriptor.signature {
        SignatureScheme::HmacSha256 { header, prefix } => webhook::verify_hmac_sha256(
            secret.as_bytes(),
            prefix.as_deref(),
            headers.get(header.as_str()).and_then(|v| v.to_str().ok()),
            body,
        )
        .map_err(|_| {
            tracing::warn!(integration = descriptor.id, "webhook signature rejected");
            rejected()
        }),
        // LiveKit's scheme needs its issuer and decoding key, which live in
        // voice config rather than an installation row. It stays on its own
        // route and shares only the verification primitives.
        SignatureScheme::JwtBodySha256 => Err(rejected()),
    }
}

fn field(source: &EventField, headers: &HeaderMap, payload: &Value) -> Option<String> {
    let raw = match source {
        EventField::Header(name) => headers.get(*name)?.to_str().ok()?.to_string(),
        EventField::BodyPointer(pointer) => payload.pointer(pointer)?.as_str()?.to_string(),
    };
    let trimmed = raw.trim();
    // Guard the column widths declared in 0085 rather than letting Postgres
    // reject the insert after the work of verification is already done.
    if trimmed.is_empty() || trimmed.len() > 128 {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::integrations::catalog;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        map
    }

    #[test]
    fn reads_github_event_metadata_from_its_headers() {
        let github = catalog::find("github").unwrap();
        let head = headers(&[
            ("X-GitHub-Delivery", "72d3162e-cc78-11e3-81ab-4c9367dc0958"),
            ("X-GitHub-Event", "push"),
        ]);
        assert_eq!(
            field(&github.event_id, &head, &Value::Null).as_deref(),
            Some("72d3162e-cc78-11e3-81ab-4c9367dc0958")
        );
        assert_eq!(
            field(&github.event_type, &head, &Value::Null).as_deref(),
            Some("push")
        );
    }

    #[test]
    fn reads_body_pointer_metadata() {
        let payload = json!({"id": "EV_1", "event": "room_started"});
        assert_eq!(
            field(&EventField::BodyPointer("/id"), &HeaderMap::new(), &payload).as_deref(),
            Some("EV_1")
        );
        assert_eq!(
            field(
                &EventField::BodyPointer("/event"),
                &HeaderMap::new(),
                &payload
            )
            .as_deref(),
            Some("room_started")
        );
    }

    #[test]
    fn missing_blank_and_oversized_metadata_is_absent_not_empty() {
        let head = headers(&[("X-GitHub-Event", "   ")]);
        assert_eq!(
            field(&EventField::Header("X-GitHub-Event"), &head, &Value::Null),
            None
        );
        assert_eq!(
            field(&EventField::Header("X-Absent"), &head, &Value::Null),
            None
        );

        let long = "e".repeat(129);
        let head = headers(&[("X-GitHub-Event", long.as_str())]);
        assert_eq!(
            field(&EventField::Header("X-GitHub-Event"), &head, &Value::Null),
            None,
            "must not attempt an insert that exceeds the declared column width"
        );
    }

    #[test]
    fn body_pointer_ignores_non_string_values() {
        // A provider sending {"id": 12} must not silently become "12" — the
        // dedupe key would then collide with the string "12" from elsewhere.
        let payload = json!({"id": 12});
        assert_eq!(
            field(&EventField::BodyPointer("/id"), &HeaderMap::new(), &payload),
            None
        );
    }

    #[test]
    fn every_rejection_renders_identically() {
        // Unknown integration, unknown installation, missing secret, and bad
        // signature must be indistinguishable to the caller.
        assert_eq!(rejected().to_string(), "unauthorized: webhook rejected");
    }
}
