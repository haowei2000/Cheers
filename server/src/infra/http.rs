//! Shared hardened HTTP response builders for serving user/agent-supplied bytes.
//!
//! Centralized here (not inlined per call site) so every file-serving path —
//! channel attachments today, the workspace file proxy tomorrow — applies the
//! same anti-XSS defenses and they cannot drift apart.

use axum::{
    body::Body,
    http::{header, HeaderValue, StatusCode},
    response::Response,
};

/// Content types a browser will execute script for when rendered inline — the
/// stored-XSS sink. These are always forced to download and stripped of their
/// declared type so they cannot run in the app origin.
fn is_active_content_type(ct: &str) -> bool {
    let base = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "image/svg+xml"
            | "text/html"
            | "text/xml"
            | "application/xml"
            | "application/xhtml+xml"
            | "text/ecmascript"
    ) || base.ends_with("+xml")
        || base.contains("javascript")
}

/// Strip characters that would break out of the quoted `Content-Disposition`
/// filename (CR/LF header injection, quote/backslash escape) and cap length.
fn sanitize_disposition_name(name: &str) -> String {
    name.chars()
        .filter(|c| *c != '"' && *c != '\\' && *c != '\r' && *c != '\n')
        .take(255)
        .collect()
}

/// Build a hardened response for file bytes whose type/name came from an
/// untrusted uploader (fixes the inline-preview stored-XSS, audit H4):
/// - `X-Content-Type-Options: nosniff` — the browser can't MIME-sniff bytes
///   into an executable type.
/// - active types (SVG/HTML/XML/JS) are forced to `attachment` and served as
///   `application/octet-stream`, so they download instead of running script.
/// - `Content-Security-Policy: sandbox` neutralizes script even if rendered.
/// - the `Content-Disposition` filename is sanitized against header injection.
pub fn file_response(
    bytes: Vec<u8>,
    filename: &str,
    declared_content_type: Option<&str>,
    inline: bool,
    ttl_seconds: Option<i64>,
) -> Response {
    let declared = declared_content_type
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("application/octet-stream");

    // Active types never render inline and lose their declared content-type.
    let (content_type, disposition) = if is_active_content_type(declared) {
        ("application/octet-stream", "attachment")
    } else {
        (declared, if inline { "inline" } else { "attachment" })
    };

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();

    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );

    let safe_name = sanitize_disposition_name(filename);
    let content_disposition = format!("{disposition}; filename=\"{safe_name}\"");
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );

    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(ttl) = ttl_seconds {
        if ttl > 0 {
            if let Ok(hv) = HeaderValue::from_str(&format!("private, max-age={ttl}")) {
                headers.insert(header::CACHE_CONTROL, hv);
            }
        }
    }

    response
}

/// Browser cross-site-WebSocket-hijacking (CSWSH) guard: a request carrying an
/// `Origin` header (i.e. from a browser) must match the allowlist; requests with
/// no `Origin` (the native connector daemon) pass through to their own token auth.
pub fn ws_origin_allowed(origin: Option<&str>, allowed: &[String]) -> bool {
    match origin {
        None => true,
        Some(o) => allowed.iter().any(|a| a == o),
    }
}
