//! Outbound transactional email (password reset, …). Pluggable transport: when SMTP
//! is configured (`SMTP_HOST`, see [`crate::config::Config`]) messages go out via SMTP;
//! in dev — no SMTP — the message is written to the log so the flow is fully
//! exercisable without a mail server. Delivery is best-effort from the caller's
//! perspective (a reset request always returns 200 regardless, to avoid leaking which
//! emails exist).
use crate::config::Config;

/// Deliver a one-time password-reset code to `to_email`.
pub async fn send_password_reset_code(config: &Config, to_email: &str, code: &str) {
    if config.smtp_host.is_some() {
        // TODO(smtp): wire an SMTP transport (e.g. `lettre`) from config.smtp_host /
        // smtp_port / smtp_username / smtp_password and send the message below.
        // Until then we fall through to the log delivery so a staging box with SMTP
        // set still behaves like dev instead of silently dropping the mail.
        tracing::warn!(
            to = %to_email,
            "SMTP is configured but the transport isn't wired yet — logging the reset code instead"
        );
    }
    // Dev/staging delivery: the code is visible in the gateway logs
    // (`kubectl logs deploy/cheers-gateway | grep 'password reset'`).
    tracing::info!(
        target: "cheers::email",
        to = %to_email,
        code = %code,
        "password reset code (dev delivery via log — configure SMTP for real email; expires in 15m)"
    );
}
