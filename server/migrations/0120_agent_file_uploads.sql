-- Agent file uploads: raw bytes reach the gateway over HTTP with a single-file
-- ticket instead of being copied through the model as base64 tool arguments.
CREATE TABLE IF NOT EXISTS agent_file_uploads (
    upload_id        VARCHAR(36) PRIMARY KEY,
    ticket_hash      VARCHAR(64) NOT NULL,
    channel_id       VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    bot_id           VARCHAR(36) NOT NULL,
    on_behalf_of     VARCHAR(36),
    execution_id     VARCHAR(36),
    file_id          VARCHAR(36) NOT NULL,
    object_key       VARCHAR(512) NOT NULL,
    filename         VARCHAR(255) NOT NULL,
    content_type     VARCHAR(255) NOT NULL,
    size_bytes       INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256           VARCHAR(64) NOT NULL,
    status           VARCHAR(16) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'receiving', 'received', 'published')),
    receiving_since  TIMESTAMPTZ,
    result           JSONB,
    expires_at       TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_agent_file_uploads_bot ON agent_file_uploads(bot_id, status);
CREATE INDEX IF NOT EXISTS ix_agent_file_uploads_expires ON agent_file_uploads(expires_at);
