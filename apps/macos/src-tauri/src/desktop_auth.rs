//! Native authentication boundary for the macOS shell.
//!
//! WKWebView receives only the ten-minute access token. Password/OAuth
//! responses and refresh rotation terminate here so refresh and CSRF secrets
//! can be persisted directly in the user's login Keychain.

use reqwest::header::{AUTHORIZATION, ORIGIN};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

const KEYCHAIN_SERVICE: &str = "com.cheers.macos.auth";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuthOutcome {
    pub status: String,
    pub transaction_id: Option<String>,
    #[serde(default)]
    pub allowed_factors: Vec<String>,
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub requires_2fa: bool,
    pub access_token: Option<String>,
    pub user_id: Option<String>,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub role: Option<String>,
    #[serde(skip_serializing)]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing)]
    pub csrf_token: Option<String>,
}

fn origin(raw: &str) -> Result<String, String> {
    let mut url =
        Url::parse(raw).map_err(|_| "The configured server URL is invalid".to_string())?;
    if url.scheme() != "https"
        && !(url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
    {
        return Err("Authentication requires HTTPS (HTTP is allowed only for localhost)".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {
        return Err("The configured server URL is invalid".into());
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn account(server: &str, secret: &str) -> String {
    format!("{server}:{secret}")
}

fn keychain_get(server: &str, secret: &str) -> Option<String> {
    get_generic_password(KEYCHAIN_SERVICE, &account(server, secret))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn keychain_set(server: &str, secret: &str, value: &str) -> Result<(), String> {
    let account = account(server, secret);
    let _ = delete_generic_password(KEYCHAIN_SERVICE, &account);
    set_generic_password(KEYCHAIN_SERVICE, &account, value.as_bytes())
        .map_err(|_| "Could not save the session in macOS Keychain".into())
}

fn clear_keychain(server: &str) {
    let _ = delete_generic_password(KEYCHAIN_SERVICE, &account(server, "refresh"));
    let _ = delete_generic_password(KEYCHAIN_SERVICE, &account(server, "csrf"));
}

fn persist_session(server: &str, outcome: &mut AuthOutcome) -> Result<(), String> {
    if let Some(refresh) = outcome.refresh_token.take() {
        keychain_set(server, "refresh", &refresh)?;
    }
    if let Some(csrf) = outcome.csrf_token.take() {
        keychain_set(server, "csrf", &csrf)?;
    }
    Ok(())
}

async fn post(server: &str, path: &str, body: Value) -> Result<AuthOutcome, String> {
    let response = reqwest::Client::new()
        .post(format!("{server}/api/v1{path}"))
        .header(ORIGIN, "tauri://localhost")
        .json(&body)
        .send()
        .await
        .map_err(|_| "Could not reach the Cheers server".to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| format!("Authentication failed (HTTP {status})"));
        return Err(detail);
    }
    response
        .json::<AuthOutcome>()
        .await
        .map_err(|_| "The server returned an invalid authentication response".into())
}

#[tauri::command]
pub async fn desktop_password_login(
    server_base: String,
    login: String,
    password: String,
) -> Result<AuthOutcome, String> {
    let server = origin(&server_base)?;
    let mut outcome = post(
        &server,
        "/auth/login",
        json!({"login": login, "password": password, "client": "macos", "device_name": "Mac"}),
    )
    .await?;
    persist_session(&server, &mut outcome)?;
    Ok(outcome)
}

#[tauri::command]
pub async fn desktop_verify_factor(
    server_base: String,
    transaction_id: String,
    code: String,
) -> Result<AuthOutcome, String> {
    let server = origin(&server_base)?;
    let mut outcome = post(
        &server,
        "/auth/2fa/login",
        json!({"transaction_id": transaction_id, "code": code}),
    )
    .await?;
    persist_session(&server, &mut outcome)?;
    Ok(outcome)
}

#[tauri::command]
pub async fn desktop_oauth_handoff(
    server_base: String,
    code: String,
) -> Result<AuthOutcome, String> {
    let server = origin(&server_base)?;
    let mut outcome = post(
        &server,
        "/auth/oauth/handoff",
        json!({"code": code, "client": "macos"}),
    )
    .await?;
    persist_session(&server, &mut outcome)?;
    Ok(outcome)
}

#[tauri::command]
pub async fn desktop_refresh_session(server_base: String) -> Result<Option<AuthOutcome>, String> {
    let server = origin(&server_base)?;
    let Some(refresh) = keychain_get(&server, "refresh") else {
        return Ok(None);
    };
    let csrf = keychain_get(&server, "csrf");
    match post(
        &server,
        "/auth/refresh",
        json!({"refresh_token": refresh, "csrf_token": csrf}),
    )
    .await
    {
        Ok(mut outcome) => {
            persist_session(&server, &mut outcome)?;
            Ok(Some(outcome))
        }
        Err(error) => {
            clear_keychain(&server);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn desktop_logout_session(
    server_base: String,
    access_token: Option<String>,
) -> Result<(), String> {
    let server = origin(&server_base)?;
    if let Some(token) = access_token {
        let _ = reqwest::Client::new()
            .post(format!("{server}/api/v1/auth/logout-current"))
            .header(ORIGIN, "tauri://localhost")
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await;
    }
    clear_keychain(&server);
    Ok(())
}

#[tauri::command]
pub fn desktop_open_oauth_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "The OAuth URL is invalid".to_string())?;
    if parsed.scheme() != "https" {
        return Err("OAuth must open an HTTPS URL".into());
    }
    std::process::Command::new("/usr/bin/open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|_| "Could not open the system browser".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_origin_is_strict() {
        assert_eq!(
            origin("https://example.com/path").unwrap(),
            "https://example.com"
        );
        assert!(origin("http://example.com").is_err());
        assert!(origin("https://user@example.com").is_err());
        assert!(origin("http://localhost:8000").is_ok());
    }
}
