-- Discord-style persistent voice channels (docs/design/REALTIME_VOICE_CHANNELS.md).
-- `channels.type` remains the access/conversation dimension (public/private/dm);
-- voice is an orthogonal interaction kind so private voice channels are representable.

ALTER TABLE channels ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'text';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS voice_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS chk_channels_kind;
ALTER TABLE channels
    ADD CONSTRAINT chk_channels_kind CHECK (kind IN ('text', 'voice'));

CREATE TABLE IF NOT EXISTS voice_sessions (
    voice_session_id       VARCHAR(36) PRIMARY KEY,
    channel_id             VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    provider               VARCHAR(32) NOT NULL,
    provider_room_id       VARCHAR(255) NOT NULL,
    status                 VARCHAR(24) NOT NULL DEFAULT 'starting',
    transcription_status   VARCHAR(24) NOT NULL DEFAULT 'off',
    transcription_started_by VARCHAR(36),
    started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at               TIMESTAMPTZ,
    empty_deadline_at      TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_voice_sessions_status
        CHECK (status IN ('starting', 'active', 'draining', 'ended', 'failed')),
    CONSTRAINT chk_voice_transcription_status
        CHECK (transcription_status IN ('off', 'starting', 'active', 'stopping', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_sessions_active_channel
    ON voice_sessions(channel_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_voice_sessions_provider_room
    ON voice_sessions(provider, provider_room_id);

CREATE TABLE IF NOT EXISTS voice_participant_sessions (
    participant_session_id VARCHAR(36) PRIMARY KEY,
    voice_session_id       VARCHAR(36) NOT NULL REFERENCES voice_sessions(voice_session_id) ON DELETE CASCADE,
    user_id                VARCHAR(36) NOT NULL REFERENCES users(user_id),
    provider_identity      VARCHAR(255) NOT NULL UNIQUE,
    connection_nonce       VARCHAR(36) NOT NULL,
    joined_at              TIMESTAMPTZ,
    left_at                TIMESTAMPTZ,
    mic_published_at       TIMESTAMPTZ,
    consent_version        VARCHAR(32),
    token_issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_voice_participants_session
    ON voice_participant_sessions(voice_session_id, user_id);
