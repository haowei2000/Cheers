//! APNs HTTP/2 transport with ES256 provider tokens (Apple "token-based
//! connection"). Configured entirely from env (see [`ApnsClient::from_env`]);
//! when unconfigured the gateway runs with push disabled — in-app WS delivery
//! is unaffected.
//!
//! Provider JWTs are valid 20–60 minutes; we cache one and re-mint after 40.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::Value;

const TOKEN_TTL: Duration = Duration::from_secs(40 * 60);

#[derive(Debug, thiserror::Error)]
pub enum ApnsError {
    /// Apple says this device token is gone ("Unregistered"/"BadDeviceToken") —
    /// the caller should prune it.
    #[error("device token dead")]
    TokenDead,
    #[error("apns transport: {0}")]
    Transport(String),
    #[error("apns rejected: {status} {reason}")]
    Rejected { status: u16, reason: String },
}

pub struct ApnsClient {
    http: reqwest::Client,
    key: EncodingKey,
    key_id: String,
    team_id: String,
    /// APNs topic = the app's bundle id.
    topic: String,
    endpoint: String,
    cached: Mutex<Option<(Instant, String)>>,
}

impl ApnsClient {
    /// Build from env; returns None (push disabled) unless all of
    /// APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID are set. APNS_KEY_P8 may be the
    /// PEM content itself or a path to the .p8 file. APNS_TOPIC defaults to the
    /// iOS bundle id; APNS_SANDBOX=true targets the development environment.
    pub fn from_env() -> Option<Self> {
        let raw_key = std::env::var("APNS_KEY_P8").ok().filter(|v| !v.trim().is_empty())?;
        let key_id = std::env::var("APNS_KEY_ID").ok().filter(|v| !v.trim().is_empty())?;
        let team_id = std::env::var("APNS_TEAM_ID").ok().filter(|v| !v.trim().is_empty())?;

        let pem = if raw_key.contains("BEGIN PRIVATE KEY") {
            raw_key
        } else {
            std::fs::read_to_string(raw_key.trim()).ok()?
        };
        let key = match EncodingKey::from_ec_pem(pem.as_bytes()) {
            Ok(k) => k,
            Err(err) => {
                tracing::error!(error = %err, "APNS_KEY_P8 is not a valid EC (.p8) key — push disabled");
                return None;
            }
        };

        let sandbox = std::env::var("APNS_SANDBOX")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let endpoint = if sandbox {
            "https://api.sandbox.push.apple.com".to_string()
        } else {
            "https://api.push.apple.com".to_string()
        };

        Some(Self {
            http: reqwest::Client::new(),
            key,
            key_id,
            team_id,
            topic: std::env::var("APNS_TOPIC")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "app.cheers.ios".into()),
            endpoint,
            cached: Mutex::new(None),
        })
    }

    fn provider_token(&self) -> Result<String, ApnsError> {
        {
            let cached = self.cached.lock().unwrap();
            if let Some((minted, token)) = cached.as_ref() {
                if minted.elapsed() < TOKEN_TTL {
                    return Ok(token.clone());
                }
            }
        }
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        let iat = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let claims = serde_json::json!({ "iss": self.team_id, "iat": iat });
        let token = jsonwebtoken::encode(&header, &claims, &self.key)
            .map_err(|e| ApnsError::Transport(format!("sign provider token: {e}")))?;
        *self.cached.lock().unwrap() = Some((Instant::now(), token.clone()));
        Ok(token)
    }

    /// Deliver one payload to one device token.
    pub async fn send(&self, device_token: &str, payload: &Value, collapse_id: &str) -> Result<(), ApnsError> {
        let bearer = self.provider_token()?;
        let url = format!("{}/3/device/{}", self.endpoint, device_token);
        let response = self
            .http
            .post(&url)
            .header("authorization", format!("bearer {bearer}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-collapse-id", collapse_id)
            .json(payload)
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
        if status == 410 || reason == "Unregistered" || reason == "BadDeviceToken" {
            return Err(ApnsError::TokenDead);
        }
        Err(ApnsError::Rejected { status, reason })
    }
}
