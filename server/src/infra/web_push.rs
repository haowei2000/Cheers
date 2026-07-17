//! Web Push sender — RFC 8030 (protocol) + RFC 8291 (aes128gcm encryption) +
//! RFC 8292 (VAPID), implemented on the RustCrypto stack (p256/hkdf/aes-gcm)
//! so the gateway image needs no openssl. Correctness of the encryption is
//! pinned by the RFC 8291 Appendix A test vector in this module's tests.
//!
//! Delivery is best-effort and always spawned off the hot path by callers:
//! the durable state a push points at (permission card, mention message) lives
//! in the DB regardless, exactly like the in-app WS `notification` frames.
//! Endpoints the push service reports gone (404/410) are deleted on the spot,
//! so `push_subscriptions` never accumulates dead rows.

use aes_gcm::{aead::Aead, Aes128Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    elliptic_curve::sec1::ToEncodedPoint,
    pkcs8::DecodePrivateKey,
    PublicKey, SecretKey,
};
use sha2::Sha256;
use sqlx::Row;

use crate::{app_state::AppState, config::Config};

/// How long the push service may retry/queue an undelivered push. Approval
/// cards expire server-side after `approval_card_ttl_secs` (default 1800), so
/// a push older than an hour points at a card that is dead anyway.
pub const PUSH_TTL_SECS: u32 = 3600;

#[derive(Debug, thiserror::Error)]
pub enum PushError {
    /// The push service says this subscription no longer exists — delete it.
    #[error("subscription is gone (404/410)")]
    Gone,
    #[error("invalid subscription: {0}")]
    InvalidSubscription(&'static str),
    #[error("crypto failure: {0}")]
    Crypto(&'static str),
    #[error("push service returned status {0}")]
    Status(u16),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

pub struct WebPushSender {
    http: reqwest::Client,
    signing: SigningKey,
    /// Uncompressed P-256 public point, base64url — what the browser passes as
    /// `applicationServerKey` and what the `k=` VAPID auth parameter carries.
    public_key_b64: String,
    subject: String,
}

impl WebPushSender {
    /// Build the sender from `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`; `None` when
    /// no key is configured (push disabled). An *invalid* key panics — same
    /// fail-fast contract as the JWT keypair.
    pub fn from_config(config: &Config) -> Option<Self> {
        let pem = config.vapid_private_key_pem.as_deref()?;
        let secret = SecretKey::from_sec1_pem(pem)
            .or_else(|_| SecretKey::from_pkcs8_pem(pem))
            .unwrap_or_else(|e| {
                panic!(
                    "VAPID_PRIVATE_KEY is set but not a valid P-256 private-key PEM ({e}) — \
                     generate one with: openssl ecparam -genkey -name prime256v1 -noout"
                )
            });
        let public_key_b64 =
            URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes());
        let signing = SigningKey::from(&secret);
        // Endpoints are user-registered URLs, so the client is hardened: no
        // redirects (real push services never redirect; following one would
        // let a registered endpoint bounce the POST at in-cluster targets) and
        // tight timeouts (delivery is sequential per batch — one tarpit
        // endpoint must not stall every later recipient's push).
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("static reqwest client config");
        Some(Self {
            http,
            signing,
            public_key_b64,
            subject: config.vapid_subject.clone(),
        })
    }

    pub fn public_key_b64(&self) -> &str {
        &self.public_key_b64
    }

    /// RFC 8292 VAPID token for the push-service origin `aud`.
    fn vapid_jwt(&self, aud: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({
            "aud": aud,
            "exp": chrono::Utc::now().timestamp() + 12 * 3600,
            "sub": self.subject,
        });
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("literal json"));
        let msg = format!("{header}.{claims}");
        let sig: Signature = self.signing.sign(msg.as_bytes());
        format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    /// Encrypt `payload` for one subscription and POST it to the endpoint.
    pub async fn send(
        &self,
        endpoint: &str,
        p256dh_b64: &str,
        auth_b64: &str,
        payload: &serde_json::Value,
        ttl_secs: u32,
    ) -> Result<(), PushError> {
        let (ua_public, auth) = decode_subscription_keys(p256dh_b64, auth_b64)
            .map_err(PushError::InvalidSubscription)?;

        let as_secret = SecretKey::random(&mut rand_core::OsRng);
        let mut salt = [0u8; 16];
        getrandom::getrandom(&mut salt).map_err(|_| PushError::Crypto("salt"))?;

        let plaintext = serde_json::to_vec(payload).map_err(|_| PushError::Crypto("payload"))?;
        let body = encrypt_aes128gcm(&ua_public, &auth, &as_secret, &salt, &plaintext)?;

        let url = reqwest::Url::parse(endpoint)
            .map_err(|_| PushError::InvalidSubscription("endpoint is not a URL"))?;
        let aud = url.origin().ascii_serialization();

        let resp = self
            .http
            .post(url)
            .header("TTL", ttl_secs.to_string())
            .header("Urgency", "high")
            .header(reqwest::header::CONTENT_ENCODING, "aes128gcm")
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(
                reqwest::header::AUTHORIZATION,
                format!(
                    "vapid t={}, k={}",
                    self.vapid_jwt(&aud),
                    self.public_key_b64
                ),
            )
            .body(body)
            .send()
            .await?;
        match resp.status().as_u16() {
            200..=299 => Ok(()),
            404 | 410 => Err(PushError::Gone),
            s => Err(PushError::Status(s)),
        }
    }
}

/// Decode + validate the client keys of a subscription (both base64url,
/// unpadded): `p256dh` must be an uncompressed P-256 point, `auth` 16 bytes.
/// Shared by the subscribe API (reject garbage at write time) and the sender.
pub fn decode_subscription_keys(
    p256dh_b64: &str,
    auth_b64: &str,
) -> Result<(PublicKey, [u8; 16]), &'static str> {
    let p256dh = URL_SAFE_NO_PAD
        .decode(p256dh_b64)
        .map_err(|_| "p256dh is not unpadded base64url")?;
    let ua_public =
        PublicKey::from_sec1_bytes(&p256dh).map_err(|_| "p256dh is not a P-256 point")?;
    let auth = URL_SAFE_NO_PAD
        .decode(auth_b64)
        .map_err(|_| "auth is not unpadded base64url")?;
    let auth: [u8; 16] = auth.try_into().map_err(|_| "auth must be 16 bytes")?;
    Ok((ua_public, auth))
}

/// RFC 8291 §3 content encryption: one aes128gcm record carrying the whole
/// payload, keyid = the ephemeral application-server public key.
fn encrypt_aes128gcm(
    ua_public: &PublicKey,
    auth_secret: &[u8; 16],
    as_secret: &SecretKey,
    salt: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, PushError> {
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_public.as_affine());
    let ua_pub_point = ua_public.to_encoded_point(false);
    let as_pub_point = as_secret.public_key().to_encoded_point(false);

    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_pub_point.as_bytes());
    key_info.extend_from_slice(as_pub_point.as_bytes());

    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| PushError::Crypto("hkdf ikm"))?;

    let hk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| PushError::Crypto("hkdf cek"))?;
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| PushError::Crypto("hkdf nonce"))?;

    // RFC 8188 header: salt(16) ‖ record-size u32 BE ‖ keyid-len ‖ keyid.
    let mut body = Vec::with_capacity(86 + plaintext.len() + 17);
    body.extend_from_slice(salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(65);
    body.extend_from_slice(as_pub_point.as_bytes());

    // Single (= last) record: plaintext ‖ 0x02 delimiter, no padding.
    let mut record = Vec::with_capacity(plaintext.len() + 1);
    record.extend_from_slice(plaintext);
    record.push(0x02);

    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| PushError::Crypto("cek length"))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| PushError::Crypto("aes-gcm encrypt"))?;
    body.extend_from_slice(&ct);
    Ok(body)
}

/// Fire-and-forget: push `payload` to every subscription of every user in
/// `user_ids`. Spawns its own task — safe to call on hot paths (frame
/// handlers, message fan-out). No-op when push is disabled or the set is empty.
pub fn spawn_push_to_users(state: &AppState, user_ids: Vec<String>, payload: serde_json::Value) {
    let Some(sender) = state.web_push.clone() else {
        return;
    };
    if user_ids.is_empty() {
        return;
    }
    let db = state.db.clone();
    tokio::spawn(async move {
        for user_id in user_ids {
            push_to_user(&db, &sender, &user_id, payload.clone()).await;
        }
    });
}

/// Drop every push subscription of `user_id`. Called wherever the session
/// model revokes tokens (password change/reset, logout, suspension): push is
/// an out-of-app delivery channel, and a device that lost its session must
/// also stop receiving lock-screen content. Best-effort — callers log nothing;
/// the per-request join in [`push_to_user`] is the backstop.
pub async fn revoke_user_subscriptions(db: &sqlx::PgPool, user_id: &str) {
    if let Err(e) = sqlx::query("DELETE FROM push_subscriptions WHERE user_id = $1")
        .bind(user_id)
        .execute(db)
        .await
    {
        tracing::warn!(target: "cheers::push", error = %e, "push subscription revocation failed");
    }
}

/// Push `payload` to every subscription of `user_id`, deleting endpoints the
/// push service reports gone. Callers run this off the hot path — it must
/// never sit between a frame and its fan-out. Suspended/deleted accounts are
/// filtered here as a backstop to the revocation hooks.
pub async fn push_to_user(
    db: &sqlx::PgPool,
    sender: &WebPushSender,
    user_id: &str,
    payload: serde_json::Value,
) {
    let rows = match sqlx::query(
        "SELECT ps.endpoint, ps.p256dh, ps.auth
         FROM push_subscriptions ps
         JOIN users u ON u.user_id = ps.user_id
         WHERE ps.user_id = $1 AND NOT u.is_suspended AND NOT u.is_deleted",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(target: "cheers::push", error = %e, "push subscription lookup failed");
            return;
        }
    };
    for row in rows {
        let endpoint: String = row.try_get("endpoint").unwrap_or_default();
        let p256dh: String = row.try_get("p256dh").unwrap_or_default();
        let auth: String = row.try_get("auth").unwrap_or_default();
        match sender
            .send(&endpoint, &p256dh, &auth, &payload, PUSH_TTL_SECS)
            .await
        {
            Ok(()) => {}
            Err(PushError::Gone) => {
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1")
                    .bind(&endpoint)
                    .execute(db)
                    .await;
            }
            Err(e) => {
                tracing::warn!(target: "cheers::push", error = %e, "web push delivery failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(s).unwrap()
    }

    /// RFC 8291 Appendix A end-to-end test vector: fixed keys + salt must
    /// reproduce the exact message body from §5 byte for byte.
    #[test]
    fn rfc8291_appendix_a_vector() {
        let as_secret =
            SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        // Sanity: the vector's application-server public key derives from it.
        assert_eq!(
            URL_SAFE_NO_PAD.encode(as_secret.public_key().to_encoded_point(false).as_bytes()),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        let ua_public = PublicKey::from_sec1_bytes(&b64(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        ))
        .unwrap();
        let auth: [u8; 16] = b64("BTBZMqHH6r4Tts7J_aSIgg").try_into().unwrap();
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();

        let body = encrypt_aes128gcm(
            &ua_public,
            &auth,
            &as_secret,
            &salt,
            b"When I grow up, I want to be a watermelon",
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlml\
             MoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4M\
             qgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn subscription_key_validation() {
        // Valid keys from the RFC vector round-trip.
        assert!(decode_subscription_keys(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "BTBZMqHH6r4Tts7J_aSIgg",
        )
        .is_ok());
        // Padded/standard base64, wrong lengths, non-points all rejected.
        assert!(decode_subscription_keys("AAAA", "BTBZMqHH6r4Tts7J_aSIgg").is_err());
        assert!(decode_subscription_keys(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "dG9vc2hvcnQ",
        )
        .is_err());
    }
}
