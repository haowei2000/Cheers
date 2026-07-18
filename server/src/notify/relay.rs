//! Relay transport: a self-hosted gateway can't obtain APNs credentials for the
//! store app's bundle id, so it POSTs pushes to an official Cheers relay that
//! holds the key. This client DEFINES the relay's API contract:
//!
//!   POST {PUSH_RELAY_URL}/v1/push
//!   Authorization: Bearer {PUSH_RELAY_KEY}        (optional shared key)
//!   { "device_token": "...", "collapse_id": "...", "payload": { aps..., cheers... } }
//!
//!   200 → delivered; 410 or {"reason":"Unregistered"} → token dead (prune);
//!   anything else → transient failure (logged).
//!
//! The relay service itself is a separate deployable (not in this repo yet).

use serde_json::{json, Value};

use super::apns::ApnsError;

pub struct RelayClient {
    http: reqwest::Client,
    url: String,
    key: Option<String>,
}

impl RelayClient {
    /// Enabled when PUSH_RELAY_URL is set; PUSH_RELAY_KEY optionally
    /// authenticates this gateway to the relay.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("PUSH_RELAY_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())?;
        Some(Self {
            http: reqwest::Client::new(),
            url: url.trim_end_matches('/').to_string(),
            key: std::env::var("PUSH_RELAY_KEY")
                .ok()
                .filter(|v| !v.trim().is_empty()),
        })
    }

    pub async fn send(
        &self,
        device_token: &str,
        payload: &Value,
        collapse_id: &str,
    ) -> Result<(), ApnsError> {
        let mut request = self.http.post(format!("{}/v1/push", self.url)).json(&json!({
            "device_token": device_token,
            "collapse_id": collapse_id,
            "payload": payload,
        }));
        if let Some(key) = &self.key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| ApnsError::Transport(e.to_string()))?;

        let status = response.status().as_u16();
        if status == 200 {
            return Ok(());
        }
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let reason = body
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        if status == 410 || reason == "Unregistered" {
            return Err(ApnsError::TokenDead);
        }
        Err(ApnsError::Rejected { status, reason })
    }
}
