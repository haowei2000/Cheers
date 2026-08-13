-- Refresh-token reuse detection. A replay of any rotated token revokes every
-- descendant in the same authorization grant without revealing replay details.
ALTER TABLE mcp_oauth_refresh_tokens
    ADD COLUMN family_id VARCHAR(36);

UPDATE mcp_oauth_refresh_tokens
SET family_id = refresh_token_id
WHERE family_id IS NULL;

ALTER TABLE mcp_oauth_refresh_tokens
    ALTER COLUMN family_id SET NOT NULL;

CREATE INDEX ix_mcp_oauth_refresh_family
    ON mcp_oauth_refresh_tokens (family_id);
