-- Delegated narrowing (docs/arch/MCP_AUTH_ISOLATION.md §5): a bot working on a
-- human's task acts with bot role ∩ that human's role in the channel, so a
-- read-only member cannot steer an admin bot into admin actions through MCP
-- tools. On by default; a bot's owner can turn it off for automation that
-- read-only members must be able to drive.

ALTER TABLE bot_accounts
    ADD COLUMN IF NOT EXISTS mcp_narrow_to_sender BOOLEAN NOT NULL DEFAULT TRUE;
