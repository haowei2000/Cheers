//! Real-time voice control plane.
//!
//! Media never traverses the gateway. This module authorizes channel members,
//! reserves a durable Cheers voice session, and mints a short-lived LiveKit join
//! token whose grants are limited to one room and microphone audio.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    Extension, Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

use crate::{
    api::middleware::Claims as BrowserClaims, app_state::AppState, errors::AppError,
    gateway::realtime::frame::WireFrame,
};

const JOIN_TOKEN_TTL_SECS: i64 = 10 * 60;

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
    pub session: Option<VoiceSessionDto>,
}

#[derive(Debug, Serialize)]
pub struct VoiceSessionDto {
    pub voice_session_id: String,
    pub status: String,
    pub transcription_status: String,
    pub started_at: String,
}

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

struct VoiceMember {
    channel_kind: String,
    channel_role: String,
    display_name: String,
}

async fn voice_member(
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
    sqlx::query(
        "INSERT INTO voice_participant_sessions
            (participant_session_id, voice_session_id, user_id, provider_identity, connection_nonce)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(participant_session_id)
    .bind(&voice_session_id)
    .bind(&claims.sub)
    .bind(&identity)
    .bind(connection_nonce)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // readonly members may listen but cannot publish a microphone track.
    let can_publish = member.channel_role != "readonly";
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

    Ok(Json(VoiceStateResponse {
        enabled: state.config.livekit().is_some(),
        channel_kind: member.channel_kind,
        session,
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
                 SET mic_published_at = COALESCE(mic_published_at, NOW())
                 WHERE provider_identity = $1 AND left_at IS NULL",
            )
            .bind(participant_identity)
            .execute(&mut *tx)
            .await?;
        }
        "track_unpublished" => {
            sqlx::query(
                "UPDATE voice_participant_sessions SET mic_published_at = NULL
                 WHERE provider_identity = $1 AND left_at IS NULL",
            )
            .bind(participant_identity)
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
}
