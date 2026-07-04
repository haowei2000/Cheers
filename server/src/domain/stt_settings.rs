//! Instance-level speech-to-text settings (admin-configured, stored in
//! `system_settings` under key `stt`, hot-reloaded by the transcription worker
//! each poll cycle — no restart needed).
//!
//! The API key is encrypted at rest (AES-256-GCM via `infra::crypto`); only the
//! ciphertext ever touches the database, and reads for the admin UI mask it.

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::errors::AppError;
use crate::infra::crypto;

const SETTINGS_KEY: &str = "stt";

/// Decrypted, worker-facing settings. `api_key` is the plaintext key (None when
/// not set or when decryption failed after a master-key change).
#[derive(Debug, Clone)]
pub struct SttSettings {
    pub enabled: bool,
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
}

/// Admin-facing update payload. `api_key: None` keeps the stored key;
/// `Some("")` clears it; `Some(key)` replaces it.
#[derive(Debug)]
pub struct SttSettingsUpdate {
    pub enabled: bool,
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
}

/// Load and decrypt the settings. `None` when never configured. A key that no
/// longer decrypts (master key rotated) degrades to `api_key: None` with a log —
/// the admin UI shows the key as unset and asks for re-entry.
pub async fn load(db: &PgPool, master_key: &[u8; 32]) -> Result<Option<SttSettings>, AppError> {
    let value = sqlx::query_scalar::<_, Value>("SELECT value FROM system_settings WHERE key = $1")
        .bind(SETTINGS_KEY)
        .fetch_optional(db)
        .await?;
    let Some(value) = value else {
        return Ok(None);
    };

    let api_key = value
        .get("api_key_enc")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .and_then(|blob| match crypto::decrypt_secret(master_key, blob) {
            Ok(key) => Some(key),
            Err(e) => {
                tracing::warn!(err = %e, "stt api key decrypt failed; treating as unset");
                None
            }
        });

    Ok(Some(SttSettings {
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        endpoint: value
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: value
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        api_key,
    }))
}

/// Persist the settings (upsert). Encrypts a newly-provided key; keeps the
/// existing ciphertext when `api_key` is `None`; clears it on `Some("")`.
pub async fn save(
    db: &PgPool,
    master_key: &[u8; 32],
    update: SttSettingsUpdate,
) -> Result<(), AppError> {
    let existing_enc =
        sqlx::query_scalar::<_, Value>("SELECT value FROM system_settings WHERE key = $1")
            .bind(SETTINGS_KEY)
            .fetch_optional(db)
            .await?
            .and_then(|v| {
                v.get("api_key_enc")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            });

    let api_key_enc = match update.api_key.as_deref() {
        None => existing_enc,
        Some("") => None,
        Some(key) => Some(
            crypto::encrypt_secret(master_key, key.trim())
                .map_err(|e| AppError::Internal(format!("encrypt api key: {e}")))?,
        ),
    };

    let value = json!({
        "enabled": update.enabled,
        "endpoint": update.endpoint.trim(),
        "model": update.model.trim(),
        "api_key_enc": api_key_enc,
    });

    sqlx::query(
        "INSERT INTO system_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(SETTINGS_KEY)
    .bind(&value)
    .execute(db)
    .await?;
    Ok(())
}

/// Admin-UI DTO: everything except the key, which is reduced to set/unset +
/// a short tail hint (`***abc1`) so the admin can tell WHICH key is stored
/// without the response ever carrying usable credentials.
pub fn masked_dto(settings: &Option<SttSettings>) -> Value {
    match settings {
        None => json!({
            "configured": false,
            "enabled": false,
            "endpoint": "",
            "model": "",
            "api_key_set": false,
            "api_key_hint": null,
        }),
        Some(s) => json!({
            "configured": true,
            "enabled": s.enabled,
            "endpoint": s.endpoint,
            "model": s.model,
            "api_key_set": s.api_key.is_some(),
            "api_key_hint": s.api_key.as_deref().map(key_hint),
        }),
    }
}

fn key_hint(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("***{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 掩码 DTO 永不携带可用密钥：只有 set 标记 + 尾 4 位提示。
    #[test]
    fn masked_dto_never_leaks_key() {
        let settings = Some(SttSettings {
            enabled: true,
            endpoint: "https://api.openai.com/v1".into(),
            model: "whisper-1".into(),
            api_key: Some("sk-verysecret1234".into()),
        });
        let dto = masked_dto(&settings);
        let rendered = dto.to_string();
        assert!(!rendered.contains("verysecret"));
        assert_eq!(dto["api_key_hint"], "***1234");
        assert_eq!(dto["api_key_set"], true);
    }

    /// 未配置 → configured=false 的空表单形状。
    #[test]
    fn masked_dto_unconfigured() {
        let dto = masked_dto(&None);
        assert_eq!(dto["configured"], false);
        assert_eq!(dto["api_key_set"], false);
    }
}
