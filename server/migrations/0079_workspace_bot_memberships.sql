-- Bots and users share the public workspace-member contract, while separate
-- tables retain real foreign keys for each identity kind. A bot added to any
-- existing channel is backfilled as a member of that channel's workspace.
CREATE TABLE IF NOT EXISTS workspace_bot_memberships (
    workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    bot_id        VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    role          VARCHAR(20) NOT NULL DEFAULT 'member',
    added_by      VARCHAR(36),
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_workspace_bot_memberships_role CHECK (role IN ('member', 'readonly')),
    PRIMARY KEY (workspace_id, bot_id)
);

CREATE INDEX IF NOT EXISTS ix_workspace_bot_memberships_bot
    ON workspace_bot_memberships(bot_id);

INSERT INTO workspace_bot_memberships (workspace_id, bot_id, role, added_by, joined_at)
SELECT c.workspace_id, cm.member_id, 'member', MIN(cm.added_by), MIN(cm.joined_at)
FROM channel_memberships cm
JOIN channels c ON c.channel_id = cm.channel_id
JOIN bot_accounts b ON b.bot_id = cm.member_id
WHERE cm.member_type = 'bot' AND c.type <> 'dm'
GROUP BY c.workspace_id, cm.member_id
ON CONFLICT (workspace_id, bot_id) DO NOTHING;
