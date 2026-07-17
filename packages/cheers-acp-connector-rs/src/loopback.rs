#![allow(dead_code)]

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{anyhow, Context};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use uuid::Uuid;

/// Drop a kept-alive loopback connection after this long with no new request, so
/// a pooled-but-idle MCP socket can't leak a task/fd for the life of the session.
const LOOPBACK_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Hard ceiling on a single loopback request body. The only legitimate client is
/// the local MCP bridge, whose resource calls are small JSON payloads, so a few
/// MiB is generous. Without this cap a local process could set an arbitrary
/// `Content-Length` and force the connection task to buffer that many bytes on the
/// heap before the token is even checked.
const MAX_LOOPBACK_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct LoopbackHandle {
    pub url: String,
    pub token: String,
    pub addr: SocketAddr,
}

#[derive(Debug)]
pub struct LoopbackRequest {
    pub req_id: String,
    pub resource: String,
    pub params: Option<Value>,
    pub respond_to: oneshot::Sender<LoopbackResponse>,
}

#[derive(Debug, Clone)]
pub struct LoopbackResponse {
    pub ok: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
    pub code: Option<String>,
}

pub async fn start_loopback() -> anyhow::Result<(LoopbackHandle, mpsc::Receiver<LoopbackRequest>)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("failed to bind loopback resource server")?;
    let addr = listener.local_addr()?;
    let token = Uuid::new_v4().to_string();
    let url = format!("http://{addr}/resource");
    let (tx, rx) = mpsc::channel(256);
    let expected_token = token.clone();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    let tx = tx.clone();
                    let expected_token = expected_token.clone();
                    tokio::spawn(async move {
                        if let Err(err) = handle_connection(stream, tx, &expected_token).await {
                            tracing::warn!("loopback resource request failed: {err}");
                        }
                    });
                }
                Err(err) => {
                    tracing::warn!("loopback accept failed: {err}");
                    break;
                }
            }
        }
    });
    Ok((LoopbackHandle { url, token, addr }, rx))
}

async fn handle_connection(
    mut stream: TcpStream,
    tx: mpsc::Sender<LoopbackRequest>,
    expected_token: &str,
) -> anyhow::Result<()> {
    // Persist across requests: bytes read past one request's body belong to the
    // next pipelined request on the same kept-alive connection.
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let request = match timeout(
            LOOPBACK_IDLE_TIMEOUT,
            read_http_request(&mut stream, &mut buf),
        )
        .await
        {
            Ok(result) => match result? {
                Some(request) => request,
                None => return Ok(()), // client closed the idle connection cleanly
            },
            Err(_) => return Ok(()), // idle too long — drop the connection
        };
        let keep_alive = request.wants_keep_alive();

        // Error responses always close: a bad method/token connection is not worth
        // keeping around, and closing keeps the state machine simple.
        if request.method != "POST" {
            write_http_json(
                &mut stream,
                405,
                false,
                &json!({ "ok": false, "code": "METHOD_NOT_ALLOWED", "error": "loopback only accepts POST" }),
            )
            .await?;
            return Ok(());
        }
        if !request_has_token(&request.headers, expected_token) {
            write_http_json(
                &mut stream,
                401,
                false,
                &json!({ "ok": false, "code": "UNAUTHORIZED", "error": "invalid loopback token" }),
            )
            .await?;
            return Ok(());
        }

        let body: Value =
            serde_json::from_slice(&request.body).context("loopback request body JSON")?;
        let resource = body
            .get("resource")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("loopback request requires resource"))?
            .to_string();
        let params = body.get("params").cloned();
        let req_id = body
            .get("req_id")
            .or_else(|| body.get("reqId"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let (respond_to, response_rx) = oneshot::channel();
        tx.send(LoopbackRequest {
            req_id: req_id.clone(),
            resource,
            params,
            respond_to,
        })
        .await
        .context("loopback runtime receiver closed")?;
        let response = response_rx.await.unwrap_or_else(|_| LoopbackResponse {
            ok: false,
            data: None,
            error: Some("runtime did not answer loopback request".to_string()),
            code: Some("RUNTIME_CLOSED".to_string()),
        });
        write_http_json(
            &mut stream,
            200,
            keep_alive,
            &json!({
                "ok": response.ok,
                "req_id": req_id,
                "data": response.data,
                "error": response.error,
                "code": response.code,
            }),
        )
        .await?;
        if !keep_alive {
            return Ok(());
        }
    }
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    version: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl HttpRequest {
    /// HTTP/1.1 keeps the connection alive unless `Connection: close`; HTTP/1.0
    /// closes unless `Connection: keep-alive`. reqwest's pool sends 1.1, so the
    /// common path reuses the socket.
    fn wants_keep_alive(&self) -> bool {
        match self.headers.get("connection") {
            Some(value) if value.eq_ignore_ascii_case("close") => false,
            Some(value) if value.eq_ignore_ascii_case("keep-alive") => true,
            _ => self.version != "HTTP/1.0",
        }
    }
}

/// Read one HTTP request off the stream, reusing `buf` as a carry-over buffer so
/// bytes belonging to a following pipelined request survive to the next call.
/// Returns `Ok(None)` on a clean EOF with nothing buffered — a client closing an
/// idle kept-alive connection, which is not an error.
async fn read_http_request(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
) -> anyhow::Result<Option<HttpRequest>> {
    let mut tmp = [0_u8; 1024];
    let header_end = loop {
        if let Some(pos) = find_header_end(buf) {
            break pos;
        }
        let read = stream.read(&mut tmp).await?;
        if read == 0 {
            if buf.is_empty() {
                return Ok(None); // idle connection closed cleanly between requests
            }
            return Err(anyhow!("connection closed before HTTP headers"));
        }
        buf.extend_from_slice(&tmp[..read]);
        if buf.len() > 64 * 1024 {
            return Err(anyhow!("loopback HTTP headers too large"));
        }
    };
    let (method, version, headers) = {
        let headers_text = std::str::from_utf8(&buf[..header_end])
            .context("loopback HTTP headers are not utf8")?;
        let mut lines = headers_text.lines();
        let request_line = lines
            .next()
            .ok_or_else(|| anyhow!("missing loopback HTTP request line"))?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let _path = parts.next();
        let version = parts.next().unwrap_or("HTTP/1.1").to_string();
        let mut headers = BTreeMap::new();
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        (method, version, headers)
    };
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    // Reject an oversized body from the declared Content-Length BEFORE draining it,
    // so a local process can't force us to buffer an arbitrary amount of heap. We
    // still write a proper 413 and then close (returning Err drops the connection).
    if content_length > MAX_LOOPBACK_BODY_BYTES {
        write_http_json(
            stream,
            413,
            false,
            &json!({ "ok": false, "code": "PAYLOAD_TOO_LARGE", "error": "loopback request body too large" }),
        )
        .await?;
        return Err(anyhow!(
            "loopback request body too large: {content_length} bytes (max {MAX_LOOPBACK_BODY_BYTES})"
        ));
    }
    let body_start = header_end + 4;
    let body_end = body_start + content_length;
    while buf.len() < body_end {
        let read = stream.read(&mut tmp).await?;
        if read == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..read]);
    }
    let available_end = body_end.min(buf.len());
    let body = buf[body_start..available_end].to_vec();
    // Drop this request's bytes; anything left is the start of the next request.
    buf.drain(..available_end);
    Ok(Some(HttpRequest {
        method,
        version,
        headers,
        body,
    }))
}

fn request_has_token(headers: &BTreeMap<String, String>, expected: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value == expected)
        .unwrap_or(false)
        || headers
            .get("x-cheers-loopback-token")
            .map(|value| value == expected)
            .unwrap_or(false)
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn write_http_json(
    stream: &mut TcpStream,
    status: u16,
    keep_alive: bool,
    body: &Value,
) -> anyhow::Result<()> {
    let status_text = match status {
        200 => "OK",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Error",
    };
    // Content-Length is always present, so the client can frame the body and reuse
    // the socket when we keep it alive.
    let connection = if keep_alive { "keep-alive" } else { "close" };
    let body = serde_json::to_vec(body)?;
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {connection}\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(&body).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_accepts_bearer_or_loopback_header() {
        let mut headers = BTreeMap::new();
        headers.insert("authorization".to_string(), "Bearer secret".to_string());
        assert!(request_has_token(&headers, "secret"));
        headers.clear();
        headers.insert("x-cheers-loopback-token".to_string(), "secret".to_string());
        assert!(request_has_token(&headers, "secret"));
    }

    fn req(version: &str, connection: Option<&str>) -> HttpRequest {
        let mut headers = BTreeMap::new();
        if let Some(value) = connection {
            headers.insert("connection".to_string(), value.to_string());
        }
        HttpRequest {
            method: "POST".to_string(),
            version: version.to_string(),
            headers,
            body: Vec::new(),
        }
    }

    #[test]
    fn keep_alive_decision_follows_http_semantics() {
        // HTTP/1.1 defaults to keep-alive; explicit close overrides.
        assert!(req("HTTP/1.1", None).wants_keep_alive());
        assert!(!req("HTTP/1.1", Some("close")).wants_keep_alive());
        assert!(req("HTTP/1.1", Some("keep-alive")).wants_keep_alive());
        // HTTP/1.0 defaults to close; explicit keep-alive overrides.
        assert!(!req("HTTP/1.0", None).wants_keep_alive());
        assert!(req("HTTP/1.0", Some("keep-alive")).wants_keep_alive());
    }

    #[tokio::test]
    async fn parses_two_pipelined_requests_then_clean_eof() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();

        // Client writes two POSTs back-to-back on one connection, then half-closes
        // the write side so the server sees EOF only after both are consumed.
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            let wire = "POST /resource HTTP/1.1\r\nContent-Length: 16\r\n\r\n\
                        {\"resource\":\"a\"}\
                        POST /resource HTTP/1.1\r\nContent-Length: 16\r\n\r\n\
                        {\"resource\":\"b\"}";
            stream.write_all(wire.as_bytes()).await.unwrap();
            // Half-close the write side so the server sees EOF after both requests;
            // keep the read side open (drop happens when the task ends).
            stream.shutdown().await.unwrap();
            stream
        });

        let (mut server, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();

        let first = read_http_request(&mut server, &mut buf)
            .await
            .unwrap()
            .expect("first request");
        assert_eq!(first.method, "POST");
        assert_eq!(first.body, b"{\"resource\":\"a\"}");
        assert!(first.wants_keep_alive());

        let second = read_http_request(&mut server, &mut buf)
            .await
            .unwrap()
            .expect("second pipelined request");
        assert_eq!(second.body, b"{\"resource\":\"b\"}");

        // Both consumed; the next read hits a clean EOF, which must be Ok(None).
        let third = read_http_request(&mut server, &mut buf).await.unwrap();
        assert!(third.is_none());

        // Keep the client socket alive until now, then let both ends close.
        let _client_stream = client.await.unwrap();
    }
}
