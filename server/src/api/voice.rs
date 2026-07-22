//! Real-time voice control plane.
//!
//! Media never traverses the gateway. This module authorizes channel members,
//! reserves a durable Cheers voice session, and mints a short-lived LiveKit join
//! token whose grants are limited to one room and microphone audio.

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    Extension, Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use livekit_api::services::LiveKitApi;
use livekit_protocol::CreateAgentDispatchRequest;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

use crate::{
    api::middleware::Claims as BrowserClaims,
    app_state::AppState,
    domain::channel_seq,
    domain::stt_settings,
    domain::voice_config::VoiceConfig,
    errors::AppError,
    gateway::realtime::frame::WireFrame,
    infra::{crypto, stt},
};

const JOIN_TOKEN_TTL_SECS: i64 = 10 * 60;
const MAX_TRANSCRIPT_CHARS: usize = 8_000;
const MAX_SEGMENT_DURATION_MS: i64 = 5 * 60 * 1_000;
const TRANSCRIBER_AGENT_NAME: &str = "cheers-transcriber";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoGrant {
    room: String,
    room_join: bool,
    can_subscribe: bool,
    can_publish: bool,
    can_publish_data: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    can_publish_sources: Vec<String>,
    can_update_own_metadata: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct LiveKitClaims {
    iss: String,
    sub: String,
    name: String,
    nbf: i64,
    exp: i64,
    video: VideoGrant,
    metadata: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LiveKitWebhookClaims {
    iss: String,
    exp: i64,
    #[serde(default)]
    nbf: i64,
    sha256: String,
}

#[derive(Debug, Serialize)]
pub struct VoiceJoinResponse {
    pub url: String,
    pub token: String,
    pub room_name: String,
    pub voice_session_id: String,
    pub participant_identity: String,
    pub can_publish: bool,
    pub expires_at: i64,
}

#[derive(Debug, Serialize)]
pub struct VoiceStateResponse {
    pub enabled: bool,
    pub channel_kind: String,
    /// Authoritative per-request permission for caption controls. The channel
    /// list may be restored from a client cache, so it cannot be the only
    /// source of truth for this decision.
    pub can_manage: bool,
    pub session: Option<VoiceSessionDto>,
}

#[derive(Debug, Serialize)]
pub struct VoiceSessionDto {
    pub voice_session_id: String,
    pub status: String,
    pub transcription_status: String,
    pub started_at: String,
}

#[derive(Debug, Serialize)]
pub struct VoiceTranscriberContext {
    pub voice_session_id: String,
    pub channel_id: String,
    pub room_name: String,
    pub started_at: String,
}

#[derive(Debug, Serialize)]
pub struct VoiceTranscriptionControlResponse {
    pub voice_session_id: String,
    pub transcription_status: String,
}

/// The composer asks this before opening the microphone. A configured adapter
/// keeps audio server-side; without one the client can fall back to the
/// platform's speech-recognition service without ever uploading audio.
#[derive(Debug, Serialize)]
pub struct DictationCapabilityResponse {
    pub adapter_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_kind: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DictationTranscriptResponse {
    pub transcript: String,
}

/// Response for a consent action (POST/DELETE …/voice/consent). When consent was
/// just granted, `publish_token` lets the client upgrade from listen-only to
/// mic-publishing **without** a full reconnect.
#[derive(Debug, Serialize)]
pub struct VoiceConsentResponse {
    pub consented: bool,
    /// Fresh publishable token, present only when consent was granted.
    pub publish_token: Option<String>,
    /// Mirror of the join response's `can_publish` after this action.
    pub can_publish: bool,
}

/// Stable disclosure version. Bump when the consent copy/policy changes so
/// previously-accepted consent must be re-confirmed.
pub(crate) const CONSENT_VERSION: &str = "v1";

#[derive(Debug, Clone, Serialize)]
pub struct VoicePresenceParticipant {
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub mic_published: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoicePresenceSnapshot {
    pub channel_id: String,
    pub voice_session_id: Option<String>,
    pub status: Option<String>,
    pub participants: Vec<VoicePresenceParticipant>,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptSegmentIngestRequest {
    pub provider_event_id: String,
    pub segment_id: String,
    pub participant_identity: String,
    pub track_id: String,
    pub text: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub language: Option<String>,
    pub confidence: Option<f64>,
    pub finalized_at: String,
    pub supersedes_segment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptSegmentDto {
    pub segment_id: String,
    pub voice_session_id: String,
    pub channel_id: String,
    pub participant_session_id: String,
    pub user_id: String,
    pub provider_segment_id: String,
    pub provider_event_id: String,
    pub track_id: String,
    pub channel_seq: i64,
    pub text: String,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub language: Option<String>,
    pub confidence: Option<f64>,
    pub supersedes_segment_id: Option<String>,
    pub finalized_at: String,
    pub created_at: String,
    /// Soft-delete timestamp; Some(...) = segment content has been removed but
    /// claim audit attribution is retained (design §12).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptListQuery {
    pub after_seq: Option<i64>,
    pub limit: Option<i64>,
}

pub(crate) struct VoiceMember {
    pub(crate) channel_kind: String,
    pub(crate) channel_role: String,
    pub(crate) display_name: String,
}

fn can_manage_voice(member: &VoiceMember, claims: &BrowserClaims) -> bool {
    matches!(member.channel_role.as_str(), "owner" | "admin")
        || matches!(claims.role.as_str(), "system_admin" | "admin")
}

fn stt_master_key(state: &AppState) -> [u8; 32] {
    crypto::derive_master_key(
        state.config.secret_store_key.as_deref(),
        &state.config.jwt_private_key_pem,
    )
}

async fn configured_dictation_adapter(
    state: &AppState,
) -> Result<Option<stt_settings::SttSettings>, AppError> {
    Ok(stt_settings::load(&state.db, &stt_master_key(state))
        .await?
        .filter(|settings| {
            settings.enabled
                && !settings.endpoint.trim().is_empty()
                && !settings.model.trim().is_empty()
        }))
}

async fn transcribe_stepfun_dictation(
    api_key: &str,
    url: &str,
    model: &str,
    language: Option<&str>,
    pcm: &[u8],
) -> Result<String, AppError> {
    let mut transcription = json!({ "model": model, "enable_itn": true });
    if let Some(language) = language.filter(|value| !value.trim().is_empty()) {
        transcription["language"] = json!(language);
    }
    let payload = json!({
        "audio": {
            "data": BASE64.encode(pcm),
            "input": {
                "transcription": transcription,
                "format": {
                    "type": "pcm",
                    "codec": "pcm_s16le",
                    "rate": 16000,
                    "bits": 16,
                    "channel": 1,
                },
            },
        },
    });
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| AppError::ServiceUnavailable("could not create speech adapter client".into()))?
        .post(url)
        .bearer_auth(api_key)
        .header("Accept", "text/event-stream")
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(%error, "StepFun dictation request failed");
            AppError::ServiceUnavailable(
                "configured speech adapter could not transcribe audio".into(),
            )
        })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let body_snippet: String = body.chars().take(500).collect();
        tracing::warn!(%status, body = %body_snippet, "StepFun dictation rejected request");
        return Err(AppError::ServiceUnavailable(
            "configured speech adapter could not transcribe audio".into(),
        ));
    }
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
            continue;
        };
        if event.get("type").and_then(serde_json::Value::as_str) == Some("error") {
            tracing::warn!(message = ?event.get("message"), "StepFun dictation returned error event");
            return Err(AppError::ServiceUnavailable(
                "configured speech adapter could not transcribe audio".into(),
            ));
        }
        if event.get("type").and_then(serde_json::Value::as_str) == Some("transcript.text.done") {
            return Ok(event
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string());
        }
    }
    Err(AppError::ServiceUnavailable(
        "configured speech adapter returned no final transcript".into(),
    ))
}

pub(crate) async fn voice_member(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> Result<VoiceMember, AppError> {
    let row = sqlx::query(
        "SELECT c.kind,
                cm.role AS channel_role,
                COALESCE(NULLIF(u.display_name, ''), u.username, 'Member') AS display_name
         FROM channels c
         JOIN channel_memberships cm ON cm.channel_id = c.channel_id
              AND cm.member_id = $2 AND cm.member_type = 'user'
         JOIN users u ON u.user_id = cm.member_id
         WHERE c.channel_id = $1",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Forbidden("active channel membership required".into()))?;

    Ok(VoiceMember {
        channel_kind: row.try_get("kind").unwrap_or_else(|_| "text".into()),
        channel_role: row
            .try_get("channel_role")
            .unwrap_or_else(|_| "member".into()),
        display_name: row
            .try_get("display_name")
            .unwrap_or_else(|_| "Member".into()),
    })
}

fn room_name(channel_id: &str) -> String {
    // Channel ids are validated UUIDs before this runs; keep the provider name
    // opaque and deterministic so the first join can auto-create the room.
    format!("cheers-{channel_id}")
}

fn mint_join_token(
    api_key: &str,
    api_secret: &str,
    identity: &str,
    display_name: &str,
    room: &str,
    user_id: &str,
    can_publish: bool,
    now: i64,
) -> Result<(String, i64), AppError> {
    let exp = now + JOIN_TOKEN_TTL_SECS;
    let claims = LiveKitClaims {
        iss: api_key.to_string(),
        sub: identity.to_string(),
        name: display_name.to_string(),
        nbf: now.saturating_sub(5),
        exp,
        video: VideoGrant {
            room: room.to_string(),
            room_join: true,
            can_subscribe: true,
            can_publish,
            can_publish_data: false,
            can_publish_sources: if can_publish {
                vec!["microphone".into()]
            } else {
                Vec::new()
            },
            can_update_own_metadata: false,
        },
        // Non-authoritative and deliberately contains no email or bearer token.
        metadata: json!({ "cheers_user_id": user_id }).to_string(),
    };
    let mut header = Header::new(Algorithm::HS256);
    header.typ = Some("JWT".into());
    encode(
        &header,
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )
    .map(|token| (token, exp))
    .map_err(|e| AppError::Internal(format!("livekit token signing failed: {e}")))
}

/// POST /api/v1/channels/:channel_id/voice/join
pub async fn join(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<VoiceJoinResponse>, AppError> {
    Uuid::parse_str(&channel_id).map_err(|_| AppError::BadRequest("invalid channel id".into()))?;
    let member = voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" {
        return Err(AppError::BadRequest(
            "channel is not a voice channel".into(),
        ));
    }
    let (url, api_key, api_secret) = state
        .config
        .livekit()
        .ok_or_else(|| AppError::ServiceUnavailable("real-time voice is not configured".into()))?;

    let provider_room_id = room_name(&channel_id);
    let mut tx = state.db.begin().await?;
    let session_id = Uuid::new_v4().to_string();
    let row = sqlx::query(
        "INSERT INTO voice_sessions
            (voice_session_id, channel_id, provider, provider_room_id, status)
         VALUES ($1, $2, 'livekit', $3, 'starting')
         ON CONFLICT (channel_id) WHERE ended_at IS NULL
         DO UPDATE SET updated_at = NOW()
         RETURNING voice_session_id",
    )
    .bind(&session_id)
    .bind(&channel_id)
    .bind(&provider_room_id)
    .fetch_one(&mut *tx)
    .await?;
    let voice_session_id: String = row.try_get("voice_session_id").unwrap_or(session_id);

    let connection_nonce = Uuid::new_v4().to_string();
    let participant_session_id = Uuid::new_v4().to_string();
    let identity = format!(
        "cheers:{}:{}:{}",
        voice_session_id, claims.sub, connection_nonce
    );
    // Consent gating: when the channel requires explicit consent, the first join
    // completes listen-only (can_publish=false) until the participant accepts
    // the disclosure. We record `consent_version` at first join so later
    // policy-version bumps can force re-consent.
    let config = VoiceConfig::load(&state.db, &channel_id).await?;
    // A participant row exists after a listen-only join, but its consent is
    // deliberately NULL until the disclosure is accepted. Decode both "no
    // participant row" and "participant row with NULL consent" safely.
    let existing_consent: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT consent_version FROM voice_participant_sessions
                            WHERE user_id = $1 AND voice_session_id = $2",
    )
    .bind(&claims.sub)
    .bind(&voice_session_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let has_consent = existing_consent.as_deref() == Some(CONSENT_VERSION);
    sqlx::query(
        "INSERT INTO voice_participant_sessions
            (participant_session_id, voice_session_id, user_id, provider_identity,
             connection_nonce, consent_version)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(participant_session_id)
    .bind(&voice_session_id)
    .bind(&claims.sub)
    .bind(&identity)
    .bind(connection_nonce)
    .bind(if has_consent {
        Some(CONSENT_VERSION)
    } else {
        None
    })
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // readonly members may listen but cannot publish a microphone track; explicit
    // consent mode additionally gates publishing until the participant accepts.
    let consent_blocks_publish =
        config.consent_mode == crate::domain::voice_config::ConsentMode::Explicit && !has_consent;
    let can_publish = member.channel_role != "readonly" && !consent_blocks_publish;
    let (token, expires_at) = mint_join_token(
        api_key,
        api_secret,
        &identity,
        &member.display_name,
        &provider_room_id,
        &claims.sub,
        can_publish,
        Utc::now().timestamp(),
    )?;

    Ok(Json(VoiceJoinResponse {
        url: url.to_string(),
        token,
        room_name: provider_room_id,
        voice_session_id,
        participant_identity: identity,
        can_publish,
        expires_at,
    }))
}

/// GET /api/v1/channels/:channel_id/voice/state
pub async fn state(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<VoiceStateResponse>, AppError> {
    Uuid::parse_str(&channel_id).map_err(|_| AppError::BadRequest("invalid channel id".into()))?;
    let member = voice_member(&state, &channel_id, &claims.sub).await?;
    let row = sqlx::query(
        "SELECT voice_session_id, status, transcription_status, started_at
         FROM voice_sessions
         WHERE channel_id = $1 AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&channel_id)
    .fetch_optional(&state.db)
    .await?;

    let session = row.map(|r| VoiceSessionDto {
        voice_session_id: r.try_get("voice_session_id").unwrap_or_default(),
        status: r.try_get("status").unwrap_or_else(|_| "starting".into()),
        transcription_status: r
            .try_get("transcription_status")
            .unwrap_or_else(|_| "off".into()),
        started_at: r
            .try_get::<chrono::DateTime<Utc>, _>("started_at")
            .map(|v| v.to_rfc3339())
            .unwrap_or_default(),
    });

    let can_manage = can_manage_voice(&member, &claims);
    Ok(Json(VoiceStateResponse {
        enabled: state.config.livekit().is_some(),
        channel_kind: member.channel_kind,
        can_manage,
        session,
    }))
}

/// GET /api/v1/channels/:channel_id/voice/dictation-capability
pub async fn dictation_capability(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<DictationCapabilityResponse>, AppError> {
    // Dictation is available in both text and voice channels, but it is always
    // scoped to a current member so arbitrary callers cannot use this endpoint
    // as a shared transcription proxy.
    voice_member(&state, &channel_id, &claims.sub).await?;
    if state.config.stepfun_dictation().is_some() {
        return Ok(Json(DictationCapabilityResponse {
            adapter_configured: true,
            adapter_kind: Some("stepfun".into()),
        }));
    }
    let adapter = configured_dictation_adapter(&state).await?;
    Ok(Json(DictationCapabilityResponse {
        adapter_configured: adapter.is_some(),
        adapter_kind: adapter.map(|_| "openai".into()),
    }))
}

/// POST /api/v1/channels/:channel_id/voice/dictation
///
/// The browser sends a short WebM/Opus utterance only when an administrator has
/// configured an instance STT adapter. The transcript is returned to the caller
/// and is not persisted as a message, attachment, or voice-channel transcript.
pub async fn dictate(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
    audio: Bytes,
) -> Result<Json<DictationTranscriptResponse>, AppError> {
    voice_member(&state, &channel_id, &claims.sub).await?;
    if audio.is_empty() {
        return Err(AppError::BadRequest(
            "record a short utterance first".into(),
        ));
    }
    if audio.len() > 8 * 1024 * 1024 {
        return Err(AppError::PayloadTooLarge(
            "dictation audio must be 8 MB or smaller".into(),
        ));
    }
    let text = if let Some((api_key, url, model, language)) = state.config.stepfun_dictation() {
        transcribe_stepfun_dictation(api_key, url, model, language, &audio).await?
    } else {
        let settings = configured_dictation_adapter(&state)
            .await?
            .ok_or_else(|| AppError::Conflict("no speech adapter is configured".into()))?;
        stt::transcribe(
            &stt::build_client(),
            &settings.endpoint,
            settings.api_key.as_deref(),
            &settings.model,
            "dictation.webm",
            audio.to_vec(),
        )
        .await
        .map_err(|error| {
            tracing::warn!(%channel_id, error = %error, "composer dictation failed");
            AppError::ServiceUnavailable(
                "configured speech adapter could not transcribe audio".into(),
            )
        })?
    };
    Ok(Json(DictationTranscriptResponse { transcript: text }))
}

fn livekit_api_host(url: &str) -> Result<String, AppError> {
    if let Some(rest) = url.strip_prefix("wss://") {
        return Ok(format!("https://{rest}"));
    }
    if let Some(rest) = url.strip_prefix("ws://") {
        return Ok(format!("http://{rest}"));
    }
    if url.starts_with("https://") || url.starts_with("http://") {
        return Ok(url.to_string());
    }
    Err(AppError::ServiceUnavailable(
        "invalid LiveKit server URL".into(),
    ))
}

async fn broadcast_transcription_status(
    state: &AppState,
    channel_id: Uuid,
    voice_session_id: &str,
    status: &str,
) {
    state
        .fanout
        .broadcast_channel(
            channel_id,
            WireFrame::channel(
                channel_id,
                "voice_transcription_updated",
                json!({
                    "voice_session_id": voice_session_id,
                    "transcription_status": status,
                }),
            ),
        )
        .await;
}

/// POST /api/v1/channels/:channel_id/voice/transcription/start
pub async fn start_transcription(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<VoiceTranscriptionControlResponse>, AppError> {
    let channel_uuid = Uuid::parse_str(&channel_id)
        .map_err(|_| AppError::BadRequest("invalid channel id".into()))?;
    let member = voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" || !can_manage_voice(&member, &claims) {
        return Err(AppError::Forbidden(
            "channel owner or admin is required to start transcription".into(),
        ));
    }
    let (_url, api_key, api_secret) = state
        .config
        .livekit()
        .ok_or_else(|| AppError::ServiceUnavailable("real-time voice is not configured".into()))?;
    let api_url = state
        .config
        .livekit_api_url()
        .ok_or_else(|| AppError::ServiceUnavailable("real-time voice is not configured".into()))?;

    let mut tx = state.db.begin().await?;
    let row = sqlx::query(
        "SELECT voice_session_id, provider_room_id, transcription_status, started_at,
                transcriber_dispatch_id
         FROM voice_sessions
         WHERE channel_id = $1 AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(&channel_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::Conflict("join the voice channel before starting transcription".into())
    })?;
    let voice_session_id: String = row.try_get("voice_session_id")?;
    let current_status: String = row.try_get("transcription_status")?;
    let dispatch_id: Option<String> = row.try_get("transcriber_dispatch_id").ok().flatten();
    if matches!(current_status.as_str(), "starting" | "active") && dispatch_id.is_some() {
        tx.commit().await?;
        return Ok(Json(VoiceTranscriptionControlResponse {
            voice_session_id,
            transcription_status: current_status,
        }));
    }
    let pending_dispatch_id = format!("pending:{}", Uuid::new_v4());
    sqlx::query(
        "UPDATE voice_sessions
         SET transcription_status = 'starting', transcriber_dispatch_id = $2, updated_at = NOW()
         WHERE voice_session_id = $1",
    )
    .bind(&voice_session_id)
    .bind(&pending_dispatch_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let provider_room_id: String = row.try_get("provider_room_id")?;
    let started_at: chrono::DateTime<Utc> = row.try_get("started_at")?;
    let metadata = json!({
        "voice_session_id": voice_session_id,
        "channel_id": channel_id,
        "started_at": started_at.to_rfc3339(),
    })
    .to_string();
    let api = LiveKitApi::with_api_key(&livekit_api_host(api_url)?, api_key, api_secret);
    let dispatch = api
        .agent_dispatch()
        .create_dispatch(CreateAgentDispatchRequest {
            room: provider_room_id,
            agent_name: TRANSCRIBER_AGENT_NAME.into(),
            metadata,
            ..Default::default()
        })
        .await;
    let dispatch = match dispatch {
        Ok(value) => value,
        Err(error) => {
            sqlx::query(
                "UPDATE voice_sessions
                 SET transcription_status = 'failed', transcriber_dispatch_id = NULL,
                     updated_at = NOW()
                 WHERE voice_session_id = $1 AND transcriber_dispatch_id = $2",
            )
            .bind(&voice_session_id)
            .bind(&pending_dispatch_id)
            .execute(&state.db)
            .await?;
            broadcast_transcription_status(&state, channel_uuid, &voice_session_id, "failed").await;
            tracing::warn!(%channel_id, %voice_session_id, %error, "LiveKit transcriber dispatch failed");
            return Err(AppError::ServiceUnavailable(
                "transcription worker is unavailable".into(),
            ));
        }
    };
    sqlx::query(
        "UPDATE voice_sessions
         SET transcriber_dispatch_id = $2, transcription_status = 'active', updated_at = NOW()
         WHERE voice_session_id = $1 AND transcriber_dispatch_id = $3",
    )
    .bind(&voice_session_id)
    .bind(dispatch.id)
    .bind(&pending_dispatch_id)
    .execute(&state.db)
    .await?;
    broadcast_transcription_status(&state, channel_uuid, &voice_session_id, "active").await;
    Ok(Json(VoiceTranscriptionControlResponse {
        voice_session_id,
        transcription_status: "active".into(),
    }))
}

/// POST /api/v1/channels/:channel_id/voice/transcription/stop
pub async fn stop_transcription(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<VoiceTranscriptionControlResponse>, AppError> {
    let channel_uuid = Uuid::parse_str(&channel_id)
        .map_err(|_| AppError::BadRequest("invalid channel id".into()))?;
    let member = voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" || !can_manage_voice(&member, &claims) {
        return Err(AppError::Forbidden(
            "channel owner or admin is required to stop transcription".into(),
        ));
    }
    let (_url, api_key, api_secret) = state
        .config
        .livekit()
        .ok_or_else(|| AppError::ServiceUnavailable("real-time voice is not configured".into()))?;
    let api_url = state
        .config
        .livekit_api_url()
        .ok_or_else(|| AppError::ServiceUnavailable("real-time voice is not configured".into()))?;
    let row = sqlx::query(
        "SELECT voice_session_id, provider_room_id, transcriber_dispatch_id
         FROM voice_sessions
         WHERE channel_id = $1 AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&channel_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Conflict("no active voice session".into()))?;
    let voice_session_id: String = row.try_get("voice_session_id")?;
    let provider_room_id: String = row.try_get("provider_room_id")?;
    let dispatch_id: Option<String> = row.try_get("transcriber_dispatch_id").ok().flatten();
    if let Some(dispatch_id) = dispatch_id {
        if dispatch_id.starts_with("pending:") {
            return Err(AppError::Conflict(
                "transcription is still starting; try again shortly".into(),
            ));
        }
        let api = LiveKitApi::with_api_key(&livekit_api_host(api_url)?, api_key, api_secret);
        api.agent_dispatch()
            .delete_dispatch(dispatch_id, provider_room_id)
            .await
            .map_err(|error| {
                tracing::warn!(%channel_id, %voice_session_id, %error, "LiveKit transcriber stop failed");
                AppError::ServiceUnavailable("could not stop transcription worker".into())
            })?;
    }
    sqlx::query(
        "UPDATE voice_sessions
         SET transcriber_dispatch_id = NULL, transcription_status = 'off', updated_at = NOW()
         WHERE voice_session_id = $1",
    )
    .bind(&voice_session_id)
    .execute(&state.db)
    .await?;
    broadcast_transcription_status(&state, channel_uuid, &voice_session_id, "off").await;
    Ok(Json(VoiceTranscriptionControlResponse {
        voice_session_id,
        transcription_status: "off".into(),
    }))
}

fn presence_snapshots(rows: Vec<sqlx::postgres::PgRow>) -> Vec<VoicePresenceSnapshot> {
    let mut snapshots = Vec::<VoicePresenceSnapshot>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for row in rows {
        let channel_id: String = row.try_get("channel_id").unwrap_or_default();
        let index = *indexes.entry(channel_id.clone()).or_insert_with(|| {
            let index = snapshots.len();
            snapshots.push(VoicePresenceSnapshot {
                channel_id,
                voice_session_id: row.try_get("voice_session_id").ok(),
                status: row.try_get("status").ok(),
                participants: Vec::new(),
            });
            index
        });
        let Some(user_id) = row.try_get::<Option<String>, _>("user_id").ok().flatten() else {
            continue;
        };
        snapshots[index]
            .participants
            .push(VoicePresenceParticipant {
                user_id,
                display_name: row
                    .try_get::<Option<String>, _>("display_name")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "Member".into()),
                avatar_url: row
                    .try_get::<Option<String>, _>("avatar_url")
                    .ok()
                    .flatten(),
                mic_published: row
                    .try_get::<Option<chrono::DateTime<Utc>>, _>("mic_published_at")
                    .ok()
                    .flatten()
                    .is_some(),
            });
    }
    snapshots
}

/// GET /api/v1/voice/presence
///
/// Initial app-wide occupancy snapshot for every active voice session visible to
/// the caller. Subsequent changes arrive as user-scoped `voice_presence` frames.
pub async fn presence(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
) -> Result<Json<Vec<VoicePresenceSnapshot>>, AppError> {
    let rows = sqlx::query(
        "SELECT vs.channel_id, vs.voice_session_id, vs.status,
                vps.user_id,
                COALESCE(NULLIF(u.display_name, ''), u.username, 'Member') AS display_name,
                u.avatar_url, vps.mic_published_at
         FROM voice_sessions vs
         JOIN channels c ON c.channel_id = vs.channel_id AND c.kind = 'voice'
         JOIN channel_memberships viewer ON viewer.channel_id = vs.channel_id
              AND viewer.member_id = $1 AND viewer.member_type = 'user'
         LEFT JOIN voice_participant_sessions vps ON vps.voice_session_id = vs.voice_session_id
              AND vps.joined_at IS NOT NULL AND vps.left_at IS NULL
         LEFT JOIN users u ON u.user_id = vps.user_id
         WHERE vs.ended_at IS NULL
         ORDER BY vs.channel_id, vps.joined_at, vps.participant_session_id",
    )
    .bind(&claims.sub)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(presence_snapshots(rows)))
}

async fn channel_presence_snapshot(
    state: &AppState,
    channel_id: Uuid,
) -> Result<VoicePresenceSnapshot, AppError> {
    let rows = sqlx::query(
        "SELECT vs.channel_id, vs.voice_session_id, vs.status,
                vps.user_id,
                COALESCE(NULLIF(u.display_name, ''), u.username, 'Member') AS display_name,
                u.avatar_url, vps.mic_published_at
         FROM voice_sessions vs
         LEFT JOIN voice_participant_sessions vps ON vps.voice_session_id = vs.voice_session_id
              AND vps.joined_at IS NOT NULL AND vps.left_at IS NULL
         LEFT JOIN users u ON u.user_id = vps.user_id
         WHERE vs.channel_id = $1 AND vs.ended_at IS NULL
         ORDER BY vps.joined_at, vps.participant_session_id",
    )
    .bind(channel_id.to_string())
    .fetch_all(&state.db)
    .await?;
    Ok(presence_snapshots(rows)
        .into_iter()
        .next()
        .unwrap_or(VoicePresenceSnapshot {
            channel_id: channel_id.to_string(),
            voice_session_id: None,
            status: None,
            participants: Vec::new(),
        }))
}

async fn broadcast_voice_presence(state: &AppState, channel_id: Uuid) {
    let snapshot = match channel_presence_snapshot(state, channel_id).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::warn!(%channel_id, %error, "voice presence snapshot failed");
            return;
        }
    };
    let member_ids: Vec<String> = sqlx::query_scalar(
        "SELECT member_id FROM channel_memberships
         WHERE channel_id = $1 AND member_type = 'user'",
    )
    .bind(channel_id.to_string())
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    let data = serde_json::to_value(snapshot).unwrap_or_else(|_| json!({}));
    for member_id in member_ids {
        if let Ok(user_id) = Uuid::parse_str(&member_id) {
            state
                .fanout
                .broadcast_user(user_id, WireFrame::user("voice_presence", data.clone()))
                .await;
        }
    }
}

fn transcriber_authorized(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expected = state
        .config
        .voice_transcriber_token
        .as_deref()
        .ok_or_else(|| {
            AppError::ServiceUnavailable("voice transcriber is not configured".into())
        })?;
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Unauthorized("missing voice transcriber token".into()))?;
    // Compare fixed-size digests so mismatch timing does not reveal token bytes.
    let expected_hash = Sha256::digest(expected.as_bytes());
    let provided_hash = Sha256::digest(provided.as_bytes());
    let different = expected_hash
        .iter()
        .zip(provided_hash.iter())
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right));
    if different != 0 {
        return Err(AppError::Unauthorized(
            "invalid voice transcriber token".into(),
        ));
    }
    Ok(())
}

pub(crate) fn transcript_dto(row: sqlx::postgres::PgRow) -> TranscriptSegmentDto {
    TranscriptSegmentDto {
        segment_id: row.try_get("segment_id").unwrap_or_default(),
        voice_session_id: row.try_get("voice_session_id").unwrap_or_default(),
        channel_id: row.try_get("channel_id").unwrap_or_default(),
        participant_session_id: row.try_get("participant_session_id").unwrap_or_default(),
        user_id: row.try_get("user_id").unwrap_or_default(),
        provider_segment_id: row.try_get("provider_segment_id").unwrap_or_default(),
        provider_event_id: row.try_get("provider_event_id").unwrap_or_default(),
        track_id: row.try_get("track_id").unwrap_or_default(),
        channel_seq: row.try_get("channel_seq").unwrap_or_default(),
        text: row.try_get("text").unwrap_or_default(),
        started_at_ms: row.try_get("started_at_ms").unwrap_or_default(),
        ended_at_ms: row.try_get("ended_at_ms").unwrap_or_default(),
        language: row.try_get("language").ok(),
        confidence: row.try_get("confidence").ok(),
        supersedes_segment_id: row.try_get("supersedes_segment_id").ok(),
        finalized_at: row
            .try_get::<chrono::DateTime<Utc>, _>("finalized_at")
            .map(|value| value.to_rfc3339())
            .unwrap_or_default(),
        created_at: row
            .try_get::<chrono::DateTime<Utc>, _>("created_at")
            .map(|value| value.to_rfc3339())
            .unwrap_or_default(),
        deleted_at: row
            .try_get::<Option<chrono::DateTime<Utc>>, _>("deleted_at")
            .ok()
            .flatten()
            .map(|value| value.to_rfc3339()),
    }
}

struct ValidTranscript {
    text: String,
    language: Option<String>,
    confidence: Option<String>,
    finalized_at: chrono::DateTime<Utc>,
}

fn validate_transcript(body: &TranscriptSegmentIngestRequest) -> Result<ValidTranscript, AppError> {
    for (label, value) in [
        ("provider_event_id", body.provider_event_id.trim()),
        ("segment_id", body.segment_id.trim()),
        ("participant_identity", body.participant_identity.trim()),
        ("track_id", body.track_id.trim()),
    ] {
        if value.is_empty() || value.len() > 255 {
            return Err(AppError::BadRequest(format!(
                "{label} must contain 1 to 255 bytes"
            )));
        }
    }
    let text = body.text.trim().to_string();
    if text.is_empty() || text.chars().count() > MAX_TRANSCRIPT_CHARS {
        return Err(AppError::BadRequest(format!(
            "transcript text must contain 1 to {MAX_TRANSCRIPT_CHARS} characters"
        )));
    }
    if body.started_at_ms < 0
        || body.ended_at_ms < body.started_at_ms
        || body.ended_at_ms - body.started_at_ms > MAX_SEGMENT_DURATION_MS
    {
        return Err(AppError::BadRequest(
            "invalid transcript segment timestamps".into(),
        ));
    }
    let language = body
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if language.as_ref().is_some_and(|value| {
        value.len() > 16
            || !value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    }) {
        return Err(AppError::BadRequest("invalid transcript language".into()));
    }
    let confidence = match body.confidence {
        Some(value) if value.is_finite() && (0.0..=1.0).contains(&value) => {
            Some(format!("{value:.3}"))
        }
        Some(_) => {
            return Err(AppError::BadRequest(
                "transcript confidence must be between 0 and 1".into(),
            ));
        }
        None => None,
    };
    let finalized_at = chrono::DateTime::parse_from_rfc3339(&body.finalized_at)
        .map_err(|_| AppError::BadRequest("finalized_at must be RFC3339".into()))?
        .with_timezone(&Utc);
    if finalized_at > Utc::now() + chrono::Duration::minutes(5) {
        return Err(AppError::BadRequest(
            "finalized_at is too far in the future".into(),
        ));
    }
    Ok(ValidTranscript {
        text,
        language,
        confidence,
        finalized_at,
    })
}

pub(crate) const TRANSCRIPT_SELECT: &str =
    "SELECT segment_id, voice_session_id, channel_id, participant_session_id, user_id,
            provider_segment_id, provider_event_id, track_id, channel_seq, text,
            started_at_ms, ended_at_ms, language,
            confidence::double precision AS confidence,
            supersedes_segment_id, finalized_at, created_at, deleted_at
     FROM voice_transcript_segments";

/// POST /internal/v1/voice/sessions/:voice_session_id/transcript-segments
pub async fn ingest_transcript_segment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(voice_session_id): Path<String>,
    Json(body): Json<TranscriptSegmentIngestRequest>,
) -> Result<Json<TranscriptSegmentDto>, AppError> {
    transcriber_authorized(&state, &headers)?;
    Uuid::parse_str(&voice_session_id)
        .map_err(|_| AppError::BadRequest("invalid voice session id".into()))?;
    let valid = validate_transcript(&body)?;

    let speaker = sqlx::query(
        "SELECT vs.channel_id, vs.status, vs.started_at AS session_started_at,
                vps.participant_session_id, vps.user_id, vps.joined_at, vps.left_at
         FROM voice_sessions vs
         JOIN voice_participant_sessions vps ON vps.voice_session_id = vs.voice_session_id
              AND vps.provider_identity = $2 AND vps.provider_track_id = $3
         JOIN channel_memberships cm ON cm.channel_id = vs.channel_id
              AND cm.member_id = vps.user_id AND cm.member_type = 'user'
         WHERE vs.voice_session_id = $1",
    )
    .bind(&voice_session_id)
    .bind(body.participant_identity.trim())
    .bind(body.track_id.trim())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Forbidden("unknown or unauthorized voice participant".into()))?;
    let status: String = speaker.try_get("status").unwrap_or_default();
    if status == "failed" {
        return Err(AppError::BadRequest("voice session has failed".into()));
    }
    let joined_at: chrono::DateTime<Utc> = speaker
        .try_get("joined_at")
        .map_err(|_| AppError::BadRequest("participant never joined the room".into()))?;
    let left_at: Option<chrono::DateTime<Utc>> = speaker.try_get("left_at").ok().flatten();
    let session_started_at: chrono::DateTime<Utc> = speaker.try_get("session_started_at")?;
    let speech_started_at = session_started_at + chrono::Duration::milliseconds(body.started_at_ms);
    let speech_ended_at = session_started_at + chrono::Duration::milliseconds(body.ended_at_ms);
    let grace = chrono::Duration::seconds(30);
    if speech_started_at < joined_at - grace
        || left_at.is_some_and(|left| speech_ended_at > left + grace)
        || valid.finalized_at < speech_ended_at - grace
    {
        return Err(AppError::BadRequest(
            "segment falls outside the participant session".into(),
        ));
    }
    let channel_id: String = speaker.try_get("channel_id")?;
    let channel_uuid = Uuid::parse_str(&channel_id)
        .map_err(|_| AppError::Internal("invalid channel id in voice session".into()))?;
    let participant_session_id: String = speaker.try_get("participant_session_id")?;
    let user_id: String = speaker.try_get("user_id")?;

    let supersedes = match body.supersedes_segment_id.as_deref() {
        Some(value) => {
            Uuid::parse_str(value)
                .map_err(|_| AppError::BadRequest("invalid supersedes_segment_id".into()))?;
            let belongs: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM voice_transcript_segments
                    WHERE segment_id = $1 AND voice_session_id = $2
                 )",
            )
            .bind(value)
            .bind(&voice_session_id)
            .fetch_one(&state.db)
            .await?;
            if !belongs {
                return Err(AppError::BadRequest(
                    "superseded segment is not in this voice session".into(),
                ));
            }
            Some(value.to_string())
        }
        None => None,
    };

    let mut tx = state.db.begin().await?;
    let existing_sql = format!(
        "{TRANSCRIPT_SELECT}
         WHERE voice_session_id = $1
           AND (provider_event_id = $2 OR provider_segment_id = $3)
         ORDER BY created_at LIMIT 1"
    );
    if let Some(row) = sqlx::query(&existing_sql)
        .bind(&voice_session_id)
        .bind(body.provider_event_id.trim())
        .bind(body.segment_id.trim())
        .fetch_optional(&mut *tx)
        .await?
    {
        tx.commit().await?;
        return Ok(Json(transcript_dto(row)));
    }

    let seq = channel_seq::allocate(&mut tx, channel_uuid).await?;
    let segment_id = Uuid::new_v4().to_string();
    let inserted = sqlx::query(
        "INSERT INTO voice_transcript_segments
            (segment_id, voice_session_id, channel_id, participant_session_id, user_id,
             provider_segment_id, provider_event_id, track_id, channel_seq, text,
             started_at_ms, ended_at_ms, language, confidence, supersedes_segment_id,
             finalized_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14::numeric, $15, $16)
         ON CONFLICT DO NOTHING
         RETURNING segment_id, voice_session_id, channel_id, participant_session_id, user_id,
                   provider_segment_id, provider_event_id, track_id, channel_seq, text,
                   started_at_ms, ended_at_ms, language,
                   confidence::double precision AS confidence,
                   supersedes_segment_id, finalized_at, created_at",
    )
    .bind(&segment_id)
    .bind(&voice_session_id)
    .bind(&channel_id)
    .bind(&participant_session_id)
    .bind(&user_id)
    .bind(body.segment_id.trim())
    .bind(body.provider_event_id.trim())
    .bind(body.track_id.trim())
    .bind(seq)
    .bind(&valid.text)
    .bind(body.started_at_ms)
    .bind(body.ended_at_ms)
    .bind(&valid.language)
    .bind(&valid.confidence)
    .bind(&supersedes)
    .bind(valid.finalized_at)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = inserted else {
        tx.rollback().await?;
        let row = sqlx::query(&existing_sql)
            .bind(&voice_session_id)
            .bind(body.provider_event_id.trim())
            .bind(body.segment_id.trim())
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::Conflict("transcript segment conflict".into()))?;
        return Ok(Json(transcript_dto(row)));
    };
    sqlx::query(
        "UPDATE voice_sessions
         SET transcription_status = 'active', updated_at = NOW()
         WHERE voice_session_id = $1 AND transcription_status IN ('off', 'starting')",
    )
    .bind(&voice_session_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let dto = transcript_dto(row);
    let data = serde_json::to_value(&dto).unwrap_or_else(|_| json!({}));
    state
        .fanout
        .broadcast_channel(
            channel_uuid,
            WireFrame::channel(channel_uuid, "voice_transcript_final", data),
        )
        .await;
    Ok(Json(dto))
}

/// GET /internal/v1/voice/rooms/:room_name/context
///
/// A recovering LiveKit worker may only know the provider room name. This
/// authenticated lookup resolves it to the current durable Cheers session and
/// supplies the shared timestamp origin used by transcript segment offsets.
pub async fn transcriber_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_name): Path<String>,
) -> Result<Json<VoiceTranscriberContext>, AppError> {
    transcriber_authorized(&state, &headers)?;
    if room_name.is_empty() || room_name.len() > 255 {
        return Err(AppError::BadRequest("invalid LiveKit room name".into()));
    }
    let row = sqlx::query(
        "SELECT voice_session_id, channel_id, provider_room_id, started_at
         FROM voice_sessions
         WHERE provider = 'livekit' AND provider_room_id = $1 AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&room_name)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(VoiceTranscriberContext {
        voice_session_id: row.try_get("voice_session_id")?,
        channel_id: row.try_get("channel_id")?,
        room_name: row.try_get("provider_room_id")?,
        started_at: row
            .try_get::<chrono::DateTime<Utc>, _>("started_at")?
            .to_rfc3339(),
    }))
}

/// GET /api/v1/channels/:channel_id/voice/transcript
pub async fn transcript(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
    Query(query): Query<TranscriptListQuery>,
) -> Result<Json<Vec<TranscriptSegmentDto>>, AppError> {
    let channel_uuid = Uuid::parse_str(&channel_id)
        .map_err(|_| AppError::BadRequest("invalid channel id".into()))?;
    let member = voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" {
        return Err(AppError::BadRequest(
            "channel is not a voice channel".into(),
        ));
    }
    let after_seq = query.after_seq.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(100).clamp(1, 500);
    let sql = format!(
        "{TRANSCRIPT_SELECT}
         WHERE channel_id = $1 AND channel_seq > $2 AND deleted_at IS NULL
         ORDER BY channel_seq ASC LIMIT $3"
    );
    let rows = sqlx::query(&sql)
        .bind(channel_uuid.to_string())
        .bind(after_seq)
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows.into_iter().map(transcript_dto).collect()))
}

/// POST /api/v1/channels/:channel_id/voice/consent — accept the transcription
/// disclosure for this channel. Records the consent version and returns a
/// publishable token so the client can upgrade from listen-only to mic publish
/// **without a full reconnect** (LiveKit `room.disconnect(true)` + re-connect
/// with the new token, or releasing the held mic track).
pub async fn grant_consent(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<VoiceConsentResponse>, AppError> {
    let member = voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" {
        return Err(AppError::BadRequest(
            "channel is not a voice channel".into(),
        ));
    }
    let Some((_url, api_key, api_secret)) = state.config.livekit() else {
        return Err(AppError::ServiceUnavailable(
            "real-time voice is not configured".into(),
        ));
    };
    let provider_room_id = room_name(&channel_id);

    // Resolve the live session (must be joined already).
    let row = sqlx::query(
        "SELECT voice_session_id FROM voice_sessions
         WHERE channel_id = $1 AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&channel_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Conflict("join the voice channel first".into()))?;
    let voice_session_id: String = row.try_get("voice_session_id")?;

    // Record consent (idempotent) for every participant-session this user has in
    // the session (normally one).
    sqlx::query(
        "UPDATE voice_participant_sessions
         SET consent_version = $1
         WHERE user_id = $2 AND voice_session_id = $3 AND consent_version IS DISTINCT FROM $1",
    )
    .bind(CONSENT_VERSION)
    .bind(&claims.sub)
    .bind(&voice_session_id)
    .execute(&state.db)
    .await?;

    // Re-mint a publishable token against the same identity the client already
    // holds — same `provider_identity` so it maps to the existing participant.
    let identity_row: Option<String> = sqlx::query_scalar(
        "SELECT provider_identity FROM voice_participant_sessions
         WHERE user_id = $1 AND voice_session_id = $2 LIMIT 1",
    )
    .bind(&claims.sub)
    .bind(&voice_session_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(identity) = identity_row else {
        return Err(AppError::Conflict("participant session not found".into()));
    };
    let can_publish = member.channel_role != "readonly";
    let (token, _) = mint_join_token(
        api_key,
        api_secret,
        &identity,
        &member.display_name,
        &provider_room_id,
        &claims.sub,
        can_publish,
        Utc::now().timestamp(),
    )?;

    // Notify the room so other participants see the consent state refresh.
    state
        .fanout
        .broadcast_channel(
            Uuid::parse_str(&channel_id)
                .map_err(|_| AppError::BadRequest("invalid channel id".into()))?,
            WireFrame::channel(
                Uuid::parse_str(&channel_id).unwrap(),
                "voice_consent_updated",
                json!({
                    "voice_session_id": voice_session_id,
                    "user_id": claims.sub,
                    "consented": true,
                }),
            ),
        )
        .await;

    Ok(Json(VoiceConsentResponse {
        consented: true,
        publish_token: Some(token),
        can_publish,
    }))
}

/// DELETE /api/v1/channels/:channel_id/voice/consent — withdraw consent. The
/// client must mute/unpublish its mic immediately on success. We clear the
/// recorded version so the next join re-surfaces the disclosure.
pub async fn withdraw_consent(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<VoiceConsentResponse>, AppError> {
    let member = voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" {
        return Err(AppError::BadRequest(
            "channel is not a voice channel".into(),
        ));
    }
    let row = sqlx::query(
        "SELECT voice_session_id FROM voice_sessions
         WHERE channel_id = $1 AND ended_at IS NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&channel_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Conflict("no active voice session".into()))?;
    let voice_session_id: String = row.try_get("voice_session_id")?;
    sqlx::query(
        "UPDATE voice_participant_sessions
         SET consent_version = NULL
         WHERE user_id = $1 AND voice_session_id = $2",
    )
    .bind(&claims.sub)
    .bind(&voice_session_id)
    .execute(&state.db)
    .await?;

    state
        .fanout
        .broadcast_channel(
            Uuid::parse_str(&channel_id)
                .map_err(|_| AppError::BadRequest("invalid channel id".into()))?,
            WireFrame::channel(
                Uuid::parse_str(&channel_id).unwrap(),
                "voice_consent_updated",
                json!({
                    "voice_session_id": voice_session_id,
                    "user_id": claims.sub,
                    "consented": false,
                }),
            ),
        )
        .await;

    Ok(Json(VoiceConsentResponse {
        consented: false,
        publish_token: None,
        can_publish: false,
    }))
}

/// Append an audited transcript action (export / delete / policy_change /
/// consent_withdrawn). Never fails the caller — an audit write error is logged
/// and swallowed so the primary action still succeeds.
pub(crate) async fn write_transcript_audit(
    db: &sqlx::PgPool,
    channel_id: &str,
    voice_session_id: Option<&str>,
    segment_id: Option<&str>,
    actor_user_id: &str,
    action: &str,
    details: serde_json::Value,
) {
    let result = sqlx::query(
        "INSERT INTO transcript_audit_events
            (channel_id, voice_session_id, segment_id, actor_user_id, action, details)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(channel_id)
    .bind(voice_session_id)
    .bind(segment_id)
    .bind(actor_user_id)
    .bind(action)
    .bind(details)
    .execute(db)
    .await;
    if let Err(error) = result {
        tracing::warn!(%channel_id, %actor_user_id, %action, %error, "transcript audit write failed");
    }
}

fn verify_webhook(
    api_key: &str,
    api_secret: &str,
    authorization: Option<&str>,
    body: &[u8],
) -> Result<(), AppError> {
    let token = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Unauthorized("missing LiveKit webhook token".into()))?;
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[api_key]);
    validation.validate_exp = true;
    validation.validate_nbf = true;
    let claims = decode::<LiveKitWebhookClaims>(
        token,
        &DecodingKey::from_secret(api_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AppError::Unauthorized("invalid LiveKit webhook token".into()))?
    .claims;
    // Keep these fields read so serde/validation drift is visible to the compiler.
    let _ = (claims.iss, claims.exp, claims.nbf);
    let expected = BASE64
        .decode(claims.sha256.as_bytes())
        .map_err(|_| AppError::Unauthorized("invalid LiveKit webhook body hash".into()))?;
    let actual = Sha256::digest(body);
    if expected.as_slice() != actual.as_slice() {
        return Err(AppError::Unauthorized(
            "LiveKit webhook body hash mismatch".into(),
        ));
    }
    Ok(())
}

/// POST /api/v1/voice/livekit/webhook
///
/// This endpoint is intentionally outside browser JWT middleware. LiveKit signs
/// the raw request body with the configured API secret and carries its SHA-256
/// in the authorization JWT; both signature and body hash are verified before
/// any JSON is parsed or state is mutated.
pub async fn livekit_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    let (_, api_key, api_secret) = state
        .config
        .livekit()
        .ok_or_else(|| AppError::ServiceUnavailable("real-time voice is not configured".into()))?;
    verify_webhook(
        api_key,
        api_secret,
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        &body,
    )?;
    let event: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("invalid LiveKit webhook JSON".into()))?;
    let event_name = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let event_id = event.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if event_name.is_empty() || event_id.is_empty() {
        return Err(AppError::BadRequest(
            "LiveKit webhook event and id are required".into(),
        ));
    }
    let provider_room_id = event
        .pointer("/room/name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let participant_identity = event
        .pointer("/participant/identity")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let provider_track_id = event
        .pointer("/track/sid")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let mut tx = state.db.begin().await?;
    let claimed = sqlx::query(
        "INSERT INTO voice_webhook_events
            (provider, event_id, event_type, provider_room_id)
         VALUES ('livekit', $1, $2, NULLIF($3, ''))
         ON CONFLICT (provider, event_id) DO NOTHING",
    )
    .bind(event_id)
    .bind(event_name)
    .bind(provider_room_id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if !claimed {
        tx.rollback().await?;
        return Ok(Json(json!({ "ok": true, "duplicate": true })));
    }

    let channel_id: Option<String> = if provider_room_id.is_empty() {
        None
    } else {
        sqlx::query_scalar(
            "SELECT channel_id FROM voice_sessions
             WHERE provider = 'livekit' AND provider_room_id = $1
             ORDER BY started_at DESC LIMIT 1",
        )
        .bind(provider_room_id)
        .fetch_optional(&mut *tx)
        .await?
    };

    match event_name {
        "room_started" => {
            sqlx::query(
                "UPDATE voice_sessions SET status = 'active', updated_at = NOW()
                 WHERE provider = 'livekit' AND provider_room_id = $1 AND ended_at IS NULL",
            )
            .bind(provider_room_id)
            .execute(&mut *tx)
            .await?;
        }
        "room_finished" => {
            sqlx::query(
                "UPDATE voice_sessions
                 SET status = 'ended', ended_at = NOW(), updated_at = NOW()
                 WHERE provider = 'livekit' AND provider_room_id = $1 AND ended_at IS NULL",
            )
            .bind(provider_room_id)
            .execute(&mut *tx)
            .await?;
        }
        "participant_joined" => {
            sqlx::query(
                "UPDATE voice_participant_sessions SET joined_at = COALESCE(joined_at, NOW())
                 WHERE provider_identity = $1 AND left_at IS NULL",
            )
            .bind(participant_identity)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE voice_sessions SET status = 'active', updated_at = NOW()
                 WHERE provider = 'livekit' AND provider_room_id = $1 AND ended_at IS NULL",
            )
            .bind(provider_room_id)
            .execute(&mut *tx)
            .await?;
        }
        "participant_left" | "participant_connection_aborted" => {
            sqlx::query(
                "UPDATE voice_participant_sessions SET left_at = COALESCE(left_at, NOW())
                 WHERE provider_identity = $1 AND left_at IS NULL",
            )
            .bind(participant_identity)
            .execute(&mut *tx)
            .await?;
        }
        "track_published" => {
            sqlx::query(
                "UPDATE voice_participant_sessions
                 SET mic_published_at = COALESCE(mic_published_at, NOW()),
                     provider_track_id = NULLIF($2, '')
                 WHERE provider_identity = $1 AND left_at IS NULL",
            )
            .bind(participant_identity)
            .bind(provider_track_id)
            .execute(&mut *tx)
            .await?;
        }
        "track_unpublished" => {
            sqlx::query(
                "UPDATE voice_participant_sessions
                 SET mic_published_at = NULL, provider_track_id = NULL
                 WHERE provider_identity = $1 AND left_at IS NULL
                   AND (provider_track_id = NULLIF($2, '') OR NULLIF($2, '') IS NULL)",
            )
            .bind(participant_identity)
            .bind(provider_track_id)
            .execute(&mut *tx)
            .await?;
        }
        _ => {}
    }
    tx.commit().await?;

    if matches!(
        event_name,
        "room_started"
            | "room_finished"
            | "participant_joined"
            | "participant_left"
            | "participant_connection_aborted"
            | "track_published"
            | "track_unpublished"
    ) {
        if let Some(channel_uuid) = channel_id
            .as_deref()
            .and_then(|value| Uuid::parse_str(value).ok())
        {
            broadcast_voice_presence(&state, channel_uuid).await;
        }
    }

    tracing::debug!(
        event = event_name,
        event_id,
        provider_room_id,
        "LiveKit webhook applied"
    );
    Ok(Json(json!({
        "ok": true,
        "ignored": provider_room_id.is_empty() || channel_id.is_none()
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, DecodingKey, Validation};

    fn valid_transcript() -> TranscriptSegmentIngestRequest {
        TranscriptSegmentIngestRequest {
            provider_event_id: "event-1".into(),
            segment_id: "segment-1".into(),
            participant_identity: "participant-1".into(),
            track_id: "track-1".into(),
            text: "  Ship the accessibility audit.  ".into(),
            started_at_ms: 1_000,
            ended_at_ms: 3_000,
            language: Some("en-US".into()),
            confidence: Some(0.9346),
            finalized_at: Utc::now().to_rfc3339(),
            supersedes_segment_id: None,
        }
    }

    #[test]
    fn join_token_is_room_scoped_and_microphone_only() {
        let (token, exp) = mint_join_token(
            "devkey",
            "secret",
            "opaque-id",
            "Ada",
            "cheers-room",
            "user-id",
            true,
            1_700_000_000,
        )
        .unwrap();
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        let decoded =
            decode::<LiveKitClaims>(&token, &DecodingKey::from_secret(b"secret"), &validation)
                .unwrap()
                .claims;
        assert_eq!(decoded.iss, "devkey");
        assert_eq!(decoded.sub, "opaque-id");
        assert_eq!(decoded.video.room, "cheers-room");
        assert!(decoded.video.room_join);
        assert!(decoded.video.can_publish);
        assert_eq!(decoded.video.can_publish_sources, vec!["microphone"]);
        assert_eq!(exp, 1_700_000_000 + JOIN_TOKEN_TTL_SECS);
    }

    #[test]
    fn readonly_token_cannot_publish() {
        let (token, _) = mint_join_token(
            "devkey",
            "secret",
            "opaque-id",
            "Ada",
            "cheers-room",
            "user-id",
            false,
            1_700_000_000,
        )
        .unwrap();
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        let decoded =
            decode::<LiveKitClaims>(&token, &DecodingKey::from_secret(b"secret"), &validation)
                .unwrap()
                .claims;
        assert!(!decoded.video.can_publish);
        assert!(decoded.video.can_publish_sources.is_empty());
    }

    #[test]
    fn webhook_body_hash_is_verified_after_jwt_signature() {
        let body = br#"{"event":"room_started"}"#;
        let now = Utc::now().timestamp();
        let claims = LiveKitWebhookClaims {
            iss: "devkey".into(),
            exp: now + 60,
            nbf: now - 1,
            sha256: BASE64.encode(Sha256::digest(body)),
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(b"secret"),
        )
        .unwrap();
        let auth = format!("Bearer {token}");
        assert!(verify_webhook("devkey", "secret", Some(&auth), body).is_ok());
        assert!(verify_webhook("devkey", "secret", Some(&auth), b"tampered").is_err());
    }

    #[test]
    fn final_transcript_validation_normalizes_bounded_input() {
        let valid = validate_transcript(&valid_transcript()).unwrap();
        assert_eq!(valid.text, "Ship the accessibility audit.");
        assert_eq!(valid.language.as_deref(), Some("en-US"));
        assert_eq!(valid.confidence.as_deref(), Some("0.935"));
    }

    #[test]
    fn final_transcript_validation_rejects_bad_time_and_confidence() {
        let mut body = valid_transcript();
        body.ended_at_ms = body.started_at_ms - 1;
        assert!(validate_transcript(&body).is_err());

        let mut body = valid_transcript();
        body.confidence = Some(1.1);
        assert!(validate_transcript(&body).is_err());
    }

    #[test]
    fn final_transcript_validation_rejects_empty_or_oversized_text() {
        let mut body = valid_transcript();
        body.text = "   ".into();
        assert!(validate_transcript(&body).is_err());

        let mut body = valid_transcript();
        body.text = "x".repeat(MAX_TRANSCRIPT_CHARS + 1);
        assert!(validate_transcript(&body).is_err());
    }
}
