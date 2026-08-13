-- MCP connectivity is installation state, not an ACP-card state. Only a
-- Gateway-authenticated MCP request may establish `connected`.
ALTER TABLE terminal_installations
    ADD COLUMN IF NOT EXISTS mcp_connection_state VARCHAR(24) NOT NULL DEFAULT 'unconfigured'
    CHECK (mcp_connection_state IN (
        'unconfigured', 'action_required', 'authorizing', 'connected',
        'refresh_failed', 'revoked'
    ));

ALTER TABLE terminal_installations
    ADD COLUMN IF NOT EXISTS mcp_state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE terminal_installations
    ADD COLUMN IF NOT EXISTS mcp_connected_at TIMESTAMPTZ;

ALTER TABLE terminal_installations
    ADD COLUMN IF NOT EXISTS mcp_last_seen_at TIMESTAMPTZ;

UPDATE terminal_installations
SET mcp_connection_state = 'revoked',
    mcp_state_updated_at = NOW()
WHERE revoked_at IS NOT NULL
  AND mcp_connection_state <> 'revoked';
