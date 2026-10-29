//! Loopback credential gateway for the canonical Cheers HTTP MCP endpoint.
//!
//! Header injection hands the Agent a real Cheers access token and relies on
//! the Agent re-reading `mcpServers[].headers` on every `session/load` to pick
//! up a renewed one. Codex does not (docs/arch/MCP_AUTH_ISOLATION.md §3.4.4),
//! so its live sessions keep presenting a token that eventually expires.
//!
//! The gateway removes both problems. The Agent is given a loopback URL and a
//! per-channel local secret that never changes for the life of the Agent
//! process; each request is forwarded to the Gateway's `/mcp` with the real,
//! channel-narrowed token swapped in. The local secret is worthless off this
//! host, and rotation happens here, where the Agent cannot see it.
//!
//! It is a pass-through, not an MCP implementation: the body and the MCP
//! headers are forwarded unchanged, so 2025-06-18, 2025-11-25 and 2026-07-28
//! clients all work against a Gateway that serves every era statelessly.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderMap, HeaderName};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rand::RngExt;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::AbortHandle;

use crate::mcp_token::McpTokenProvider;

/// Matches the Gateway's own cap on `/mcp` bodies (8 MiB attachments after
/// base64 expansion), so the gateway never accepts what the Gateway refuses.
const MAX_BODY_BYTES: usize = 12 * 1024 * 1024;
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Pause after a failed `accept`, so a persistent error cannot spin a core.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
const LOCAL_PATH: &str = "/mcp";

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type ProxyBody = BoxBody<Bytes, BoxError>;

/// A running loopback gateway. Dropping it stops accepting connections.
pub(crate) struct CredentialGateway {
    local_url: String,
    state: Arc<GatewayState>,
    accept: AbortHandle,
}

struct GatewayState {
    upstream: String,
    port: u16,
    tokens: Arc<McpTokenProvider>,
    http: reqwest::Client,
    routes: RwLock<Routes>,
}

/// Local secrets, kept both ways: by channel to hand the same secret out on
/// every turn, and by digest to resolve an incoming request to its channel.
#[derive(Default)]
struct Routes {
    secret_by_channel: HashMap<String, String>,
    channel_by_digest: HashMap<[u8; 32], String>,
}

impl CredentialGateway {
    /// Binds `127.0.0.1` on an ephemeral port and starts serving.
    pub(crate) async fn start(
        upstream: String,
        tokens: Arc<McpTokenProvider>,
    ) -> anyhow::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .context("failed to bind the MCP credential gateway on 127.0.0.1")?;
        let port = listener.local_addr()?.port();
        // No overall timeout: request-scoped SSE responses stay open for as
        // long as the tool call runs.
        let http = reqwest::Client::builder()
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .build()
            .context("failed to build the MCP credential gateway HTTP client")?;
        let state = Arc::new(GatewayState {
            upstream,
            port,
            tokens,
            http,
            routes: RwLock::new(Routes::default()),
        });
        let accept = tokio::spawn(accept_loop(listener, state.clone())).abort_handle();
        Ok(Self {
            local_url: format!("http://127.0.0.1:{port}{LOCAL_PATH}"),
            state,
            accept,
        })
    }

    /// The URL the Agent is given in place of the Gateway's `/mcp`.
    pub(crate) fn local_url(&self) -> &str {
        &self.local_url
    }

    /// The local secret for `channel_id`, stable for the gateway's lifetime so
    /// an Agent that never re-reads its headers keeps working.
    pub(crate) async fn secret_for(&self, channel_id: &str) -> String {
        if let Some(secret) = self
            .state
            .routes
            .read()
            .await
            .secret_by_channel
            .get(channel_id)
        {
            return secret.clone();
        }
        let mut routes = self.state.routes.write().await;
        if let Some(secret) = routes.secret_by_channel.get(channel_id) {
            return secret.clone();
        }
        let secret = random_secret();
        routes
            .channel_by_digest
            .insert(digest(&secret), channel_id.to_string());
        routes
            .secret_by_channel
            .insert(channel_id.to_string(), secret.clone());
        secret
    }
}

impl Drop for CredentialGateway {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

/// Redacted: the routes hold live local secrets.
impl std::fmt::Debug for CredentialGateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialGateway")
            .field("local_url", &self.local_url)
            .field("upstream", &self.state.upstream)
            .finish_non_exhaustive()
    }
}

async fn accept_loop(listener: TcpListener, state: Arc<GatewayState>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                tracing::warn!(%error, "MCP credential gateway accept failed");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        let state = state.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let state = state.clone();
                async move { Ok::<_, Infallible>(handle(&state, request).await) }
            });
            if let Err(error) = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                tracing::debug!(%error, "MCP credential gateway connection ended with an error");
            }
        });
    }
}

async fn handle(state: &GatewayState, request: Request<Incoming>) -> Response<ProxyBody> {
    match proxy(state, request).await {
        Ok(response) => response,
        Err(status) => empty(status),
    }
}

async fn proxy(
    state: &GatewayState,
    request: Request<Incoming>,
) -> Result<Response<ProxyBody>, StatusCode> {
    if request.uri().path() != LOCAL_PATH {
        return Err(StatusCode::NOT_FOUND);
    }
    // Host and Origin checks close DNS-rebinding and drive-by browser access:
    // a page on another origin cannot reach a loopback listener through them.
    if !host_is_loopback(request.headers(), state.port) || !origin_is_loopback(request.headers()) {
        return Err(StatusCode::FORBIDDEN);
    }
    let channel_id = state
        .channel_for(request.headers())
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    // The Gateway serves MCP over POST only (GET and DELETE are 405 there too),
    // so answer locally instead of spending a token on a known refusal.
    if request.method() != Method::POST {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let forwarded = forwarded_request_headers(request.headers());
    let body = Limited::new(request.into_body(), MAX_BODY_BYTES)
        .collect()
        .await
        .map_err(|error| {
            if error.is::<http_body_util::LengthLimitError>() {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            }
        })?
        .to_bytes();

    let mut upstream = state.send(&channel_id, &forwarded, body.clone()).await?;
    if upstream.status() == StatusCode::UNAUTHORIZED {
        // A cached token can be refused before its renewal point (credential
        // rotated, token revoked). Re-mint once; a second refusal is real.
        state.tokens.invalidate(&channel_id).await;
        upstream = state.send(&channel_id, &forwarded, body).await?;
    }
    Ok(relay(upstream))
}

impl GatewayState {
    async fn channel_for(&self, headers: &HeaderMap) -> Option<String> {
        let secret = bearer(headers)?;
        self.routes
            .read()
            .await
            .channel_by_digest
            .get(&digest(secret))
            .cloned()
    }

    async fn send(
        &self,
        channel_id: &str,
        forwarded: &HeaderMap,
        body: Bytes,
    ) -> Result<reqwest::Response, StatusCode> {
        let token = self.tokens.bearer(channel_id).await.map_err(|error| {
            tracing::warn!(%error, channel_id, "MCP credential gateway could not mint a token");
            StatusCode::BAD_GATEWAY
        })?;
        self.http
            .post(&self.upstream)
            .headers(forwarded.clone())
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(body)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "MCP credential gateway could not reach the Gateway");
                StatusCode::BAD_GATEWAY
            })
    }
}

/// Streams the Gateway's response back, so request-scoped SSE progress reaches
/// the Agent as it is produced.
fn relay(upstream: reqwest::Response) -> Response<ProxyBody> {
    let status = upstream.status();
    let headers = relayed_response_headers(upstream.headers());
    let stream = upstream
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(|error| Box::new(error) as BoxError);
    let mut response = Response::new(BodyExt::boxed(StreamBody::new(stream)));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn empty(status: StatusCode) -> Response<ProxyBody> {
    let mut response = Response::new(
        Full::new(Bytes::new())
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
}

/// Request headers that describe the MCP message. Everything else — the
/// local `Authorization`, `Host`, `Origin`, cookies — stays on this side.
fn forwarded_request_headers(headers: &HeaderMap) -> HeaderMap {
    forward_matching(headers, |name| {
        name == header::CONTENT_TYPE || name == header::ACCEPT || name.as_str().starts_with("mcp-")
    })
}

/// Response headers the Agent needs. `WWW-Authenticate` is dropped: it points
/// at the Gateway's OAuth metadata, which would invite the Agent to start an
/// authorization flow of its own against a resource it reaches only through
/// this gateway.
fn relayed_response_headers(headers: &HeaderMap) -> HeaderMap {
    forward_matching(headers, |name| {
        name == header::CONTENT_TYPE
            || name == header::CACHE_CONTROL
            || name.as_str().starts_with("mcp-")
    })
}

fn forward_matching(headers: &HeaderMap, keep: impl Fn(&HeaderName) -> bool) -> HeaderMap {
    let mut kept = HeaderMap::new();
    for (name, value) in headers {
        if keep(name) {
            kept.append(name.clone(), value.clone());
        }
    }
    kept
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, credentials) = value.split_once(' ')?;
    let credentials = credentials.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !credentials.is_empty()).then_some(credentials)
}

fn host_is_loopback(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// Absent `Origin` is a non-browser client (every Agent); a present one must be
/// loopback.
fn origin_is_loopback(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split(':').next().unwrap_or_default();
    host == "127.0.0.1" || host == "localhost"
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn digest(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use hyper::header::HeaderValue;
    use tokio::sync::Mutex;

    use super::*;

    /// What the fake Gateway saw on `/mcp`.
    #[derive(Debug, Clone)]
    struct Seen {
        authorization: Option<String>,
        protocol: Option<String>,
        method: Option<String>,
        origin: Option<String>,
        body: String,
    }

    struct FakeGateway {
        base: String,
        seen: Arc<Mutex<Vec<Seen>>>,
        token_hits: Arc<AtomicUsize>,
    }

    /// A Gateway that serves discovery, mints `token-<n>`, and answers `/mcp`.
    /// With `reject_first`, the first `/mcp` request gets a 401 carrying a
    /// `WWW-Authenticate` challenge.
    async fn spawn_gateway(reject_first: bool) -> FakeGateway {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let token_hits = Arc::new(AtomicUsize::new(0));
        let mcp_hits = Arc::new(AtomicUsize::new(0));
        let (seen_c, tokens_c, origin) = (seen.clone(), token_hits.clone(), base.clone());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (seen, tokens, mcp_hits, origin) = (
                    seen_c.clone(),
                    tokens_c.clone(),
                    mcp_hits.clone(),
                    origin.clone(),
                );
                tokio::spawn(async move {
                    let service = hyper::service::service_fn(move |request: Request<Incoming>| {
                        let (seen, tokens, mcp_hits, origin) = (
                            seen.clone(),
                            tokens.clone(),
                            mcp_hits.clone(),
                            origin.clone(),
                        );
                        async move {
                            let path = request.uri().path().to_string();
                            let header = |name: &str| {
                                request
                                    .headers()
                                    .get(name)
                                    .and_then(|v| v.to_str().ok())
                                    .map(str::to_string)
                            };
                            let (authorization, protocol, method, origin_header) = (
                                header("authorization"),
                                header("mcp-protocol-version"),
                                header("mcp-method"),
                                header("origin"),
                            );
                            let body = request.into_body().collect().await.unwrap().to_bytes();
                            let mut response = Response::new(Full::new(Bytes::new()));
                            let json = |payload: String| {
                                let mut r = Response::new(Full::new(Bytes::from(payload)));
                                r.headers_mut().insert(
                                    header::CONTENT_TYPE,
                                    HeaderValue::from_static("application/json"),
                                );
                                r
                            };
                            if path.starts_with("/.well-known/oauth-protected-resource") {
                                response = json(format!(
                                    r#"{{"resource":"{origin}/mcp","authorization_servers":["{origin}"],"scopes_supported":["cheers:read"]}}"#
                                ));
                            } else if path.starts_with("/.well-known/oauth-authorization-server") {
                                response = json(format!(
                                    r#"{{"issuer":"{origin}","token_endpoint":"{origin}/oauth/token"}}"#
                                ));
                            } else if path == "/oauth/token" {
                                let n = tokens.fetch_add(1, Ordering::SeqCst) + 1;
                                response = json(format!(
                                    r#"{{"access_token":"token-{n}","token_type":"Bearer","expires_in":600}}"#
                                ));
                            } else if path == "/mcp" {
                                seen.lock().await.push(Seen {
                                    authorization,
                                    protocol,
                                    method,
                                    origin: origin_header,
                                    body: String::from_utf8_lossy(&body).to_string(),
                                });
                                if reject_first && mcp_hits.fetch_add(1, Ordering::SeqCst) == 0 {
                                    *response.status_mut() = StatusCode::UNAUTHORIZED;
                                    response.headers_mut().insert(
                                        header::WWW_AUTHENTICATE,
                                        HeaderValue::from_static("Bearer resource_metadata=\"x\""),
                                    );
                                } else {
                                    response = match mcp_reply(&body) {
                                        Some(payload) => json(payload),
                                        None => {
                                            *response.status_mut() = StatusCode::ACCEPTED;
                                            response
                                        }
                                    };
                                    response.headers_mut().insert(
                                        header::WWW_AUTHENTICATE,
                                        HeaderValue::from_static("Bearer realm=\"leak\""),
                                    );
                                }
                            } else {
                                *response.status_mut() = StatusCode::NOT_FOUND;
                            }
                            Ok::<_, Infallible>(response)
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        FakeGateway {
            base,
            seen,
            token_hits,
        }
    }

    /// Just enough MCP for a real client to finish connecting: echo the id,
    /// accept any `initialize` revision, and list no tools. Notifications get
    /// no body (`None` → 202).
    fn mcp_reply(body: &[u8]) -> Option<String> {
        let request: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
        request.get("id")?;
        let result = match request.get("method").and_then(serde_json::Value::as_str) {
            Some("initialize") => serde_json::json!({
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-cheers", "version": "0"}
            }),
            Some("tools/list") => serde_json::json!({"tools": []}),
            _ => serde_json::json!({}),
        };
        Some(
            serde_json::json!({"jsonrpc": "2.0", "id": request["id"], "result": result})
                .to_string(),
        )
    }

    async fn gateway_for(fake: &FakeGateway) -> CredentialGateway {
        let upstream = format!("{}/mcp", fake.base);
        let tokens = Arc::new(
            McpTokenProvider::new(upstream.clone(), "host-1".into(), "secret".into()).unwrap(),
        );
        CredentialGateway::start(upstream, tokens).await.unwrap()
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn forwards_with_the_real_token_and_keeps_mcp_headers() {
        let fake = spawn_gateway(false).await;
        let gateway = gateway_for(&fake).await;
        let secret = gateway.secret_for("channel-a").await;

        let response = client()
            .post(gateway.local_url())
            .bearer_auth(&secret)
            .header("MCP-Protocol-Version", "2025-06-18")
            .header("Mcp-Method", "tools/list")
            .header("Origin", "http://127.0.0.1")
            .header("Content-Type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers().get(header::WWW_AUTHENTICATE).is_none(),
            "the Gateway's OAuth challenge must not reach the Agent"
        );
        let seen = fake.seen.lock().await.clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].authorization.as_deref(), Some("Bearer token-1"));
        assert_eq!(seen[0].protocol.as_deref(), Some("2025-06-18"));
        assert_eq!(seen[0].method.as_deref(), Some("tools/list"));
        assert_eq!(seen[0].origin, None, "Origin stays on the loopback side");
        assert!(seen[0].body.contains("tools/list"));
    }

    #[tokio::test]
    async fn secrets_are_stable_per_channel_and_distinct_across_channels() {
        let fake = spawn_gateway(false).await;
        let gateway = gateway_for(&fake).await;
        let a = gateway.secret_for("channel-a").await;
        assert_eq!(a, gateway.secret_for("channel-a").await);
        assert_ne!(a, gateway.secret_for("channel-b").await);
        assert_eq!(a.len(), 64);
    }

    #[tokio::test]
    async fn refuses_unknown_secrets_without_reaching_the_gateway() {
        let fake = spawn_gateway(false).await;
        let gateway = gateway_for(&fake).await;
        gateway.secret_for("channel-a").await;

        let missing = client().post(gateway.local_url()).send().await.unwrap();
        let wrong = client()
            .post(gateway.local_url())
            .bearer_auth("not-a-secret")
            .send()
            .await
            .unwrap();

        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
        assert!(fake.seen.lock().await.is_empty());
        assert_eq!(fake.token_hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn refuses_foreign_origins_and_non_loopback_hosts() {
        let fake = spawn_gateway(false).await;
        let gateway = gateway_for(&fake).await;
        let secret = gateway.secret_for("channel-a").await;

        let foreign = client()
            .post(gateway.local_url())
            .bearer_auth(&secret)
            .header("Origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        let rebound = client()
            .post(gateway.local_url())
            .bearer_auth(&secret)
            .header("Host", "evil.example")
            .send()
            .await
            .unwrap();

        assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
        assert_eq!(rebound.status(), StatusCode::FORBIDDEN);
        assert!(fake.seen.lock().await.is_empty());
    }

    #[tokio::test]
    async fn answers_get_and_unknown_paths_locally() {
        let fake = spawn_gateway(false).await;
        let gateway = gateway_for(&fake).await;
        let secret = gateway.secret_for("channel-a").await;

        let get = client()
            .get(gateway.local_url())
            .bearer_auth(&secret)
            .send()
            .await
            .unwrap();
        let other = client()
            .post(gateway.local_url().replace("/mcp", "/other"))
            .bearer_auth(&secret)
            .send()
            .await
            .unwrap();

        assert_eq!(get.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(other.status(), StatusCode::NOT_FOUND);
        assert!(fake.seen.lock().await.is_empty());
    }

    #[tokio::test]
    async fn re_mints_once_when_the_gateway_rejects_a_cached_token() {
        let fake = spawn_gateway(true).await;
        let gateway = gateway_for(&fake).await;
        let secret = gateway.secret_for("channel-a").await;

        let response = client()
            .post(gateway.local_url())
            .bearer_auth(&secret)
            .body(r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#)
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let auths: Vec<_> = fake
            .seen
            .lock()
            .await
            .iter()
            .map(|seen| seen.authorization.clone().unwrap_or_default())
            .collect();
        assert_eq!(auths, ["Bearer token-1", "Bearer token-2"]);
    }

    #[tokio::test]
    async fn rejects_oversized_bodies() {
        let fake = spawn_gateway(false).await;
        let gateway = gateway_for(&fake).await;
        let secret = gateway.secret_for("channel-a").await;

        let response = client()
            .post(gateway.local_url())
            .bearer_auth(&secret)
            .body(vec![b'x'; MAX_BODY_BYTES + 1])
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(fake.seen.lock().await.is_empty());
    }

    #[test]
    fn origin_and_bearer_parsing() {
        let mut headers = HeaderMap::new();
        assert!(origin_is_loopback(&headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:3000"),
        );
        assert!(origin_is_loopback(&headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1.evil.example"),
        );
        assert!(!origin_is_loopback(&headers));
        headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!origin_is_loopback(&headers));

        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("bearer abc"),
        );
        assert_eq!(bearer(&headers), Some("abc"));
        headers.insert(header::AUTHORIZATION, HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer(&headers), None);
    }

    /// End-to-end against a real ACP Agent: the Agent connects its MCP client
    /// to the gateway with only the local secret, and every request reaches the
    /// Gateway carrying the minted token. Run with e.g.
    /// `CHEERS_E2E_AGENT="npx -y @agentclientprotocol/codex-acp@2.3.0" cargo test
    /// real_agent_connects_through_the_gateway -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "spawns a real ACP Agent; set CHEERS_E2E_AGENT"]
    async fn real_agent_connects_through_the_gateway() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let command = std::env::var("CHEERS_E2E_AGENT").expect("set CHEERS_E2E_AGENT");
        let parts: Vec<&str> = command.split_whitespace().collect();
        let fake = spawn_gateway(false).await;
        let gateway = gateway_for(&fake).await;
        let secret = gateway.secret_for("channel-e2e").await;
        let cwd = std::env::temp_dir().join(format!("cheers-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();

        let mut child = tokio::process::Command::new(parts[0])
            .args(&parts[1..])
            .current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut next_id = 0u64;
        let mut call = |method: &str, params: serde_json::Value| {
            next_id += 1;
            (
                next_id,
                serde_json::json!({"jsonrpc":"2.0","id":next_id,"method":method,"params":params})
                    .to_string()
                    + "\n",
            )
        };
        async fn reply(
            lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
            stdin: &mut tokio::process::ChildStdin,
            id: u64,
        ) -> serde_json::Value {
            loop {
                let line = tokio::time::timeout(Duration::from_secs(90), lines.next_line())
                    .await
                    .expect("agent reply timed out")
                    .unwrap()
                    .expect("agent closed stdout");
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if message.get("method").is_some() {
                    if let Some(request_id) = message.get("id") {
                        let refusal = serde_json::json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"e2e declines"}});
                        stdin
                            .write_all(format!("{refusal}\n").as_bytes())
                            .await
                            .unwrap();
                    }
                    continue;
                }
                if message["id"] == id {
                    return message;
                }
            }
        }

        let (id, frame) = call(
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
                "clientInfo": {"name": "cheers-e2e", "version": "0"}
            }),
        );
        stdin.write_all(frame.as_bytes()).await.unwrap();
        let init = reply(&mut lines, &mut stdin, id).await;
        println!("agentInfo: {}", init["result"]["agentInfo"]);

        // Same shape as `bridge_runtime::prompt::native_cheers_mcp_server`.
        let server = serde_json::json!({
            "type": "http",
            "name": "cheers",
            "url": gateway.local_url(),
            "headers": [{"name": "Authorization", "value": format!("Bearer {secret}")}]
        });
        let (id, frame) = call(
            "session/new",
            serde_json::json!({"cwd": cwd, "mcpServers": [server]}),
        );
        stdin.write_all(frame.as_bytes()).await.unwrap();
        let created = reply(&mut lines, &mut stdin, id).await;
        assert!(
            created.get("error").is_none(),
            "session/new failed: {created}"
        );
        tokio::time::sleep(Duration::from_secs(8)).await;

        let seen = fake.seen.lock().await.clone();
        for request in &seen {
            println!(
                "upstream saw: protocol={:?} body={}",
                request.protocol,
                request.body.chars().take(120).collect::<String>()
            );
        }
        assert!(
            !seen.is_empty(),
            "the Agent never reached the Gateway through the gateway"
        );
        assert!(
            seen.iter().all(|request| request
                .authorization
                .as_deref()
                .is_some_and(|auth| auth.starts_with("Bearer token-"))),
            "every upstream request must carry the minted token, never the local secret"
        );
        assert!(seen
            .iter()
            .any(|request| request.body.contains("tools/list")));
    }
}
