-- Persist the channel selected during OAuth consent so authorization-code and
-- refresh-token grants retain the same per-channel MCP boundary.
ALTER TABLE mcp_oauth_authorization_codes
    ADD COLUMN IF NOT EXISTS channel_id VARCHAR(36);

ALTER TABLE mcp_oauth_refresh_tokens
    ADD COLUMN IF NOT EXISTS channel_id VARCHAR(36);
