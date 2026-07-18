//! Web Push subscription registry (PWA notifications).
//!
//! The browser calls `PushManager.subscribe` with the VAPID public key from
//! GET /push/vapid-public-key, then registers the resulting endpoint + client
//! keys here. One row per endpoint (the push service mints a unique URL per
//! subscription); re-subscribing upserts, logout deletes. Delivery lives in
//! [`crate::infra::web_push`] — this module is only the registry.

use axum::{extract::State, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    api::middleware::Claims, app_state::AppState, errors::AppError,
    infra::web_push::decode_subscription_keys,
};

/// Push endpoints are push-service URLs (FCM/Mozilla/WebKit …); anything
/// longer than this is garbage, not a subscription.
const MAX_ENDPOINT_LEN: usize = 2048;

/// GET /api/v1/push/vapid-public-key — the `applicationServerKey` for
/// `PushManager.subscribe`. `key: null` ⇒ push is disabled on this deployment
/// (the client hides its subscribe UI).
pub async fn vapid_public_key(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "key": state.web_push.as_ref().map(|s| s.public_key_b64()),
    }))
}

#[derive(Deserialize)]
pub struct SubscriptionBody {
    pub endpoint: String,
    /// Client public key (`getKey("p256dh")`), unpadded base64url.
    pub p256dh: String,
    /// Client auth secret (`getKey("auth")`), unpadded base64url.
    pub auth: String,
    #[serde(default)]
    pub user_agent: Option<String>,
}

/// POST /api/v1/push/subscriptions — register (or re-register) the caller's
/// browser push subscription. Upsert by endpoint: a browser that re-subscribes
/// after a permission reset gets fresh keys for the same endpoint, and an
/// endpoint recycled to a different signed-in user follows that user.
pub async fn subscribe(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<SubscriptionBody>,
) -> Result<Json<Value>, AppError> {
    if state.web_push.is_none() {
        return Err(AppError::BadRequest(
            "web push is not configured on this server".into(),
        ));
    }
    if body.endpoint.len() > MAX_ENDPOINT_LEN || !body.endpoint.starts_with("https://") {
        return Err(AppError::BadRequest(
            "endpoint must be an https push-service URL".into(),
        ));
    }
    // Reject undecodable keys at write time — a row the sender can never
    // encrypt for is pure noise.
    decode_subscription_keys(&body.p256dh, &body.auth)
        .map_err(|e| AppError::BadRequest(e.into()))?;

    // Cap the free-text UA on a char boundary (diagnostic only, no need for 4KB).
    let user_agent = body.user_agent.as_deref().map(|ua| {
        let mut end = ua.len().min(512);
        while !ua.is_char_boundary(end) {
            end -= 1;
        }
        &ua[..end]
    });

    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                p256dh  = EXCLUDED.p256dh,
                auth    = EXCLUDED.auth,
                user_agent = EXCLUDED.user_agent",
    )
    .bind(&body.endpoint)
    .bind(&claims.sub)
    .bind(&body.p256dh)
    .bind(&body.auth)
    .bind(user_agent)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UnsubscribeBody {
    pub endpoint: String,
}

/// DELETE /api/v1/push/subscriptions — drop one subscription (logout / toggle
/// off). Scoped to the caller's own rows.
pub async fn unsubscribe(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(body): Json<UnsubscribeBody>,
) -> Result<Json<Value>, AppError> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2")
        .bind(&body.endpoint)
        .bind(&claims.sub)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
