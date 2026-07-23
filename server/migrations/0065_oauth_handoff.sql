-- OAuth callbacks finish at the gateway, then return a short-lived one-time
-- handoff code to the browser or native app. Provider codes and session tokens
-- are never placed in redirect URLs.

ALTER TABLE auth_transactions
    ADD COLUMN IF NOT EXISTS oauth_code_verifier_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS handoff_code_hash VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_transactions_state_hash
    ON auth_transactions(state_hash)
    WHERE state_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_transactions_handoff_hash
    ON auth_transactions(handoff_code_hash)
    WHERE handoff_code_hash IS NOT NULL AND consumed_at IS NULL;

ALTER TABLE apple_auth_credentials
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(255);
