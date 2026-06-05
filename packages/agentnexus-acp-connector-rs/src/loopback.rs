#![allow(dead_code)]

use std::collections::BTreeMap;
use std::net::SocketAddr;

use anyhow::{anyhow, Context};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

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
    /// Optional platform session UUID supplied by the caller for correlation.
    /// Resource authorization is performed by the server from the bridge bot
    /// identity and channel membership role, not from this value.
    pub session_id: Option<String>,
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
    let request = read_http_request(&mut stream).await?;
    if request.method != "POST" {
        write_http_json(
            &mut stream,
            405,
            &json!({ "ok": false, "code": "METHOD_NOT_ALLOWED", "error": "loopback only accepts POST" }),
        )
        .await?;
        return Ok(());
    }
    if !request_has_token(&request.headers, expected_token) {
        write_http_json(
            &mut stream,
            401,
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
    let session_id = body
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
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
        session_id,
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
        &json!({
            "ok": response.ok,
            "req_id": req_id,
            "data": response.data,
            "error": response.error,
            "code": response.code,
        }),
    )
    .await?;
    Ok(())
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> anyhow::Result<HttpRequest> {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream.read(&mut tmp).await?;
        if read == 0 {
            return Err(anyhow!("connection closed before HTTP headers"));
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(pos) = find_header_end(&buf) {
            header_end = pos;
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err(anyhow!("loopback HTTP headers too large"));
        }
    }
    let headers_text =
        std::str::from_utf8(&buf[..header_end]).context("loopback HTTP headers are not utf8")?;
    let mut lines = headers_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| anyhow!("missing loopback HTTP request line"))?;
    let method = request_line
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    let mut body = buf.get(body_start..).unwrap_or_default().to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut tmp).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..read]);
    }
    body.truncate(content_length);
    Ok(HttpRequest {
        method,
        headers,
        body,
    })
}

fn request_has_token(headers: &BTreeMap<String, String>, expected: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value == expected)
        .unwrap_or(false)
        || headers
            .get("x-agentnexus-loopback-token")
            .map(|value| value == expected)
            .unwrap_or(false)
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn write_http_json(stream: &mut TcpStream, status: u16, body: &Value) -> anyhow::Result<()> {
    let status_text = match status {
        200 => "OK",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let body = serde_json::to_vec(body)?;
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
        headers.insert(
            "x-agentnexus-loopback-token".to_string(),
            "secret".to_string(),
        );
        assert!(request_has_token(&headers, "secret"));
    }
}
