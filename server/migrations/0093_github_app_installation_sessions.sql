-- One-time browser handoffs for self-service GitHub App installation.
-- Only a SHA-256 hash of the bearer state is stored. A consumed or expired
-- state can never bind another installation to the workspace.
CREATE TABLE IF NOT EXISTS github_app_installation_sessions (
    state_hash    VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    user_id      VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_github_app_installation_sessions_expiry
    ON github_app_installation_sessions (expires_at)
    WHERE consumed_at IS NULL;
