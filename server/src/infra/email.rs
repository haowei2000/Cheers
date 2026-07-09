//! Outbound transactional email (registration codes, password reset, …).
//!
//! Delivery goes through Brevo's (ex-Sendinblue) transactional email HTTP API when
//! configured (`BREVO_API_KEY` + `EMAIL_FROM_EMAIL`, see [`crate::config::Config`]);
//! otherwise — dev, or if the send fails — the code is written to the log so the
//! flow stays fully exercisable without a mail provider. Delivery is best-effort
//! from the caller's perspective (forgot-password always returns 200 regardless, to
//! avoid leaking which emails exist).
use serde_json::json;

use crate::config::Config;

const BREVO_ENDPOINT: &str = "https://api.brevo.com/v3/smtp/email";
/// Keep the "expires in" wording in sync with the 15-minute `expires_at` set by the
/// callers in `api::auth`.
const CODE_TTL_TEXT: &str = "It expires in 15 minutes.";

/// Deliver a one-time email-verification code for self-service sign-up.
pub async fn send_registration_code(config: &Config, to_email: &str, code: &str) {
    deliver(
        config,
        to_email,
        "Your Cheers verification code",
        "Welcome to Cheers! Enter this code to finish creating your account:",
        code,
        "registration",
    )
    .await;
}

/// Deliver a one-time password-reset code to `to_email`.
pub async fn send_password_reset_code(config: &Config, to_email: &str, code: &str) {
    deliver(
        config,
        to_email,
        "Your Cheers password reset code",
        "Use this code to reset your Cheers password:",
        code,
        "password reset",
    )
    .await;
}

/// Send the code to `to_email`, preferring Brevo and falling back to log delivery so
/// the flow still works in dev (or if the provider is briefly unreachable). `kind`
/// is a short label for the logs (e.g. `registration`).
async fn deliver(config: &Config, to_email: &str, subject: &str, intro: &str, code: &str, kind: &str) {
    let text = format!(
        "{intro}\n\n    {code}\n\n{CODE_TTL_TEXT}\nIf you didn't request this, you can ignore this email."
    );
    if config.brevo_api_key.is_some() && config.email_from_email.is_some() {
        match send_brevo(config, to_email, subject, intro, code, &text).await {
            Ok(()) => {
                tracing::info!(target: "cheers::email", to = %to_email, kind, "email sent via Brevo");
                return;
            }
            Err(e) => {
                tracing::error!(
                    target: "cheers::email",
                    to = %to_email,
                    kind,
                    error = %e,
                    "Brevo delivery failed — falling back to log delivery"
                );
            }
        }
    }
    // Dev/staging delivery: the code is visible in the gateway logs
    // (`docker logs cheers-gateway-1 | grep cheers::email`). Only taken when Brevo
    // is unconfigured or the send above failed.
    tracing::info!(
        target: "cheers::email",
        to = %to_email,
        kind,
        subject,
        "email (dev delivery via log — set BREVO_API_KEY + EMAIL_FROM_EMAIL for real email):\n{text}"
    );
}

/// POST one transactional message to Brevo. Returns Err (to trigger log fallback)
/// on any transport error or non-2xx response.
async fn send_brevo(
    config: &Config,
    to_email: &str,
    subject: &str,
    intro: &str,
    code: &str,
    text: &str,
) -> Result<(), String> {
    let api_key = config
        .brevo_api_key
        .as_deref()
        .ok_or("BREVO_API_KEY not set")?;
    let from_email = config
        .email_from_email
        .as_deref()
        .ok_or("EMAIL_FROM_EMAIL not set")?;

    // `code` is our own generated token (uppercase alphanumerics) and the other
    // parts are static, so no user input is interpolated into this HTML.
    let html = format!(
        "<p>{intro}</p>\
         <p style=\"font-size:24px;font-weight:700;letter-spacing:3px;font-family:monospace;\">{code}</p>\
         <p style=\"color:#666;\">{CODE_TTL_TEXT} If you didn't request this, you can ignore this email.</p>"
    );
    let payload = json!({
        "sender": { "name": config.email_from_name, "email": from_email },
        "to": [{ "email": to_email }],
        "subject": subject,
        "htmlContent": html,
        "textContent": text,
    });

    let resp = reqwest::Client::new()
        .post(BREVO_ENDPOINT)
        .header("api-key", api_key)
        .header("accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(format!(
            "Brevo returned {status}: {}",
            body.chars().take(300).collect::<String>()
        ))
    }
}
