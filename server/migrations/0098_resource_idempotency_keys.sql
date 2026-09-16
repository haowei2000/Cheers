-- Idempotency keys for resource writes that are not naturally idempotent
-- (channel.messages.create, channel.files.create, fs.append). MCP clients must
-- re-issue a call whose response stream broke; a retry carrying the same key gets
-- the first result back instead of writing again (resource/idempotency.rs).
--
-- A row is claimed inside the write's own transaction and `response` is filled in
-- before that transaction commits, so a committed row always has a response and a
-- rolled-back write leaves no row. Rows answer retries for 24 hours, then are swept.

CREATE TABLE IF NOT EXISTS resource_idempotency_keys (
    principal_type  VARCHAR(16)  NOT NULL,
    principal_id    VARCHAR(36)  NOT NULL,
    resource        VARCHAR(64)  NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    -- SHA-256 of the request params (minus the key): one key, one request.
    request_hash    CHAR(64)     NOT NULL,
    response        JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (principal_type, principal_id, resource, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_resource_idempotency_keys_created_at
    ON resource_idempotency_keys (created_at);
