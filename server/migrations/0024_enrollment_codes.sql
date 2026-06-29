-- Short-lived, single-use enrollment codes for the 3-mode bot onboarding flow.
-- An owner mints a code for a bot; a host redeems it ONCE (anonymously, over
-- TLS) to receive the bot's freshly-rotated token + connector config. Only the
-- SHA-256 of the code is stored. Single redemption is enforced atomically:
--   UPDATE enrollment_codes SET redeemed_at = NOW()
--   WHERE code_hash = $1 AND redeemed_at IS NULL AND NOT revoked AND expires_at > NOW()
--   RETURNING bot_id, agent_type;
CREATE TABLE IF NOT EXISTS enrollment_codes (
    code_id      VARCHAR(36)  PRIMARY KEY,
    bot_id       VARCHAR(36)  NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    -- SHA-256 hex of the plaintext `agbenr_…` code (the code itself is never stored).
    code_hash    VARCHAR(64)  NOT NULL UNIQUE,
    created_by   VARCHAR(36)  NOT NULL REFERENCES users(user_id),
    -- claude | codex | opencode | generic — drives the rendered [adapter].command.
    agent_type   VARCHAR(32),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ  NOT NULL,
    redeemed_at  TIMESTAMPTZ,
    revoked      BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS ix_enrollment_codes_bot ON enrollment_codes (bot_id);
-- Live (mintable/countable) codes per owner — for the per-owner live-code cap.
CREATE INDEX IF NOT EXISTS ix_enrollment_codes_live
    ON enrollment_codes (created_by)
    WHERE redeemed_at IS NULL AND NOT revoked;
