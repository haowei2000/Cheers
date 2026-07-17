use sha2::{Digest, Sha256};

/// botToken 明文前缀。便于在 UI/日志中识别（不含敏感信息）。
pub const BOT_TOKEN_PREFIX: &str = "agb_";

/// 对 botToken 做 SHA-256，返回小写 hex 字符串。
/// bot_accounts.bot_token_hash 列存的就是这个值。
pub fn hash_bot_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// 生成新的 botToken：`agb_<256-bit hex>`。明文仅在签发时返回一次，
/// 服务端只持久化其 SHA-256（见 [`hash_bot_token`]）。
pub fn generate_bot_token() -> String {
    generate_prefixed_secret(BOT_TOKEN_PREFIX)
}

/// Onboarding enrollment-code 明文前缀（一次性、短时，换取 botToken）。
pub const ENROLLMENT_CODE_PREFIX: &str = "agbenr_";

/// 生成一次性 enrollment code：`agbenr_<256-bit hex>`。只在铸造时返回一次，
/// 服务端只存其 SHA-256（用 [`hash_enrollment_code`]）。
pub fn generate_enrollment_code() -> String {
    generate_prefixed_secret(ENROLLMENT_CODE_PREFIX)
}

/// enrollment code 的 SHA-256（同 [`hash_bot_token`] 的算法）。
pub fn hash_enrollment_code(code: &str) -> String {
    hash_bot_token(code)
}

/// 32 字节 OS CSPRNG → 256-bit 十六进制秘密，带可识别前缀。
fn generate_prefixed_secret(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    format!("{prefix}{}", hex::encode(bytes))
}

/// Workspace invite-link token 前缀（Cheers INVite）。
pub const INVITE_LINK_PREFIX: &str = "cinv_";

/// 生成 invite-link token：`cinv_<128-bit hex>`。16 字节（而非 32）让分享出去的
/// URL 更短，仍然不可枚举；与 enrollment code 不同，它明文入库（见 0044 迁移头注）。
pub fn generate_invite_link_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    format!("{INVITE_LINK_PREFIX}{}", hex::encode(bytes))
}

// ── Secrets at rest (AES-256-GCM) ────────────────────────────────────────────
//
// Admin-entered third-party API keys (e.g. the STT endpoint key) live in
// `system_settings` JSONB. Encrypting them means a DB dump/backup doesn't leak
// working credentials. The master key is derived from material the deployment
// already keeps secret (the JWT private key), so no new required env var; set
// SECRET_STORE_KEY to decouple secret encryption from JWT key rotation.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};

/// Derive the 32-byte master key: SHA-256 over SECRET_STORE_KEY when set,
/// else over the JWT private key PEM. Deterministic across restarts.
pub fn derive_master_key(secret_store_key: Option<&str>, jwt_private_key_pem: &str) -> [u8; 32] {
    let material = secret_store_key
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(jwt_private_key_pem);
    let mut hasher = Sha256::new();
    hasher.update(b"cheers-secret-store-v1:");
    hasher.update(material.as_bytes());
    hasher.finalize().into()
}

/// Encrypt a secret for storage: returns base64(nonce ‖ ciphertext). The nonce is
/// a fresh 96-bit CSPRNG value per call, so re-saving the same key yields a new blob.
pub fn encrypt_secret(master_key: &[u8; 32], plaintext: &str) -> anyhow::Result<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let cipher = Aes256Gcm::new(master_key.into());
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|e| anyhow::anyhow!("CSPRNG unavailable: {e}"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("encrypt failed: {e}"))?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(blob))
}

/// Decrypt a base64(nonce ‖ ciphertext) blob produced by [`encrypt_secret`].
/// Fails when the master key changed (e.g. JWT key rotated without
/// SECRET_STORE_KEY) — the caller should treat that as "re-enter the secret".
pub fn decrypt_secret(master_key: &[u8; 32], blob_b64: &str) -> anyhow::Result<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let blob = STANDARD.decode(blob_b64.trim())?;
    if blob.len() < 12 {
        anyhow::bail!("secret blob too short");
    }
    let (nonce, ciphertext) = blob.split_at(12);
    let cipher = Aes256Gcm::new(master_key.into());
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| anyhow::anyhow!("decrypt failed (master key changed or data corrupt)"))?;
    Ok(String::from_utf8(plaintext)?)
}

// ── Password hashing (bcrypt, off the async reactor) ─────────────────────────
//
// bcrypt at DEFAULT_COST burns ~200-300ms of CPU per call. Running it directly
// on a tokio worker blocks that thread from making progress on other tasks, so
// a burst of logins/registrations can starve the whole runtime. These helpers
// move the CPU work onto the blocking-thread pool via `spawn_blocking`, which
// wants owned data — callers hand over owned `String`s.

/// Hash a password with bcrypt at `DEFAULT_COST`, off the async reactor.
/// Returns the same `bcrypt::BcryptError` the underlying call would.
pub async fn hash_password(plain: String) -> Result<String, bcrypt::BcryptError> {
    tokio::task::spawn_blocking(move || bcrypt::hash(&plain, bcrypt::DEFAULT_COST))
        .await
        .map_err(|e| bcrypt::BcryptError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}

/// Verify a password against a bcrypt hash, off the async reactor.
/// Returns the same `bcrypt::BcryptError` the underlying call would.
pub async fn verify_password(plain: String, hash: String) -> Result<bool, bcrypt::BcryptError> {
    tokio::task::spawn_blocking(move || bcrypt::verify(&plain, &hash))
        .await
        .map_err(|e| bcrypt::BcryptError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
}

/// A short, unambiguous one-time code for email flows (e.g. password reset). 8 chars
/// from a 31-symbol alphabet (no 0/O/1/I/L) → ~31^8 ≈ 8.5e11 combos, fits the
/// `email_codes.code` column (VARCHAR(10)). Pair with a short TTL + rate limiting.
pub fn generate_email_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0 O 1 I L
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable");
    bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 加密→解密 round-trip；同一明文两次加密产生不同 blob（随机 nonce）。
    #[test]
    fn secret_roundtrip_and_fresh_nonce() {
        let key = derive_master_key(None, "test-jwt-pem");
        let a = encrypt_secret(&key, "sk-abc123").unwrap();
        let b = encrypt_secret(&key, "sk-abc123").unwrap();
        assert_ne!(a, b);
        assert_eq!(decrypt_secret(&key, &a).unwrap(), "sk-abc123");
        assert_eq!(decrypt_secret(&key, &b).unwrap(), "sk-abc123");
    }

    /// 主密钥变化（如 JWT 轮换且未设 SECRET_STORE_KEY）→ 解密报错而非乱码。
    #[test]
    fn secret_wrong_key_fails() {
        let k1 = derive_master_key(None, "pem-one");
        let k2 = derive_master_key(None, "pem-two");
        let blob = encrypt_secret(&k1, "topsecret").unwrap();
        assert!(decrypt_secret(&k2, &blob).is_err());
    }

    /// SECRET_STORE_KEY 优先于 JWT PEM；空白值视为未设置。
    #[test]
    fn master_key_prefers_secret_store_key() {
        let from_env = derive_master_key(Some("env-key"), "pem");
        let from_pem = derive_master_key(None, "pem");
        let blank = derive_master_key(Some("  "), "pem");
        assert_ne!(from_env, from_pem);
        assert_eq!(blank, from_pem);
    }
}
