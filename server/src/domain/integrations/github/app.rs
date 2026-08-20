//! GitHub App authentication: App JWT → installation token.
//!
//! Two credentials, and conflating them is the classic mistake. The **App
//! JWT** is signed with the App's private key, proves "I am this App", and can
//! do almost nothing on its own — it may list installations and mint tokens.
//! The **installation token** is what actually reads a repository, is scoped to
//! one installation's selected repositories, and expires in an hour.
//!
//! Only the second is ever handed to callers, and it is cached through
//! [`credentials`] so a burst of API calls does not mint a token each time.
//! The cache is deliberately the same store the rest of the platform uses:
//! encrypted at rest, never `Display`-able, and returned only while it has more
//! than the module's expiry slack left to live.

use std::sync::OnceLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::config::{Config, GitHubAppConfig};
use crate::domain::integrations::{
    credentials::{self, SubjectType},
    secret::Secret,
};

/// GitHub rejects an App JWT whose lifetime exceeds 10 minutes. Nine leaves
/// room for the request to land.
const JWT_LIFETIME: Duration = Duration::from_secs(9 * 60);
/// GitHub's own advice for clock drift between the signer and their servers.
const JWT_BACKDATE: Duration = Duration::from_secs(60);

pub const INTEGRATION_ID: &str = "github";

#[derive(Debug, Serialize, Deserialize)]
struct AppClaims {
    iat: i64,
    exp: i64,
    iss: String,
}

/// The claims GitHub checks. Pure, so the parts that are easy to get wrong —
/// backdating, the lifetime ceiling, `iss` as a string — are testable without
/// any key material.
fn app_claims(app_id: &str, now: DateTime<Utc>) -> AppClaims {
    AppClaims {
        iat: now.timestamp() - JWT_BACKDATE.as_secs() as i64,
        exp: now.timestamp() - JWT_BACKDATE.as_secs() as i64 + JWT_LIFETIME.as_secs() as i64,
        iss: app_id.to_string(),
    }
}

/// GitHub accepts RS256 only.
fn jwt_header() -> jsonwebtoken::Header {
    jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256)
}

/// Sign an App JWT valid from just before `now`.
///
/// Fails when the configured PEM is not an RSA private key, which is worth an
/// error rather than a panic: it is the shape of misconfiguration an operator
/// hits by pasting the wrong file.
pub fn app_jwt(app: &GitHubAppConfig, now: DateTime<Utc>) -> anyhow::Result<Secret> {
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(app.private_key_pem.as_bytes()).map_err(
        |error| anyhow::anyhow!("GITHUB_APP_PRIVATE_KEY is not an RSA private key: {error}"),
    )?;
    let token = jsonwebtoken::encode(&jwt_header(), &app_claims(&app.app_id, now), &key)?;
    Ok(Secret::new(token))
}

/// Shared client. Built once: a fresh `reqwest::Client` per call would discard
/// the connection pool and re-handshake TLS on every API request.
pub fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("cheers-gateway")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    token: String,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct AppResponse {
    slug: String,
}

#[derive(Debug, Deserialize)]
struct InstallationResponse {
    id: i64,
    account: InstallationAccount,
}

#[derive(Debug, Deserialize)]
struct InstallationAccount {
    login: String,
}

#[derive(Debug, Deserialize)]
struct UserTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

async fn app_get<T: serde::de::DeserializeOwned>(config: &Config, path: &str) -> anyhow::Result<T> {
    let app = config
        .github_app
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("GitHub is not configured on this gateway"))?;
    let jwt = app_jwt(app, Utc::now())?;
    let response = http()
        .get(format!("{}{}", config.github_api_base_url, path))
        .bearer_auth(jwt.expose())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("GitHub rejected the App request ({status})");
    }
    Ok(response.json().await?)
}

/// Public slug used by GitHub's browser installation URL.
pub async fn app_slug(config: &Config) -> anyhow::Result<String> {
    Ok(app_get::<AppResponse>(config, "/app").await?.slug)
}

/// Verify that an installation belongs to this App and return its account.
pub async fn installation_account(
    config: &Config,
    external_installation_id: &str,
) -> anyhow::Result<String> {
    let installation = app_get::<InstallationResponse>(
        config,
        &format!("/app/installations/{external_installation_id}"),
    )
    .await?;
    if installation.id.to_string() != external_installation_id {
        anyhow::bail!("GitHub installation id did not match");
    }
    Ok(installation.account.login)
}

/// Exchange the short-lived callback code issued to this GitHub App. The
/// resulting user token is deliberately returned only to the callback stack.
pub async fn exchange_user_code(config: &Config, code: &str) -> anyhow::Result<Secret> {
    let app = config
        .github_app
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("GitHub is not configured on this gateway"))?;
    let client_id = app
        .client_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("GITHUB_APP_CLIENT_ID is not configured"))?;
    let client_secret = app
        .client_secret
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("GITHUB_APP_CLIENT_SECRET is not configured"))?;
    let response = http()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
        ])
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("GitHub rejected the installer authorization ({status})");
    }
    let body: UserTokenResponse = response.json().await?;
    let token = body.access_token.ok_or_else(|| {
        anyhow::anyhow!(
            "GitHub installer authorization failed: {}",
            body.error.unwrap_or_else(|| "missing token".into())
        )
    })?;
    Ok(Secret::new(token))
}

/// GitHub returns 404 when the user token is not associated with this
/// installation. This is the anti-spoofing check required for Setup callbacks.
pub async fn user_can_access_installation(
    config: &Config,
    token: &Secret,
    external_installation_id: &str,
) -> anyhow::Result<bool> {
    let response = http()
        .get(format!(
            "{}/user/installations/{external_installation_id}",
            config.github_api_base_url
        ))
        .bearer_auth(token.expose())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        anyhow::bail!(
            "GitHub refused the installer verification ({})",
            response.status()
        );
    }
    let installation: InstallationResponse = response.json().await?;
    Ok(installation.id.to_string() == external_installation_id)
}

/// Exchange the App JWT for an installation token. Always a network call —
/// [`installation_token`] is the caching entry point.
pub async fn mint_installation_token(
    config: &Config,
    app: &GitHubAppConfig,
    external_installation_id: &str,
) -> anyhow::Result<(Secret, Option<DateTime<Utc>>)> {
    let jwt = app_jwt(app, Utc::now())?;
    let url = format!(
        "{}/app/installations/{}/access_tokens",
        config.github_api_base_url, external_installation_id
    );
    let response = http()
        .post(&url)
        .bearer_auth(jwt.expose())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        // The body can echo the request; keep it out of the error a caller may
        // surface, and out of the logs.
        anyhow::bail!("GitHub refused an installation token ({status})");
    }
    let body: TokenResponse = response.json().await?;
    Ok((Secret::new(body.token), body.expires_at))
}

/// An installation token for `workspace_id`'s installation, from cache when one
/// is still safely usable.
///
/// `external_installation_id` is GitHub's own installation id; `workspace_id`
/// is what scopes the cache entry, so two workspaces installing the same App on
/// the same account do not share a row.
pub async fn installation_token(
    db: &PgPool,
    config: &Config,
    workspace_id: &str,
    external_installation_id: &str,
    installed_by: &str,
) -> anyhow::Result<Secret> {
    let app = config
        .github_app
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("GitHub is not configured on this gateway"))?;

    let cached = credentials::load_for_account(
        db,
        config,
        INTEGRATION_ID,
        SubjectType::Workspace,
        workspace_id,
        external_installation_id,
    )
    .await?;
    if let Some(cached) = cached {
        if cached.is_usable_at(Utc::now()) {
            return Ok(cached.access_token);
        }
    }

    let (token, expires_at) =
        mint_installation_token(config, app, external_installation_id).await?;
    // Store before returning: a caller that fails mid-request should not cause
    // the next one to mint again.
    credentials::upsert(
        db,
        config,
        INTEGRATION_ID,
        SubjectType::Workspace,
        workspace_id,
        external_installation_id,
        &token,
        None,
        "installation",
        expires_at,
        installed_by,
    )
    .await?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).expect("valid timestamp")
    }

    #[test]
    fn the_app_jwt_is_issued_by_the_app_id_as_a_string() {
        // GitHub rejects a numeric `iss`, which is what a naive `app_id: u64`
        // field would serialize to.
        let claims = app_claims("123456", at(1_700_000_000));
        assert_eq!(claims.iss, "123456");
        let encoded = serde_json::to_value(&claims).expect("serializes");
        assert!(encoded["iss"].is_string(), "{encoded}");
    }

    #[test]
    fn the_app_jwt_is_backdated_against_clock_drift() {
        let now = 1_700_000_000;
        let claims = app_claims("1", at(now));
        assert!(
            claims.iat < now,
            "iat {} must precede {now} or GitHub rejects the token whenever our clock runs fast",
            claims.iat
        );
    }

    #[test]
    fn the_lifetime_stays_inside_githubs_ceiling_measured_from_iat() {
        // The edge case backdating introduces: GitHub measures the 10-minute
        // ceiling from `iat`, so `now + 600` with a backdated `iat` is 660 and
        // is refused outright.
        let claims = app_claims("1", at(1_700_000_000));
        assert!(
            claims.exp - claims.iat <= 600,
            "lifetime {} exceeds the ceiling",
            claims.exp - claims.iat
        );
        assert!(claims.exp > 1_700_000_000, "must still be valid now");
    }

    #[test]
    fn the_jwt_is_signed_rs256() {
        assert_eq!(jwt_header().alg, jsonwebtoken::Algorithm::RS256);
    }

    #[test]
    fn a_key_that_is_not_a_private_key_is_an_error_not_a_panic() {
        let broken = GitHubAppConfig {
            app_id: "1".into(),
            private_key_pem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----".into(),
            client_id: None,
            client_secret: None,
            webhook_secret: None,
        };
        let error = app_jwt(&broken, at(1)).expect_err("must not sign");
        assert!(
            error.to_string().contains("GITHUB_APP_PRIVATE_KEY"),
            "the message should name the setting to fix: {error}"
        );
    }
}
