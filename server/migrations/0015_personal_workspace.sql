-- Personal workspaces (decision 2026-06-24, CONVERSATION_MODEL.md). A personal workspace
-- is owned by one user (its private space + the FK anchor for DMs they start). `kind`
-- already exists ('team' default); add the owner link. The partial unique index caps each
-- user at one personal workspace (lets get_or_create be race-safe).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(36);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_personal_owner
    ON workspaces (owner_user_id)
    WHERE kind = 'personal';
