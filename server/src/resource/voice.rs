//! Read-only voice transcript Resources for humans and bots. Raw media is never
//! exposed through Resource; only finalized, speaker-attributed text is readable.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{authorize_channel_read, Principal, ResourceResult};

/// `channel.voice.transcript` / `channel.voice.transcript.by-seq`
pub async fn handle_transcript(
    db: &PgPool,
    principal: &Principal,
    params: &Value,
) -> ResourceResult {
    let channel_id: Uuid = params
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| super::resource_error("BAD_REQUEST", "missing channel_id"))?;
    authorize_channel_read(db, principal, channel_id).await?;

    let since_seq = params
        .get("since_seq")
        .or_else(|| params.get("after_seq"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let limit = params
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(100)
        .clamp(1, 500);
    let rows = sqlx::query!(
        "SELECT t.segment_id, t.voice_session_id, t.channel_id,
                t.participant_session_id, t.user_id,
                COALESCE(NULLIF(u.display_name, ''), u.username, 'Member') AS speaker_name,
                t.provider_segment_id, t.track_id, t.channel_seq, t.text,
                t.started_at_ms, t.ended_at_ms, t.language,
                t.confidence::double precision AS confidence,
                t.supersedes_segment_id, t.finalized_at, t.created_at
         FROM voice_transcript_segments t
         JOIN users u ON u.user_id = t.user_id
         WHERE t.channel_id = $1 AND t.channel_seq > $2
         ORDER BY t.channel_seq ASC LIMIT $3",
        channel_id.to_string(),
        since_seq,
        limit,
    )
    .fetch_all(db)
    .await
    .map_err(super::db_err("voice.transcript: select segments"))?;

    let segments: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            json!({
                "segment_id": row.segment_id.clone(),
                "voice_session_id": row.voice_session_id.clone(),
                "channel_id": row.channel_id.clone(),
                "participant_session_id": row.participant_session_id.clone(),
                "user_id": row.user_id.clone(),
                "speaker_name": row.speaker_name.clone().unwrap_or_else(|| "Member".into()),
                "provider_segment_id": row.provider_segment_id.clone(),
                "track_id": row.track_id.clone(),
                "channel_seq": row.channel_seq.clone(),
                "text": row.text.clone(),
                "started_at_ms": row.started_at_ms.clone(),
                "ended_at_ms": row.ended_at_ms.clone(),
                "language": row.language.clone(),
                "confidence": row.confidence.clone(),
                "supersedes_segment_id": row.supersedes_segment_id.clone(),
                "finalized_at": Some(row.finalized_at.clone()),
                "created_at": Some(row.created_at.clone()),
            })
        })
        .collect();
    let next_seq = segments
        .last()
        .and_then(|segment| segment.get("channel_seq"))
        .and_then(Value::as_i64);
    Ok(json!({
        "channel_id": channel_id,
        "since_seq": since_seq,
        "segments": segments,
        "next_seq": next_seq,
        "limit": limit,
    }))
}
