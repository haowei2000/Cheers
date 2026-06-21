use sha2::{Digest, Sha256};
use uuid::Uuid;

/// botToken 明文前缀。便于在 UI/日志中识别（不含敏感信息）。
pub const BOT_TOKEN_PREFIX: &str = "agb_";

/// 对 botToken 做 SHA-256，返回小写 hex 字符串。
/// bot_accounts.bot_token_hash 列存的就是这个值。
pub fn hash_bot_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// 生成新的 botToken：`agb_<128-bit hex>`。明文仅在签发时返回一次，
/// 服务端只持久化其 SHA-256（见 [`hash_bot_token`]）。
pub fn generate_bot_token() -> String {
    format!("{BOT_TOKEN_PREFIX}{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
