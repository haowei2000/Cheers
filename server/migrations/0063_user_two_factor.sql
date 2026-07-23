-- User-level TOTP 2FA and remote-agent access gating.
-- Requires 2FA for bot/session creation when the instance policy is enabled.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS totp_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS backup_codes JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS two_factor_login_sessions (
    session_id  VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS ix_two_factor_login_sessions_user
    ON two_factor_login_sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_two_factor_login_sessions_expiry
    ON two_factor_login_sessions(expires_at) WHERE used = FALSE;
