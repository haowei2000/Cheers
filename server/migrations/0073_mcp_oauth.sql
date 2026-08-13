-- OAuth 2.1 authorization-code and rotating refresh-token state for remote MCP.
-- Every grant is bound to one terminal installation; no row stores a plaintext
-- authorization code, refresh token, PKCE verifier, or installation secret.
CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_codes (
    code_id             VARCHAR(36) PRIMARY KEY,
    code_hash           VARCHAR(64) NOT NULL UNIQUE,
    installation_id     VARCHAR(36) NOT NULL REFERENCES terminal_installations(installation_id) ON DELETE CASCADE,
    client_id           TEXT NOT NULL,
    redirect_uri        TEXT NOT NULL,
    scope               TEXT NOT NULL,
    resource            TEXT NOT NULL,
    code_challenge      VARCHAR(128) NOT NULL,
    created_by          VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    used_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_mcp_oauth_codes_expiry
    ON mcp_oauth_authorization_codes (expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
    refresh_token_id    VARCHAR(36) PRIMARY KEY,
    token_hash          VARCHAR(64) NOT NULL UNIQUE,
    installation_id     VARCHAR(36) NOT NULL REFERENCES terminal_installations(installation_id) ON DELETE CASCADE,
    client_id           TEXT NOT NULL,
    scope               TEXT NOT NULL,
    resource            TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    rotated_at          TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    replaced_by_id      VARCHAR(36) REFERENCES mcp_oauth_refresh_tokens(refresh_token_id)
);

CREATE INDEX IF NOT EXISTS ix_mcp_oauth_refresh_installation
    ON mcp_oauth_refresh_tokens (installation_id, created_at DESC);
