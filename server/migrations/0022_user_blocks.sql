-- User block list (W11). A directed block: blocker_id blocks blocked_id.
-- Enforced on friend requests and DM creation (either direction blocks both).
CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id  VARCHAR(36) NOT NULL REFERENCES users(user_id),
    blocked_id  VARCHAR(36) NOT NULL REFERENCES users(user_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS ix_user_blocks_blocked ON user_blocks (blocked_id);
