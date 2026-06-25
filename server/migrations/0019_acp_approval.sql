-- ACP per-operation approval flow (see docs/arch/ACP_APPROVAL_FLOW.md).
-- Two tables: a revocable delegation of "who may resolve approvals" + an
-- append-only audit log. Intentionally NOT reusing the shelved bot_grants
-- engine — this is a narrow human-to-human delegation, not a bot resource grant.

-- Who may resolve ACP permission requests for a given bot in a given channel.
-- Default approver = bot owner (implicit, not stored here); rows add delegates.
-- Current-state table (revocable); full history lives in approval_audit.
CREATE TABLE IF NOT EXISTS approval_delegations (
    id          VARCHAR(36) PRIMARY KEY,
    bot_id      VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    channel_id  VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    user_id     VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    granted_by  VARCHAR(36) NOT NULL REFERENCES users(user_id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ,                -- NULL = active
    revoked_by  VARCHAR(36),
    UNIQUE (bot_id, channel_id, user_id)    -- one row per triple; re-grant clears revoked_at
);

CREATE INDEX IF NOT EXISTS idx_deleg_active ON approval_delegations (bot_id, channel_id)
    WHERE revoked_at IS NULL;

-- Append-only audit of every approval-related event. No FKs so history
-- survives bot/channel deletion (the whole point of an audit trail).
CREATE TABLE IF NOT EXISTS approval_audit (
    id             VARCHAR(36) PRIMARY KEY,
    event_type     VARCHAR(32) NOT NULL,    -- resolved|access_requested|access_granted|access_revoked|timeout
    bot_id         VARCHAR(36),
    channel_id     VARCHAR(36) NOT NULL,
    request_id     VARCHAR(64),             -- ACP permission request_id (resolved/timeout)
    msg_id         VARCHAR(36),             -- the permission message
    actor_id       VARCHAR(36),             -- who did it (resolver / requester / owner)
    target_user_id VARCHAR(36),            -- target user for access_* events
    decision       VARCHAR(32),             -- resolved: allow_once|allow_always|reject_once|reject_always
    option_id      VARCHAR(128),
    detail         JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_channel ON approval_audit (channel_id, created_at DESC);
</content>
