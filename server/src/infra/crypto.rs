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
