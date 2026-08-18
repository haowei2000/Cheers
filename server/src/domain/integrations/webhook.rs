//! Verification for inbound integration webhooks.
//!
//! Before this module the only inbound webhook was LiveKit's, with its
//! signature check hand-written in `api/voice.rs`. Every new integration would
//! have cloned that shape: a new route, a new hand-rolled verification, a new
//! dedupe table. This is the generic form — the scheme is declared data, and
//! the Gateway verifies before anything parses the body.
//!
//! Three properties matter more than convenience here:
//!
//! 1. **Verify before parse.** Every function takes `&[u8]`, never a parsed
//!    value. An attacker must not reach `serde_json` without a valid signature.
//! 2. **Constant-time comparison.** Signature checks go through
//!    `hmac::Mac::verify_slice`, never `==` on the decoded bytes.
//! 3. **Uniform rejection.** [`Rejection`] carries no detail. A wrong signature,
//!    an unknown integration, a missing header, and a disabled installation all
//!    produce the same value, so the endpoint cannot be used to enumerate which
//!    integrations exist. The real cause is logged server-side.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// The largest body the receiver will verify. A webhook that legitimately
/// exceeds this should be fetched from the provider rather than pushed —
/// buffering unbounded unauthenticated input is the cheaper attack.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Every failure mode collapses to this. Deliberately carries no cause: the
/// caller renders one status and one body for all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rejection;

pub type Verified = Result<(), Rejection>;

/// How a provider proves it sent the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureScheme {
    /// GitHub, Stripe, and most others: HMAC-SHA256 over the raw body, rendered
    /// hex in a named header, usually with an algorithm prefix (`sha256=`).
    HmacSha256 {
        header: String,
        prefix: Option<String>,
    },
    /// LiveKit: a JWT in `Authorization: Bearer`, whose `sha256` claim carries
    /// the base64 digest of the raw body. The JWT itself is verified by the
    /// caller (it needs the issuer and decoding key); this checks the binding
    /// between the token and the body, which is the part that is easy to skip.
    JwtBodySha256,
}

/// Verify an HMAC-SHA256 signature header against the raw body.
///
/// `presented` is the header value exactly as received, prefix included.
pub fn verify_hmac_sha256(
    secret: &[u8],
    prefix: Option<&str>,
    presented: Option<&str>,
    body: &[u8],
) -> Verified {
    if body.len() > MAX_BODY_BYTES {
        return Err(Rejection);
    }
    let presented = presented
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or(Rejection)?;
    let hex = match prefix {
        Some(prefix) => presented.strip_prefix(prefix).ok_or(Rejection)?,
        None => presented,
    };
    let expected = decode_hex(hex).ok_or(Rejection)?;

    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| Rejection)?;
    mac.update(body);
    // Constant-time: never compare the decoded bytes with `==`.
    mac.verify_slice(&expected).map_err(|_| Rejection)
}

/// Verify that a base64 SHA-256 digest claim matches the raw body.
///
/// This is the LiveKit binding: the JWT proves the sender holds the shared
/// secret, and this proves the body is the one that was signed. Without it a
/// captured token could be replayed over a different payload.
pub fn verify_body_sha256_b64(claimed_b64: &str, body: &[u8]) -> Verified {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if body.len() > MAX_BODY_BYTES {
        return Err(Rejection);
    }
    let claimed = STANDARD.decode(claimed_b64.trim()).map_err(|_| Rejection)?;
    let actual = Sha256::digest(body);
    // Digests are not secrets, but a timing-independent compare costs nothing
    // and keeps one rule for the whole module.
    if claimed.len() != actual.len() {
        return Err(Rejection);
    }
    let differing = claimed
        .iter()
        .zip(actual.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if differing == 0 {
        Ok(())
    } else {
        Err(Rejection)
    }
}

/// Lowercase/uppercase hex to bytes. Returns `None` for odd length or any
/// non-hex character — both are rejections, not partial parses.
fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) || value.is_empty() {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(value.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known-answer vector: HMAC-SHA256 of `body` under `secret`, in GitHub's
    /// `sha256=<hex>` header form. Generated independently of this module.
    const SECRET: &[u8] = b"It's a Secret to Everybody";
    const BODY: &[u8] = b"Hello, World!";
    const SIGNATURE: &str =
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

    #[test]
    fn accepts_the_github_known_answer_vector() {
        assert_eq!(
            verify_hmac_sha256(SECRET, Some("sha256="), Some(SIGNATURE), BODY),
            Ok(())
        );
    }

    #[test]
    fn rejects_a_tampered_body() {
        assert_eq!(
            verify_hmac_sha256(SECRET, Some("sha256="), Some(SIGNATURE), b"Hello, World?"),
            Err(Rejection)
        );
    }

    #[test]
    fn rejects_a_tampered_signature() {
        let flipped = SIGNATURE.replace("757107", "757108");
        assert_eq!(
            verify_hmac_sha256(SECRET, Some("sha256="), Some(&flipped), BODY),
            Err(Rejection)
        );
    }

    #[test]
    fn rejects_the_wrong_secret() {
        assert_eq!(
            verify_hmac_sha256(b"wrong", Some("sha256="), Some(SIGNATURE), BODY),
            Err(Rejection)
        );
    }

    #[test]
    fn rejects_a_missing_or_blank_header() {
        assert_eq!(
            verify_hmac_sha256(SECRET, Some("sha256="), None, BODY),
            Err(Rejection)
        );
        assert_eq!(
            verify_hmac_sha256(SECRET, Some("sha256="), Some("   "), BODY),
            Err(Rejection)
        );
    }

    #[test]
    fn rejects_a_signature_missing_its_declared_prefix() {
        // A provider that silently drops the prefix must not be accepted by
        // falling back to "treat the whole value as hex".
        let bare = SIGNATURE.strip_prefix("sha256=").unwrap();
        assert_eq!(
            verify_hmac_sha256(SECRET, Some("sha256="), Some(bare), BODY),
            Err(Rejection)
        );
        // ...but it verifies when no prefix was declared.
        assert_eq!(verify_hmac_sha256(SECRET, None, Some(bare), BODY), Ok(()));
    }

    #[test]
    fn rejects_non_hex_and_odd_length_signatures() {
        for bogus in ["sha256=zz", "sha256=abc", "sha256="] {
            assert_eq!(
                verify_hmac_sha256(SECRET, Some("sha256="), Some(bogus), BODY),
                Err(Rejection),
                "{bogus} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_an_oversized_body_without_hashing_it() {
        let huge = vec![b'x'; MAX_BODY_BYTES + 1];
        assert_eq!(
            verify_hmac_sha256(SECRET, Some("sha256="), Some(SIGNATURE), &huge),
            Err(Rejection)
        );
    }

    #[test]
    fn body_digest_binding_accepts_the_matching_body() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let digest = STANDARD.encode(Sha256::digest(BODY));
        assert_eq!(verify_body_sha256_b64(&digest, BODY), Ok(()));
    }

    #[test]
    fn body_digest_binding_rejects_a_replayed_token_over_a_new_body() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let digest = STANDARD.encode(Sha256::digest(BODY));
        assert_eq!(
            verify_body_sha256_b64(&digest, b"a different body"),
            Err(Rejection)
        );
    }

    #[test]
    fn body_digest_binding_rejects_malformed_and_short_digests() {
        assert_eq!(verify_body_sha256_b64("not base64!!", BODY), Err(Rejection));
        assert_eq!(verify_body_sha256_b64("YWJj", BODY), Err(Rejection));
    }

    #[test]
    fn rejection_carries_no_distinguishing_detail() {
        // The endpoint must not let a caller tell "unknown integration" from
        // "bad signature" — that is how installed integrations get enumerated.
        let wrong_secret = verify_hmac_sha256(b"wrong", Some("sha256="), Some(SIGNATURE), BODY);
        let missing_header = verify_hmac_sha256(SECRET, Some("sha256="), None, BODY);
        assert_eq!(wrong_secret, missing_header);
        assert_eq!(format!("{wrong_secret:?}"), format!("{missing_header:?}"));
    }
}
