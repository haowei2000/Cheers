-- Capabilities-as-frame (ACP data WS) delegation table.
-- Scope: bot-owned, signed per-session capability grants with replay protection.

CREATE TABLE IF NOT EXISTS acp_capability_delegations (
    delegation_id      VARCHAR(36) PRIMARY KEY,
    bot_id            VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    scope_type        VARCHAR(16) NOT NULL DEFAULT 'global',
    scope_id          VARCHAR(128),
    session_id        VARCHAR(36),
    allowed_actions   TEXT[] NOT NULL DEFAULT '{}'::text[],
    allowed_resources TEXT[] NOT NULL DEFAULT '{}'::text[],
    max_uses          INTEGER,
    use_count         INTEGER NOT NULL DEFAULT 0,
    expires_at        TIMESTAMPTZ,
    public_key        TEXT NOT NULL,
    algorithm         VARCHAR(32) NOT NULL DEFAULT 'ed25519',
    delegated_to      VARCHAR(255),
    note              TEXT,
    status            VARCHAR(16) NOT NULL DEFAULT 'active',
    revoked           BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at        TIMESTAMPTZ,
    granted_by        VARCHAR(36) NOT NULL REFERENCES users(user_id),
    request_context   JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_acp_capability_scope UNIQUE (bot_id, scope_type, scope_id, session_id, public_key, algorithm),
    CONSTRAINT chk_acp_capability_scope_type CHECK (scope_type IN ('global', 'workspace', 'channel', 'session', 'user')),
    CONSTRAINT chk_acp_capability_status CHECK (status IN ('active', 'revoked', 'expired')),
    CONSTRAINT chk_acp_capability_scope_id CHECK (scope_type = 'global' OR scope_id IS NOT NULL),
    CONSTRAINT chk_acp_capability_session_scope CHECK (scope_type <> 'session' OR session_id IS NOT NULL),
    CONSTRAINT chk_acp_capability_algorithm CHECK (algorithm IN ('ed25519'))
);

CREATE INDEX IF NOT EXISTS ix_acp_capability_delegations_bot_scope
    ON acp_capability_delegations (bot_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS ix_acp_capability_delegations_status
    ON acp_capability_delegations (bot_id, status)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_acp_capability_delegations_expires
    ON acp_capability_delegations (expires_at)
    WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acp_capability_delegations_granted_by
    ON acp_capability_delegations (granted_by);

CREATE TABLE IF NOT EXISTS acp_capability_nonce_log (
    log_id            BIGSERIAL PRIMARY KEY,
    delegation_id     VARCHAR(36) NOT NULL REFERENCES acp_capability_delegations(delegation_id) ON DELETE CASCADE,
    nonce             TEXT NOT NULL,
    request_id        TEXT,
    frame_type        VARCHAR(32) NOT NULL,
    frame_resource    VARCHAR(255),
    used_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_acp_capability_nonce UNIQUE (delegation_id, nonce)
);

CREATE INDEX IF NOT EXISTS ix_acp_capability_nonce_log_request
    ON acp_capability_nonce_log (delegation_id, request_id)
    WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_acp_capability_nonce_log_delegation
    ON acp_capability_nonce_log (delegation_id, used_at DESC);
