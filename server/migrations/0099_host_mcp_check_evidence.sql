-- Evidence for the Cheers MCP check (domain/mcp_check.rs). Connection state alone
-- cannot explain an agent that never connects, so the gateway also records when a
-- token was last issued to the host, which MCP protocol version and client last
-- reached /mcp, and why the last authenticated request was refused before any
-- method ran (the only trace an incompatible client leaves).

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_token_issued_at TIMESTAMPTZ;

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_protocol_version VARCHAR(16);

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_client_name VARCHAR(128);

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_client_version VARCHAR(64);

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_rejected_at TIMESTAMPTZ;

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_rejection VARCHAR(255);
