-- Bind refresh grants to the installation credential generation that created
-- them. Rotating a terminal credential must invalidate both access tokens and
-- refresh tokens issued under the previous credential.
ALTER TABLE mcp_oauth_refresh_tokens
    ADD COLUMN IF NOT EXISTS credential_hash VARCHAR(64);

UPDATE mcp_oauth_refresh_tokens AS refresh
SET credential_hash = installation.credential_hash
FROM terminal_installations AS installation
WHERE refresh.installation_id = installation.installation_id
  AND refresh.credential_hash IS NULL;

ALTER TABLE mcp_oauth_refresh_tokens
    ALTER COLUMN credential_hash SET NOT NULL;

