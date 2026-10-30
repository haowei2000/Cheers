-- Observed MCP delivery fact (docs/arch/MCP_AUTH_ISOLATION.md §3.5): whether the
-- host's Agent picks up a renewed bearer in `direct` delivery, judged by the
-- gateway from the token generation (`iat`) the Agent presents after a renewal.
-- The verdict applies to one Agent build, recorded alongside it, so a connector
-- upgrade to a different Agent version is judged again. The declared delivery
-- mode itself travels in `capabilities.mcp_delivery` from the `ready` frame.

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_header_refresh BOOLEAN;

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_header_refresh_agent VARCHAR(160);

ALTER TABLE connector_hosts
    ADD COLUMN IF NOT EXISTS mcp_header_refresh_at TIMESTAMPTZ;
