use sha2::{Digest, Sha256};

/// 对 botToken 做 SHA-256，返回小写 hex 字符串。
/// bot_accounts.bot_token_hash 列存的就是这个值。
pub fn hash_bot_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}
