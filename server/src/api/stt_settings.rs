//! Admin-only speech-to-text settings endpoints.
//!
//! The STT endpoint/key are instance-wide runtime settings (system_settings),
//! editable only by admins — configuration is the one place that decides where
//! channel audio may be sent, so it stays centrally governed and auditable.

use axum::{extract::State, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    api::middleware::Claims,
    app_state::AppState,
    domain::stt_settings::{self, SttSettingsUpdate},
    errors::AppError,
    infra::{crypto, stt},
};

fn is_admin(claims: &Claims) -> bool {
    matches!(claims.role.as_str(), "system_admin" | "admin")
}

fn master_key(state: &AppState) -> [u8; 32] {
    crypto::derive_master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    )
}

/// GET /api/v1/admin/settings/stt — current settings with the API key masked.
pub async fn get_settings(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    let settings = stt_settings::load(&state.db, &master_key(&state)).await?;
    Ok(Json(stt_settings::masked_dto(&settings)))
}

#[derive(Deserialize)]
pub struct PutSettingsRequest {
    pub enabled: bool,
    pub endpoint: String,
    pub model: String,
    /// Omitted = keep the stored key; "" = clear; anything else = replace.
    #[serde(default)]
    pub api_key: Option<String>,
}

/// PUT /api/v1/admin/settings/stt — upsert; takes effect on the worker's next
/// poll cycle (no restart).
pub async fn put_settings(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<PutSettingsRequest>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    let endpoint = req.endpoint.trim();
    if req.enabled {
        if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
            return Err(AppError::BadRequest(
                "endpoint must be an http(s) URL, e.g. https://api.openai.com/v1".into(),
            ));
        }
        if req.model.trim().is_empty() {
            return Err(AppError::BadRequest("model is required when enabled".into()));
        }
    }
    let key = master_key(&state);
    stt_settings::save(
        &state.db,
        &key,
        SttSettingsUpdate {
            enabled: req.enabled,
            endpoint: endpoint.to_string(),
            model: req.model.trim().to_string(),
            api_key: req.api_key,
        },
    )
    .await?;
    let settings = stt_settings::load(&state.db, &key).await?;
    Ok(Json(stt_settings::masked_dto(&settings)))
}

/// POST /api/v1/admin/settings/stt/test — send a built-in half-second silence
/// WAV through the SAVED settings and report the outcome. Save first, then test.
pub async fn test_settings(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Value>, AppError> {
    if !is_admin(&claims) {
        return Err(AppError::Forbidden("admin only".into()));
    }
    let settings = stt_settings::load(&state.db, &master_key(&state))
        .await?
        .filter(|s| !s.endpoint.is_empty())
        .ok_or_else(|| AppError::BadRequest("save STT settings before testing".into()))?;

    let http = stt::build_client();
    match stt::transcribe(
        &http,
        &settings.endpoint,
        settings.api_key.as_deref(),
        &settings.model,
        "connectivity-test.wav",
        stt::silence_wav(),
    )
    .await
    {
        Ok(text) => Ok(Json(json!({ "ok": true, "transcript": text }))),
        Err(e) => Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
    }
}
