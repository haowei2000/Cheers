-- Channel invitations now require the invitee's CONSENT (mirrors the workspace
-- invite flow added in 0025), but kept in a SEPARATE table instead of a `status`
-- column on channel_memberships. Rationale: a channel_memberships row is treated
-- as "active member" at ~40 read sites (subscribe, send, files, sessions, bot
-- policy, mentions, resources …). A status column would force every one of them
-- to add `status='active'` or silently grant a pending invitee full access. An
-- isolated invites table keeps channel_memberships meaning exactly "active member"
-- everywhere. A pending invite grants NOTHING until accepted: accept inserts the
-- real membership row and deletes the invite; decline just deletes the invite.
--
-- Scope (workspace-first model): a channel invite may only target an ACTIVE member
-- of the channel's workspace, so there is no longer a "guest"/auto-join path.

CREATE TABLE IF NOT EXISTS channel_invites (
    channel_id  VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    user_id     VARCHAR(36) NOT NULL REFERENCES users(user_id)     ON DELETE CASCADE,
    role        VARCHAR(16) NOT NULL DEFAULT 'member',
    invited_by  VARCHAR(36),
    invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id),
    CONSTRAINT chk_channel_invites_role CHECK (role IN ('owner', 'admin', 'member', 'readonly'))
);

-- Fast lookup of a user's pending channel invites (notification center).
CREATE INDEX IF NOT EXISTS ix_channel_invites_user ON channel_invites (user_id);
