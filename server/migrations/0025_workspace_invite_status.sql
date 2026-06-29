-- Workspace invitations: a membership can be `pending` (invited, not yet
-- accepted) before it becomes `active`. Existing rows are all real members, so
-- they default to 'active' and the change is backwards-compatible.
--
-- `invite_workspace_member` now inserts a 'pending' row; `accept_invite` flips
-- it to 'active'. `add_workspace_member` (direct admin add) stays 'active'.

ALTER TABLE workspace_memberships
    ADD COLUMN IF NOT EXISTS status     VARCHAR(16) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS invited_by VARCHAR(36),
    ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

ALTER TABLE workspace_memberships
    DROP CONSTRAINT IF EXISTS chk_workspace_memberships_status;
ALTER TABLE workspace_memberships
    ADD CONSTRAINT chk_workspace_memberships_status CHECK (status IN ('active', 'pending'));

-- Fast lookup of a user's pending invites across workspaces.
CREATE INDEX IF NOT EXISTS ix_workspace_memberships_pending
    ON workspace_memberships (user_id) WHERE status = 'pending';
