-- Unified file/event annotations. Soft deletion preserves legacy import idempotency.
CREATE TABLE IF NOT EXISTS channel_annotations (
    id VARCHAR(36) PRIMARY KEY,
    channel_id VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    author_id VARCHAR(36) REFERENCES users(user_id) ON DELETE SET NULL,
    target JSONB NOT NULL,
    label TEXT NOT NULL,
    note TEXT NOT NULL,
    legacy_id TEXT,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (channel_id, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_annotations_active
    ON channel_annotations(channel_id, created_at, id) WHERE deleted_at IS NULL;
