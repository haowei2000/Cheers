//! Retention, audit, and soft-delete for voice transcripts (design §12), plus
//! the per-channel voice-config write endpoint. Kept in its own module so the
//! RT-onset control-plane handlers in `voice.rs` stay focused on
//! join/transcription/lifecycle.

use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    api::middleware::Claims as BrowserClaims, app_state::AppState, errors::AppError,
    gateway::realtime::frame::WireFrame,
};
// Re-exported from the parent voice module so retention handlers (split into
// their own file for readability) can reuse the ingest/building blocks without
// duplicating them. Marked `pub` here only because cross-module reuse requires
// it; the public API surface is `voice_retention::{export_transcript,
// delete_transcript_segment, update_voice_config}`.
use crate::api::voice::write_transcript_audit;
use crate::domain::voice_config::VoiceConfig;

#[derive(Debug, Serialize)]
pub struct TranscriptExportResponse {
    pub exported_at: String,
    pub segments: Vec<crate::api::voice::TranscriptSegmentDto>,
    pub format: String,
}

/// GET /api/v1/channels/:channel_id/voice/transcript/export — export durable
/// finals as JSON (audited). Owners/admins only.
pub async fn export_transcript(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
) -> Result<Json<TranscriptExportResponse>, AppError> {
    use crate::api::voice::{transcript_dto, TranscriptSegmentDto, TRANSCRIPT_SELECT};
    use chrono::Utc;

    let channel_uuid = Uuid::parse_str(&channel_id)
        .map_err(|_| AppError::BadRequest("invalid channel id".into()))?;
    let member = crate::api::voice::voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" {
        return Err(AppError::BadRequest(
            "channel is not a voice channel".into(),
        ));
    }
    if !matches!(member.channel_role.as_str(), "owner" | "admin") {
        return Err(AppError::Forbidden(
            "channel owner or admin required".into(),
        ));
    }
    const EXPORT_LIMIT: i64 = 10_000;
    let query_string = format!(
        "{TRANSCRIPT_SELECT}
         WHERE channel_id = $1 AND deleted_at IS NULL
         ORDER BY channel_seq ASC LIMIT $2",
    );
    let rows = sqlx::query(&query_string)
        .bind(channel_uuid.to_string())
        .bind(EXPORT_LIMIT)
        .fetch_all(&state.db)
        .await?;
    let segments: Vec<TranscriptSegmentDto> = rows.into_iter().map(transcript_dto).collect();
    write_transcript_audit(
        &state.db,
        &channel_id,
        None,
        None,
        &claims.sub,
        "export",
        json!({ "count": segments.len() }),
    )
    .await;
    Ok(Json(TranscriptExportResponse {
        exported_at: Utc::now().to_rfc3339(),
        segments,
        format: "json".into(),
    }))
}

/// DELETE /api/v1/channels/:channel_id/voice/transcript/:seq — soft-delete one
/// final segment (audited). The row is retained so claim audit attribution is
/// preserved; only the text is no longer served.
pub async fn delete_transcript_segment(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path((channel_id, seq)): Path<(String, i64)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let member = crate::api::voice::voice_member(&state, &channel_id, &claims.sub).await?;
    if member.channel_kind != "voice" {
        return Err(AppError::BadRequest(
            "channel is not a voice channel".into(),
        ));
    }
    if !matches!(member.channel_role.as_str(), "owner" | "admin") {
        return Err(AppError::Forbidden(
            "channel owner or admin required".into(),
        ));
    }
    let result = sqlx::query(
        "UPDATE voice_transcript_segments
         SET deleted_at = NOW()
         WHERE channel_id = $1 AND channel_seq = $2 AND deleted_at IS NULL",
    )
    .bind(&channel_id)
    .bind(seq)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    write_transcript_audit(
        &state.db,
        &channel_id,
        None,
        None,
        &claims.sub,
        "delete",
        json!({ "channel_seq": seq }),
    )
    .await;
    // Notify the room so browsers hide the segment.
    state
        .fanout
        .broadcast_channel(
            Uuid::parse_str(&channel_id)
                .map_err(|_| AppError::BadRequest("invalid channel id".into()))?,
            WireFrame::channel(
                Uuid::parse_str(&channel_id).unwrap(),
                "voice_transcript_deleted",
                json!({ "channel_seq": seq, "channel_id": channel_id }),
            ),
        )
        .await;
    Ok(Json(json!({ "deleted": true, "channel_seq": seq })))
}

/// PUT /api/v1/channels/:channel_id/voice/config — write the per-channel voice
/// config (retention_days, transcription_mode, consent_mode, ...). Owners/admins.
pub async fn update_voice_config(
    State(state): State<AppState>,
    Extension(claims): Extension<BrowserClaims>,
    Path(channel_id): Path<String>,
    Json(body): Json<VoiceConfig>,
) -> Result<Json<VoiceConfig>, AppError> {
    let member = crate::api::voice::voice_member(&state, &channel_id, &claims.sub).await?;
    if !matches!(member.channel_role.as_str(), "owner" | "admin") {
        return Err(AppError::Forbidden(
            "channel owner or admin required".into(),
        ));
    }
    body.validate()?;
    body.save(&state.db, &channel_id).await?;
    write_transcript_audit(
        &state.db,
        &channel_id,
        None,
        None,
        &claims.sub,
        "policy_change",
        json!({
            "transcription_mode": body.transcription_mode,
            "consent_mode": body.consent_mode,
            "retention_days": body.retention_days,
        }),
    )
    .await;
    state
        .fanout
        .broadcast_channel(
            Uuid::parse_str(&channel_id)
                .map_err(|_| AppError::BadRequest("invalid channel id".into()))?,
            WireFrame::channel(
                Uuid::parse_str(&channel_id).unwrap(),
                "voice_config_updated",
                json!({ "channel_id": channel_id }),
            ),
        )
        .await;
    Ok(Json(body))
}
