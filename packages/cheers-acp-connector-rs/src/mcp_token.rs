//! Host-bound OAuth client for the canonical Cheers HTTP MCP endpoint.
//!
//! An ACP Agent can only reach the Cheers MCP endpoint while holding an OAuth
//! access token for it. Making the Agent obtain that token itself requires it to
//! be a full OAuth 2.1 client: the Gateway publishes no `registration_endpoint`,
//! so the Agent needs a public HTTPS Client ID Metadata Document plus an
//! interactive consent round-trip surfaced through ACP URL elicitation. Very few
//! Agents clear that bar, and the ones that do disagree on how they surface it.
//!
//! The Connector needs none of that. It *is* an enrolled connector host,
//! which is precisely the principal the Gateway's `client_credentials` grant
//! exists for (`MCP_HTTP_OAUTH_TOOL_SCOPE.md` §2): the host id is the
//! `client_id` and the host credential — already held to authenticate
//! the Bridge — is the `client_secret`. Minting here and injecting the result as
//! the `cheers` server's `Authorization` header reduces the Agent's requirement
//! to "speaks HTTP MCP with headers".
//!
//! This is not a static-bearer shortcut. Tokens are short-lived and re-minted on
//! demand, and the Gateway re-validates the host — status, revocation,
//! credential hash, bot enablement — on *every* MCP request, so a revoked or
//! rotated host stops working immediately regardless of token lifetime.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use serde::Deserialize;
use tokio::sync::Mutex;

/// Cap on any discovery or token response body. These documents are a few
/// hundred bytes; the cap bounds a hostile or misconfigured endpoint.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Re-mint once this fraction of the advertised lifetime has elapsed, so a long
/// prompt turn does not run into an expiry mid-flight.
const RENEW_AT_FRACTION: f64 = 0.8;
/// Floor on the renewal margin, and on how long a fresh token is trusted.
const MIN_RENEW_MARGIN: Duration = Duration::from_secs(30);
/// Assumed lifetime when the token endpoint omits `expires_in`.
const DEFAULT_TOKEN_LIFETIME: Duration = Duration::from_secs(300);
/// Slack kept between the last reuse and the stated expiry, so a token is never
/// presented at the instant it becomes invalid.
const EXPIRY_SLACK: Duration = Duration::from_secs(5);

/// RFC 9728 protected-resource metadata, trimmed to the fields we consume.
#[derive(Debug, Deserialize)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

/// RFC 8414 authorization-server metadata, trimmed to the fields we consume.
#[derive(Debug, Deserialize)]
struct AuthorizationServerMetadata {
    token_endpoint: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

/// What discovery resolved: where to mint, and what to ask for.
#[derive(Debug, Clone)]
struct Discovered {
    token_endpoint: String,
    /// Space-delimited scope request. Taken from the resource's advertised
    /// `scopes_supported` rather than a local constant, so the Connector cannot
    /// drift from the Gateway's frozen scope set.
    scope: String,
}

struct CachedToken {
    value: String,
    renew_after: Instant,
}

/// Redacted: a cached token is a live credential.
impl std::fmt::Debug for CachedToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedToken")
            .field("value", &"<redacted>")
            .field("renew_after", &self.renew_after)
            .finish()
    }
}

/// Mints and caches host-bound MCP access tokens.
pub(crate) struct McpTokenProvider {
    mcp_url: String,
    host_id: String,
    credential: String,
    http: reqwest::Client,
    /// Held across the mint await so concurrent `session/new` calls collapse
    /// into one token request rather than stampeding the token endpoint.
    cached: Mutex<Option<CachedToken>>,
    discovered: Mutex<Option<Discovered>>,
}

/// Redacted: this struct holds the host credential, which is the
/// `client_secret` for the whole host — never let it reach a log line.
impl std::fmt::Debug for McpTokenProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpTokenProvider")
            .field("mcp_url", &self.mcp_url)
            .field("host_id", &self.host_id)
            .field("credential", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl McpTokenProvider {
    /// Builds a provider for one account's host.
    pub(crate) fn new(
        mcp_url: String,
        host_id: String,
        credential: String,
    ) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("failed to build the MCP OAuth HTTP client")?;
        Ok(Self {
            mcp_url,
            host_id,
            credential,
            http,
            cached: Mutex::new(None),
            discovered: Mutex::new(None),
        })
    }

    /// Returns a currently-valid access token, minting one if needed.
    pub(crate) async fn bearer(&self) -> anyhow::Result<String> {
        let mut cached = self.cached.lock().await;
        if let Some(token) = cached.as_ref() {
            if Instant::now() < token.renew_after {
                return Ok(token.value.clone());
            }
        }
        let minted = self.mint().await?;
        let value = minted.value.clone();
        *cached = Some(minted);
        Ok(value)
    }

    /// Performs the `client_credentials` exchange against the discovered
    /// token endpoint.
    async fn mint(&self) -> anyhow::Result<CachedToken> {
        let discovered = self.discover().await?;
        let form: [(&str, &str); 5] = [
            ("grant_type", "client_credentials"),
            ("client_id", &self.host_id),
            ("client_secret", &self.credential),
            ("resource", &self.mcp_url),
            ("scope", &discovered.scope),
        ];
        let response = self
            .http
            .post(&discovered.token_endpoint)
            .form(&form)
            .send()
            .await
            .context("MCP token request failed")?;
        let status = response.status();
        let body = bounded_body(response).await?;
        if !status.is_success() {
            // The body is an RFC 6749 error object; surface its `error` code,
            // which distinguishes a revoked host (invalid_client) from a
            // misconfigured resource (invalid_target).
            let code = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "unknown_error".to_string());
            return Err(anyhow!(
                "MCP token endpoint returned HTTP {status} ({code})"
            ));
        }
        let token: TokenResponse =
            serde_json::from_slice(&body).context("MCP token response is not valid JSON")?;
        if token.access_token.trim().is_empty() {
            return Err(anyhow!("MCP token endpoint returned an empty access_token"));
        }
        Ok(CachedToken {
            value: token.access_token,
            renew_after: Instant::now() + renew_margin(token.expires_in),
        })
    }

    /// Resolves the token endpoint and scope set once, then caches them.
    async fn discover(&self) -> anyhow::Result<Discovered> {
        let mut guard = self.discovered.lock().await;
        if let Some(discovered) = guard.as_ref() {
            return Ok(discovered.clone());
        }
        let resource: reqwest::Url = self
            .mcp_url
            .parse()
            .context("gateway advertised an unparseable MCP URL")?;

        // RFC 9728 derives the metadata path from the resource path; the Gateway
        // also serves the host-level location. Try the spec form first.
        let mut metadata: Option<ProtectedResourceMetadata> = None;
        for candidate in protected_resource_metadata_urls(&resource) {
            match self
                .fetch_json::<ProtectedResourceMetadata>(&candidate)
                .await
            {
                Ok(value) if !value.authorization_servers.is_empty() => {
                    metadata = Some(value);
                    break;
                }
                Ok(_) => continue,
                Err(error) => {
                    tracing::debug!(url = %candidate, error = %error, "protected-resource metadata lookup failed");
                }
            }
        }
        let metadata = metadata.ok_or_else(|| {
            anyhow!(
                "no usable OAuth protected-resource metadata for {}",
                self.mcp_url
            )
        })?;
        let issuer = metadata
            .authorization_servers
            .first()
            .expect("authorization_servers checked non-empty above");
        if metadata.scopes_supported.is_empty() {
            return Err(anyhow!(
                "protected-resource metadata advertised no scopes_supported"
            ));
        }

        check_credential_destination(&resource, issuer, "authorization server")?;
        let as_metadata: AuthorizationServerMetadata = self
            .fetch_json(&authorization_server_metadata_url(issuer)?)
            .await
            .context("authorization-server metadata lookup failed")?;
        check_credential_destination(&resource, &as_metadata.token_endpoint, "token endpoint")?;

        let discovered = Discovered {
            token_endpoint: as_metadata.token_endpoint,
            scope: metadata.scopes_supported.join(" "),
        };
        *guard = Some(discovered.clone());
        Ok(discovered)
    }

    async fn fetch_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> anyhow::Result<T> {
        let response = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !response.status().is_success() {
            return Err(anyhow!("GET {url} returned HTTP {}", response.status()));
        }
        let body = bounded_body(response).await?;
        serde_json::from_slice(&body).with_context(|| format!("{url} returned invalid JSON"))
    }
}

/// Reads a response body, refusing anything over [`MAX_RESPONSE_BYTES`].
///
/// Checked against `Content-Length` first and against the running count while
/// streaming, so an absent or lying length header cannot be used to stream an
/// unbounded body at us.
async fn bounded_body(mut response: reqwest::Response) -> anyhow::Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(anyhow!(
            "OAuth response exceeds the {MAX_RESPONSE_BYTES}-byte cap"
        ));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = response.chunk().await.context("read OAuth response body")? {
        if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(anyhow!(
                "OAuth response exceeds the {MAX_RESPONSE_BYTES}-byte cap"
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// Candidate RFC 9728 metadata locations for a resource, spec form first.
fn protected_resource_metadata_urls(resource: &reqwest::Url) -> Vec<String> {
    let origin = resource.origin().ascii_serialization();
    let path = resource.path().trim_end_matches('/');
    let host_level = format!("{origin}/.well-known/oauth-protected-resource");
    if path.is_empty() {
        return vec![host_level];
    }
    vec![
        format!("{origin}/.well-known/oauth-protected-resource{path}"),
        host_level,
    ]
}

/// The host's client secret is posted to whatever origin discovery
/// names, so refuse a destination that could leak it. The MCP origin itself may
/// be plaintext (local dev runs the gateway over http); anything else must be
/// HTTPS.
fn check_credential_destination(
    mcp_url: &reqwest::Url,
    endpoint: &str,
    what: &str,
) -> anyhow::Result<()> {
    let url: reqwest::Url = endpoint
        .parse()
        .with_context(|| format!("{what} is not a URL"))?;
    if url.origin() == mcp_url.origin() || url.scheme() == "https" {
        return Ok(());
    }
    Err(anyhow!(
        "refusing to send host credentials to {what} {url} over {}: \
         only the MCP server's own origin may be plaintext",
        url.scheme()
    ))
}

/// RFC 8414 metadata location for an issuer.
fn authorization_server_metadata_url(issuer: &str) -> anyhow::Result<String> {
    let issuer: reqwest::Url = issuer
        .parse()
        .context("authorization server issuer is not a URL")?;
    Ok(format!(
        "{}/.well-known/oauth-authorization-server",
        issuer.origin().ascii_serialization()
    ))
}

/// How long a freshly minted token may be reused before re-minting.
fn renew_margin(expires_in: Option<u64>) -> Duration {
    let lifetime = expires_in
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TOKEN_LIFETIME);
    let target = lifetime.mul_f64(RENEW_AT_FRACTION);
    // The floor keeps a very short-lived token from being re-minted on every
    // call. The cap is the correctness half: `.min(lifetime)` still allowed
    // reuse for the token's entire lifetime, which presents it at the exact
    // moment it expires — always stop short of that.
    target
        .max(MIN_RENEW_MARGIN)
        .min(lifetime.saturating_sub(EXPIRY_SLACK))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// A throwaway HTTP/1.1 origin that speaks just enough to stand in for the
    /// Gateway's discovery and token endpoints. Returns its base URL, the bodies
    /// of every token request it saw, and a counter of those requests.
    struct FakeGateway {
        base: String,
        token_requests: Arc<Mutex<Vec<String>>>,
        token_hits: Arc<AtomicUsize>,
    }

    async fn spawn_gateway() -> FakeGateway {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let token_requests = Arc::new(Mutex::new(Vec::new()));
        let token_hits = Arc::new(AtomicUsize::new(0));
        let bodies = token_requests.clone();
        let hits = token_hits.clone();
        let origin = base.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let bodies = bodies.clone();
                let hits = hits.clone();
                let origin = origin.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 1024];
                    // Read headers, then any declared body.
                    let head_end = loop {
                        let read = match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        raw.extend_from_slice(&chunk[..read]);
                        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            break at + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                    let content_length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.trim()
                                .eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    while raw.len() < head_end + content_length {
                        let read = match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => n,
                        };
                        raw.extend_from_slice(&chunk[..read]);
                    }
                    let body = String::from_utf8_lossy(&raw[head_end..]).to_string();
                    let target = head.lines().next().unwrap_or_default().to_string();

                    let payload = if target.contains("/.well-known/oauth-protected-resource") {
                        format!(
                            r#"{{"resource":"{origin}/mcp","authorization_servers":["{origin}"],"scopes_supported":["cheers:read","cheers:messages:write"]}}"#
                        )
                    } else if target.contains("/.well-known/oauth-authorization-server") {
                        format!(
                            r#"{{"issuer":"{origin}","token_endpoint":"{origin}/oauth/token"}}"#
                        )
                    } else if target.starts_with("POST /oauth/token") {
                        hits.fetch_add(1, Ordering::SeqCst);
                        bodies.lock().await.push(body);
                        r#"{"access_token":"minted-token","token_type":"Bearer","expires_in":600,"scope":"cheers:read"}"#.to_string()
                    } else {
                        let _ = socket
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                            .await;
                        return;
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        FakeGateway {
            base,
            token_requests,
            token_hits,
        }
    }

    #[tokio::test]
    async fn mints_a_host_bound_token_through_full_discovery() {
        let gateway = spawn_gateway().await;
        let mcp_url = format!("{}/mcp", gateway.base);
        let provider = McpTokenProvider::new(
            mcp_url.clone(),
            "host-42".to_string(),
            "credential-secret".to_string(),
        )
        .unwrap();

        assert_eq!(provider.bearer().await.unwrap(), "minted-token");

        let requests = gateway.token_requests.lock().await;
        let body = requests.first().expect("a token request was made");
        assert!(body.contains("grant_type=client_credentials"), "{body}");
        assert!(body.contains("client_id=host-42"), "{body}");
        assert!(body.contains("client_secret=credential-secret"), "{body}");
        // Scope is taken from the resource's advertised set, never a local
        // constant, so the Connector cannot drift from the frozen scope list.
        assert!(
            body.contains("scope=cheers%3Aread+cheers%3Amessages%3Awrite"),
            "{body}"
        );
        // RFC 8707: the token must be bound to this exact MCP resource.
        assert!(body.contains("resource=http"), "{body}");
    }

    #[tokio::test]
    async fn reuses_a_live_token_instead_of_re_minting() {
        let gateway = spawn_gateway().await;
        let provider = McpTokenProvider::new(
            format!("{}/mcp", gateway.base),
            "host-42".to_string(),
            "credential-secret".to_string(),
        )
        .unwrap();

        for _ in 0..3 {
            assert_eq!(provider.bearer().await.unwrap(), "minted-token");
        }
        assert_eq!(gateway.token_hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn surfaces_a_gateway_that_publishes_no_metadata() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let provider = McpTokenProvider::new(
            format!("http://{addr}/mcp"),
            "host-42".to_string(),
            "credential-secret".to_string(),
        )
        .unwrap();
        let error = provider.bearer().await.unwrap_err().to_string();
        assert!(error.contains("protected-resource metadata"), "{error}");
    }

    #[test]
    fn metadata_urls_prefer_the_path_derived_form() {
        let resource: reqwest::Url = "https://cheers.example/mcp".parse().unwrap();
        assert_eq!(
            protected_resource_metadata_urls(&resource),
            vec![
                "https://cheers.example/.well-known/oauth-protected-resource/mcp".to_string(),
                "https://cheers.example/.well-known/oauth-protected-resource".to_string(),
            ]
        );
    }

    #[test]
    fn metadata_urls_collapse_for_a_root_resource() {
        let resource: reqwest::Url = "https://cheers.example/".parse().unwrap();
        assert_eq!(
            protected_resource_metadata_urls(&resource),
            vec!["https://cheers.example/.well-known/oauth-protected-resource".to_string()]
        );
    }

    #[test]
    fn as_metadata_url_is_origin_scoped() {
        assert_eq!(
            authorization_server_metadata_url("https://cheers.example/mcp").unwrap(),
            "https://cheers.example/.well-known/oauth-authorization-server"
        );
        assert!(authorization_server_metadata_url("not a url").is_err());
    }

    #[test]
    fn renew_margin_leaves_headroom_before_expiry() {
        // The Gateway's 10-minute access token renews at 8 minutes.
        assert_eq!(renew_margin(Some(600)), Duration::from_secs(480));
        // Absent expires_in falls back to the assumed lifetime.
        assert_eq!(
            renew_margin(None),
            DEFAULT_TOKEN_LIFETIME.mul_f64(RENEW_AT_FRACTION)
        );
    }

    #[test]
    fn refuses_plaintext_credential_destinations_off_the_mcp_origin() {
        let mcp: reqwest::Url = "http://localhost:8000/mcp".parse().unwrap();
        // The gateway's own plaintext origin is the local-dev case.
        check_credential_destination(&mcp, "http://localhost:8000/oauth/token", "token endpoint")
            .unwrap();
        // A third party must at least be HTTPS.
        check_credential_destination(&mcp, "https://idp.example/token", "token endpoint").unwrap();
        let error =
            check_credential_destination(&mcp, "http://attacker.example/token", "token endpoint")
                .expect_err("plaintext third-party endpoint must be refused");
        assert!(error.to_string().contains("refusing to send"), "{error}");
    }

    #[test]
    fn renew_margin_leaves_slack_on_a_short_lifetime() {
        // 10s token: the 30s floor must not push renewal past expiry.
        // The 30s floor must not stretch a 10s token to its full lifetime.
        assert_eq!(renew_margin(Some(10)), Duration::from_secs(5));
        // Nothing is reusable when the whole lifetime is inside the slack.
        assert_eq!(renew_margin(Some(3)), Duration::ZERO);
    }
}

#[cfg(test)]
mod redaction_tests {
    use super::*;

    #[test]
    fn debug_never_reveals_the_host_credential() {
        let provider = McpTokenProvider::new(
            "https://cheers.example/mcp".to_string(),
            "host-42".to_string(),
            "super-secret-credential".to_string(),
        )
        .unwrap();
        let rendered = format!("{provider:?}");
        assert!(!rendered.contains("super-secret-credential"), "{rendered}");
        assert!(rendered.contains("host-42"), "{rendered}");

        let cached = CachedToken {
            value: "super-secret-token".to_string(),
            renew_after: Instant::now(),
        };
        assert!(!format!("{cached:?}").contains("super-secret-token"));
    }
}
