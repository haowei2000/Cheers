-- Durable, speaker-attributed final transcript segments. Interim captions stay
-- in the media plane and never consume the shared channel event clock.

ALTER TABLE voice_participant_sessions
    ADD COLUMN IF NOT EXISTS provider_track_id VARCHAR(255);

CREATE TABLE IF NOT EXISTS voice_transcript_segments (
    segment_id              VARCHAR(36) PRIMARY KEY,
    voice_session_id        VARCHAR(36) NOT NULL REFERENCES voice_sessions(voice_session_id) ON DELETE CASCADE,
    channel_id              VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    participant_session_id  VARCHAR(36) NOT NULL REFERENCES voice_participant_sessions(participant_session_id),
    user_id                 VARCHAR(36) NOT NULL REFERENCES users(user_id),
    provider_segment_id     VARCHAR(255) NOT NULL,
    provider_event_id       VARCHAR(255) NOT NULL UNIQUE,
    track_id                VARCHAR(255) NOT NULL,
    channel_seq             BIGINT NOT NULL,
    text                    TEXT NOT NULL,
    started_at_ms           BIGINT NOT NULL,
    ended_at_ms             BIGINT NOT NULL,
    language                VARCHAR(16),
    confidence              NUMERIC(4,3),
    supersedes_segment_id   VARCHAR(36) REFERENCES voice_transcript_segments(segment_id),
    finalized_at            TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_voice_transcript_time CHECK (
        started_at_ms >= 0 AND ended_at_ms >= started_at_ms
    ),
    CONSTRAINT chk_voice_transcript_confidence CHECK (
        confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_transcript_provider_segment
    ON voice_transcript_segments(voice_session_id, provider_segment_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_transcript_channel_seq
    ON voice_transcript_segments(channel_id, channel_seq);
CREATE INDEX IF NOT EXISTS ix_voice_transcript_session_time
    ON voice_transcript_segments(voice_session_id, started_at_ms);
