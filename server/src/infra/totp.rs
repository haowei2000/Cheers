//! Minimal RFC 6238 TOTP (Time-based One-Time Password) implementation.
//! Uses HMAC-SHA1 with a 30-second period and 6-digit codes, accepting a
//! one-step clock skew in either direction to tolerate client clock drift.

use hmac::{Hmac, Mac};
use sha1::Sha1;

#[allow(clippy::upper_case_acronyms)]
type HmacSha1 = Hmac<Sha1>;

const PERIOD: u64 = 30;
const DIGITS: usize = 6;

const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Generate a fresh 20-byte random secret and return it as a base32 string.
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 20];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    encode_base32(&bytes)
}

/// Verify a 6-digit TOTP code against a base32 secret at the given Unix timestamp.
pub fn verify(secret_b32: &str, code: &str, timestamp: u64) -> bool {
    if code.len() != DIGITS || !code.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let Some(secret) = decode_base32(secret_b32) else {
        return false;
    };
    let counter = timestamp / PERIOD;
    for drift in [-1i64, 0, 1] {
        let c = counter.saturating_add(drift as u64);
        if generate_code(&secret, c) == code {
            return true;
        }
    }
    false
}

/// Build an otpauth provisioning URI for authenticator apps.
/// Caller is responsible for choosing a readable account label and issuer.
pub fn provisioning_uri(secret_b32: &str, account: &str, issuer: &str) -> String {
    let account_encoded = percent_encode(account);
    let issuer_encoded = percent_encode(issuer);
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits={}&period={}",
        issuer_encoded, account_encoded, secret_b32, issuer_encoded, DIGITS, PERIOD
    )
}

fn generate_code(secret: &[u8], counter: u64) -> String {
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let result = mac.finalize().into_bytes();
    let offset = (result[19] & 0x0f) as usize;
    let binary = u32::from_be_bytes([
        result[offset] & 0x7f,
        result[offset + 1],
        result[offset + 2],
        result[offset + 3],
    ]);
    let code = binary % 10u32.pow(DIGITS as u32);
    format!("{:0digits$}", code, digits = DIGITS)
}

fn encode_base32(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() * 8 + 4) / 5);
    let mut buffer = 0u64;
    let mut bits_left = 0u8;
    for &b in input {
        buffer = (buffer << 8) | b as u64;
        bits_left += 8;
        while bits_left >= 5 {
            out.push(BASE32_ALPHABET[((buffer >> (bits_left - 5)) & 0x1f) as usize] as char);
            bits_left -= 5;
        }
    }
    if bits_left > 0 {
        out.push(BASE32_ALPHABET[((buffer << (5 - bits_left)) & 0x1f) as usize] as char);
    }
    out
}

fn decode_base32(input: &str) -> Option<Vec<u8>> {
    let input = input.trim().to_uppercase();
    let mut out = Vec::with_capacity(input.len() * 5 / 8);
    let mut buffer = 0u64;
    let mut bits_left = 0u8;
    for c in input.chars() {
        if c == '=' {
            continue;
        }
        let val = BASE32_ALPHABET.iter().position(|&x| x as char == c)? as u64;
        buffer = (buffer << 5) | val;
        bits_left += 5;
        if bits_left >= 8 {
            out.push(((buffer >> (bits_left - 8)) & 0xff) as u8);
            bits_left -= 8;
        }
    }
    Some(out)
}

/// RFC 3986 percent-encoding for the otpauth URI path/query.
fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip() {
        let raw = b"hello world!";
        let enc = encode_base32(raw);
        let dec = decode_base32(&enc).unwrap();
        assert_eq!(dec, raw);
    }

    #[test]
    fn totp_generate_and_verify() {
        let secret = "JBSWY3DPEHPK3PXP";
        let code = generate_code(&decode_base32(secret).unwrap(), 1);
        assert_eq!(code.len(), 6);
        assert!(verify(secret, &code, 30));
        // wrong code
        assert!(!verify(secret, "000000", 30));
    }
}
