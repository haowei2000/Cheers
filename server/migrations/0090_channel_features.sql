-- Channel features are composable capabilities. Voice no longer owns the
-- channel kind axis; old voice channels are migrated without losing config.
CREATE TABLE IF NOT EXISTS channel_features (
    channel_id VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    feature    VARCHAR(64) NOT NULL,
    config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, feature)
);

CREATE INDEX IF NOT EXISTS ix_channel_features_enabled
    ON channel_features(feature, channel_id) WHERE enabled = TRUE;

INSERT INTO channel_features (channel_id, feature, config, enabled)
SELECT channel_id, 'voice', voice_config, TRUE
FROM channels
WHERE kind = 'voice'
ON CONFLICT (channel_id, feature) DO UPDATE
SET enabled = TRUE,
    config = CASE
        WHEN channel_features.config = '{}'::jsonb THEN EXCLUDED.config
        ELSE channel_features.config
    END,
    updated_at = NOW();

UPDATE channels SET kind = 'text' WHERE kind = 'voice';

ALTER TABLE channels DROP CONSTRAINT IF EXISTS chk_channels_kind;
ALTER TABLE channels
    ADD CONSTRAINT chk_channels_kind CHECK (kind = 'text');
