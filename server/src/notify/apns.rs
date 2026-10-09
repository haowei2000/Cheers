//! APNs HTTP/2 transport with ES256 provider tokens (Apple "token-based
//! connection"). Configured entirely from env (see [`ApnsClient::from_env`]);
//! when unconfigured the gateway runs with push disabled — in-app WS delivery
//! is unaffected.
//!
//! Follows Apple's provider guidance
//! ([Communicating with APNs](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html),
//! [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)):
//! - HTTP/2 + TLS 1.2+
//! - reuse long-lived connections (do not open/close per push)
//! - HTTP/2 PING on idle connections
//! - reuse the provider JWT for up to one hour
//! - on GOAWAY / broken connection: open a fresh connection and retry once

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::Value;

/// Provider JWTs are valid ~1 hour; re-mint before expiry (Apple: reuse, don't
/// mint per push).
const TOKEN_TTL: Duration = Duration::from_secs(40 * 60);
/// One reconnect covers GOAWAY / BrokenPipe / DispatchGone on a reused stream.
const SEND_ATTEMPTS: u8 = 2;
/// Apple allows PING after ~1h idle; we ping sooner so NAT/middleboxes don't
/// silently drop the reused HTTP/2 connection before the next push.
const HTTP2_PING_INTERVAL: Duration = Duration::from_secs(60);
const HTTP2_PING_TIMEOUT: Duration = Duration::from_secs(15);
/// Keep idle pooled connections for hours (Apple: reuse for hours–days).
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

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
    /// Minted provider token, TTL-checked on read. Both lock sites recover from
    /// poisoning (`PoisonError::into_inner`): `.unwrap()` here turned a panic
    /// elsewhere into a poisoned-lock panic on every later push, and an
    /// `Option` assignment cannot be left structurally invalid by a panic.
    /// Worst case after recovery is a stale token, which the TTL check rejects.
    cached: Mutex<Option<(Instant, String)>>,
}

fn build_http_client() -> reqwest::Client {
    // Long-lived HTTP/2 pool + PING (Apple: reuse connections; ping when idle).
    // Do NOT disable the pool — rapid connect/disconnect is treated as DoS.
    reqwest::Client::builder()
        .http2_adaptive_window(true)
        .http2_keep_alive_interval(HTTP2_PING_INTERVAL)
        .http2_keep_alive_timeout(HTTP2_PING_TIMEOUT)
        .http2_keep_alive_while_idle(true)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        .pool_max_idle_per_host(4)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn is_reconnectable_transport(msg: &str) -> bool {
    // hyper surfaces GOAWAY / reset / dropped dispatch as these strings.
    let lower = msg.to_ascii_lowercase();
    lower.contains("brokenpipe")
        || lower.contains("dispatchgone")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("goaway")
        || lower.contains("stream closed")
}

type ProviderCredentials = (String, String, String);

fn complete_credentials(
    private_key: Option<String>,
    key_id: Option<String>,
    team_id: Option<String>,
) -> Result<Option<ProviderCredentials>, ()> {
    match (private_key, key_id, team_id) {
        (None, None, None) => Ok(None),
        (Some(private_key), Some(key_id), Some(team_id)) => {
            Ok(Some((private_key, key_id, team_id)))
        }
        _ => Err(()),
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

impl ApnsClient {
    /// Build from env. An explicit APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID
    /// tuple takes precedence. When that tuple is absent, the official service
    /// may reuse the complete APPLE_PRIVATE_KEY_P8 / APPLE_KEY_ID /
    /// APPLE_TEAM_ID tuple when the Apple key is authorized for both Sign in
    /// with Apple and APNs. Partial tuples fail closed instead of mixing keys.
    /// APNS_KEY_P8 may be the PEM content itself or a path to the .p8 file.
    /// APNS_TOPIC defaults to the iOS bundle id; APNS_SANDBOX=true targets the
    /// development environment.
    pub fn from_env() -> Option<Self> {
        let credentials = match complete_credentials(
            env_value("APNS_KEY_P8"),
            env_value("APNS_KEY_ID"),
            env_value("APNS_TEAM_ID"),
        ) {
            Ok(Some(credentials)) => credentials,
            Ok(None) => match complete_credentials(
                env_value("APPLE_PRIVATE_KEY_P8"),
                env_value("APPLE_KEY_ID"),
                env_value("APPLE_TEAM_ID"),
            ) {
                Ok(Some(credentials)) => {
                    tracing::info!("APNS_* not set; reusing the APPLE_* key authorized for APNs");
                    credentials
                }
                Ok(None) => return None,
                Err(()) => {
                    tracing::error!("incomplete APPLE_* key tuple — push disabled");
                    return None;
                }
            },
            Err(()) => {
                tracing::error!("incomplete APNS_* key tuple — push disabled");
                return None;
            }
        };
        let (raw_key, key_id, team_id) = credentials;

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
            http: build_http_client(),
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
            let cached = self
                .cached
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let mut cached = self
            .cached
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *cached = Some((Instant::now(), token.clone()));
        Ok(token)
    }

    /// Deliver one payload to one device token.
    pub async fn send(
        &self,
        device_token: &str,
        payload: &Value,
        collapse_id: &str,
    ) -> Result<(), ApnsError> {
        let mut last_transport = None;
        for attempt in 1..=SEND_ATTEMPTS {
            match self.send_once(device_token, payload, collapse_id).await {
                Ok(()) => return Ok(()),
                Err(ApnsError::Transport(msg))
                    if attempt < SEND_ATTEMPTS && is_reconnectable_transport(&msg) =>
                {
                    // Apple: on GOAWAY / dropped connection, open a new one.
                    // hyper drops the failed pooled connection; the retry opens fresh.
                    tracing::warn!(
                        attempt,
                        error = %msg,
                        "apns connection dropped; reconnecting and retrying once"
                    );
                    last_transport = Some(msg);
                }
                Err(err) => return Err(err),
            }
        }
        Err(ApnsError::Transport(last_transport.unwrap_or_else(|| {
            "exhausted APNs reconnect retries".into()
        })))
    }

    async fn send_once(
        &self,
        device_token: &str,
        payload: &Value,
        collapse_id: &str,
    ) -> Result<(), ApnsError> {
        let bearer = self.provider_token()?;
        let url = format!("{}/3/device/{}", self.endpoint, device_token);
        let mut req = self
            .http
            .post(&url)
            .header("authorization", format!("bearer {bearer}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .json(payload);
        // Empty collapse ids are invalid; skip rather than send a bad header.
        if !collapse_id.is_empty() {
            req = req.header("apns-collapse-id", collapse_id);
        }
        let response = req.send().await.map_err(|e| {
            // Debug formatting keeps the nested hyper/rustls cause — Display
            // alone drops it, which is what we need for BrokenPipe diagnosis.
            ApnsError::Transport(format!("{e:?}"))
        })?;

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

#[cfg(test)]
mod tests {
    use super::{complete_credentials, is_reconnectable_transport};

    #[test]
    fn credential_tuple_requires_all_fields() {
        assert!(complete_credentials(None, None, None).unwrap().is_none());
        assert!(complete_credentials(Some("key".into()), None, Some("team".into())).is_err());

        let credentials = complete_credentials(
            Some("key".into()),
            Some("key-id".into()),
            Some("team-id".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            credentials,
            ("key".into(), "key-id".into(), "team-id".into())
        );
    }

    #[test]
    fn reconnectable_transport_matches_observed_failures() {
        assert!(is_reconnectable_transport(
            "stream closed because of a broken pipe"
        ));
        assert!(is_reconnectable_transport(
            "runtime dropped the dispatch task DispatchGone"
        ));
        assert!(is_reconnectable_transport("http2 GOAWAY received"));
        assert!(!is_reconnectable_transport("apns rejected: 403 Forbidden"));
    }
}
