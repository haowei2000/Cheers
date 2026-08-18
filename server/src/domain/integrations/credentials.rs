//! Custody of third-party service credentials.
//!
//! `auth_external_identities` answers "which Cheers user is this?" and
//! deliberately holds no usable provider token. This module holds the opposite:
//! access/refresh tokens the Gateway uses to call GitHub, Overleaf, and
//! whatever comes next, on a user's or workspace's behalf.
//!
//! Two rules shape everything here:
//!
//! 1. **Nothing outside this module sees ciphertext or plaintext.** Callers get
//!    a [`Secret`], which cannot be `Display`ed and redacts under `Debug`.
//! 2. **A credential is never handed out inside its expiry slack.** Returning a
//!    token that expires in-flight is how `mcp_token.rs` produced guaranteed
//!    401s; the same margin logic is applied here.

use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::secret::Secret;
use crate::infra::crypto;

/// Refresh once a credential is this far into its lifetime.
const RENEW_AT_FRACTION: f64 = 0.75;
/// Never sit on a credential longer than this, however long the lifetime is.
const MAX_RENEW_MARGIN: Duration = Duration::from_secs(15 * 60);
/// A credential whose remaining life is under this is treated as already dead:
/// handing it to a caller means the request expires mid-flight.
const EXPIRY_SLACK: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubjectType {
    User,
    Workspace,
}

impl SubjectType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Workspace => "workspace",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "workspace" => Some(Self::Workspace),
            _ => None,
        }
    }
}

/// A stored credential. `Debug` is safe to log: both tokens are [`Secret`].
#[derive(Debug, Clone)]
pub struct Credential {
    pub credential_id: String,
    pub integration_id: String,
    pub subject_type: SubjectType,
    pub subject_id: String,
    pub external_account: String,
    pub access_token: Secret,
    pub refresh_token: Option<Secret>,
    pub scopes: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl Credential {
    /// Whether the access token is still safe to hand to a caller.
    ///
    /// A token with no `expires_at` never expires. One inside [`EXPIRY_SLACK`]
    /// of its deadline is reported stale even though the provider would still
    /// accept it right now — by the time the request lands it may not.
    pub fn is_usable_at(&self, now: DateTime<Utc>) -> bool {
        if self.revoked_at.is_some() {
            return false;
        }
        match self.expires_at {
            None => true,
            Some(deadline) => {
                let slack = chrono::Duration::from_std(EXPIRY_SLACK).unwrap_or_default();
                deadline - slack > now
            }
        }
    }

    pub fn needs_refresh_at(&self, now: DateTime<Utc>) -> bool {
        self.refresh_token.is_some() && !self.is_usable_at(now)
    }
}

/// How long to wait before proactively renewing a credential with `lifetime`
/// left on it.
///
/// This is the `mcp_token.rs` bug in general form: taking the renewal point as
/// a plain fraction, then clamping it up to a minimum, can push the reuse
/// window past the token's own expiry, so the last handout is guaranteed to
/// 401. The clamp is therefore two-sided — never longer than the lifetime
/// minus its slack, even when that makes the margin zero.
pub fn renew_margin(lifetime: Option<Duration>) -> Duration {
    let Some(lifetime) = lifetime else {
        return MAX_RENEW_MARGIN;
    };
    let target = lifetime.mul_f64(RENEW_AT_FRACTION);
    target
        .min(MAX_RENEW_MARGIN)
        .min(lifetime.saturating_sub(EXPIRY_SLACK))
}

fn master_key(config: &crate::config::Config) -> [u8; 32] {
    crypto::derive_master_key(
        config.secret_store_key.as_deref(),
        &config.jwt_private_key_pem,
    )
}

/// Store or replace the credential for `(integration, subject, account)`.
///
/// Re-connecting the same account rotates the stored tokens in place rather
/// than accumulating rows, and clears any previous revocation.
#[allow(clippy::too_many_arguments)]
pub async fn upsert(
    db: &PgPool,
    config: &crate::config::Config,
    integration_id: &str,
    subject_type: SubjectType,
    subject_id: &str,
    external_account: &str,
    access_token: &Secret,
    refresh_token: Option<&Secret>,
    scopes: &str,
    expires_at: Option<DateTime<Utc>>,
    created_by: &str,
) -> anyhow::Result<String> {
    let key = master_key(config);
    let access_enc = crypto::encrypt_secret(&key, access_token.expose())?;
    let refresh_enc = refresh_token
        .map(|token| crypto::encrypt_secret(&key, token.expose()))
        .transpose()?;
    let credential_id = Uuid::new_v4().to_string();

    let stored: String = sqlx::query_scalar(
        "INSERT INTO integration_credentials (
             credential_id, integration_id, subject_type, subject_id, external_account,
             access_token_enc, refresh_token_enc, scopes, expires_at, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (integration_id, subject_type, subject_id, external_account)
         DO UPDATE SET
             access_token_enc  = EXCLUDED.access_token_enc,
             refresh_token_enc = EXCLUDED.refresh_token_enc,
             scopes            = EXCLUDED.scopes,
             expires_at        = EXCLUDED.expires_at,
             revoked_at        = NULL,
             last_refreshed_at = NOW(),
             updated_at        = NOW()
         RETURNING credential_id",
    )
    .bind(&credential_id)
    .bind(integration_id)
    .bind(subject_type.as_str())
    .bind(subject_id)
    .bind(external_account)
    .bind(&access_enc)
    .bind(&refresh_enc)
    .bind(scopes)
    .bind(expires_at)
    .bind(created_by)
    .fetch_one(db)
    .await?;
    Ok(stored)
}

/// Load one credential, decrypting both tokens.
///
/// Returns `Ok(None)` when no row exists. A row whose ciphertext will not
/// decrypt — the master key rotated without `SECRET_STORE_KEY` — is an error,
/// not a silent `None`: the caller must tell the user to reconnect rather than
/// behave as though the integration was never installed.
pub async fn load(
    db: &PgPool,
    config: &crate::config::Config,
    integration_id: &str,
    subject_type: SubjectType,
    subject_id: &str,
) -> anyhow::Result<Option<Credential>> {
    let row = sqlx::query(
        "SELECT credential_id, integration_id, subject_type, subject_id, external_account,
                access_token_enc, refresh_token_enc, scopes, expires_at, revoked_at
           FROM integration_credentials
          WHERE integration_id = $1 AND subject_type = $2 AND subject_id = $3
          ORDER BY updated_at DESC
          LIMIT 1",
    )
    .bind(integration_id)
    .bind(subject_type.as_str())
    .bind(subject_id)
    .fetch_optional(db)
    .await?;

    let Some(row) = row else { return Ok(None) };
    let key = master_key(config);
    let access_enc: String = row.try_get("access_token_enc")?;
    let refresh_enc: Option<String> = row.try_get("refresh_token_enc")?;
    let stored_subject: String = row.try_get("subject_type")?;

    Ok(Some(Credential {
        credential_id: row.try_get("credential_id")?,
        integration_id: row.try_get("integration_id")?,
        subject_type: SubjectType::parse(&stored_subject)
            .ok_or_else(|| anyhow::anyhow!("unknown subject_type {stored_subject}"))?,
        subject_id: row.try_get("subject_id")?,
        external_account: row.try_get("external_account")?,
        access_token: Secret::new(crypto::decrypt_secret(&key, &access_enc)?),
        refresh_token: refresh_enc
            .map(|blob| crypto::decrypt_secret(&key, &blob).map(Secret::new))
            .transpose()?,
        scopes: row.try_get("scopes")?,
        expires_at: row.try_get("expires_at")?,
        revoked_at: row.try_get("revoked_at")?,
    }))
}

/// Mark a credential unusable after a refresh fails permanently.
///
/// The row is kept rather than deleted so the UI can distinguish "reconnect
/// GitHub" from "GitHub was never connected", and so channel bindings that
/// reference it do not dangle.
pub async fn revoke(db: &PgPool, credential_id: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE integration_credentials
            SET revoked_at = NOW(), updated_at = NOW()
          WHERE credential_id = $1 AND revoked_at IS NULL",
    )
    .bind(credential_id)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).expect("valid timestamp")
    }

    fn credential(expires_at: Option<DateTime<Utc>>, refresh: bool) -> Credential {
        Credential {
            credential_id: "c1".into(),
            integration_id: "github".into(),
            subject_type: SubjectType::User,
            subject_id: "u1".into(),
            external_account: "octocat".into(),
            access_token: Secret::new("token"),
            refresh_token: refresh.then(|| Secret::new("refresh")),
            scopes: "repo".into(),
            expires_at,
            revoked_at: None,
        }
    }

    #[test]
    fn a_token_without_a_deadline_never_goes_stale() {
        assert!(credential(None, false).is_usable_at(at(1_000_000)));
    }

    #[test]
    fn a_token_inside_the_slack_window_is_already_stale() {
        let cred = credential(Some(at(1000)), false);
        assert!(cred.is_usable_at(at(900)), "80s left is fine");
        // 20s left: the provider would still accept it, but the request it is
        // about to be used for may not land in time.
        assert!(!cred.is_usable_at(at(980)));
        assert!(!cred.is_usable_at(at(1001)));
    }

    #[test]
    fn a_revoked_credential_is_never_usable() {
        let mut cred = credential(None, false);
        cred.revoked_at = Some(at(1));
        assert!(!cred.is_usable_at(at(2)));
    }

    #[test]
    fn refresh_is_only_attempted_when_a_refresh_token_exists() {
        assert!(credential(Some(at(1000)), true).needs_refresh_at(at(1001)));
        assert!(!credential(Some(at(1000)), false).needs_refresh_at(at(1001)));
    }

    #[test]
    fn renew_margin_leaves_slack_on_a_short_lifetime() {
        // The mcp_token.rs bug in general form: a 40s credential must not be
        // held for its whole life, or the last handout is guaranteed to 401.
        let margin = renew_margin(Some(Duration::from_secs(40)));
        assert_eq!(margin, Duration::from_secs(10));
        assert!(margin < Duration::from_secs(40) - EXPIRY_SLACK + Duration::from_secs(1));
    }

    #[test]
    fn renew_margin_is_zero_when_the_lifetime_is_all_slack() {
        assert_eq!(renew_margin(Some(Duration::from_secs(20))), Duration::ZERO);
        assert_eq!(renew_margin(Some(Duration::from_secs(0))), Duration::ZERO);
    }

    #[test]
    fn renew_margin_is_capped_for_a_long_lifetime() {
        // A 30-day token should still be re-checked within the cap, not held
        // for 22 days on the 0.75 fraction alone.
        assert_eq!(
            renew_margin(Some(Duration::from_secs(30 * 24 * 3600))),
            MAX_RENEW_MARGIN
        );
    }

    #[test]
    fn renew_margin_without_a_stated_lifetime_uses_the_cap() {
        assert_eq!(renew_margin(None), MAX_RENEW_MARGIN);
    }

    #[test]
    fn subject_type_round_trips_and_rejects_unknown() {
        for subject in [SubjectType::User, SubjectType::Workspace] {
            assert_eq!(SubjectType::parse(subject.as_str()), Some(subject));
        }
        assert_eq!(SubjectType::parse("channel"), None);
    }
}
