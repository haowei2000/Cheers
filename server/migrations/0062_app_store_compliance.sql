-- App Store compliance protocol: passwordless external identities, Sign in with
-- Apple token lifecycle, explicit external-agent data consent, and UGC reports.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE bot_accounts
    ADD COLUMN IF NOT EXISTS external_processor BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS processor_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS processor_privacy_url VARCHAR(1024),
    ADD COLUMN IF NOT EXISTS processor_data_use TEXT,
    ADD COLUMN IF NOT EXISTS processor_policy_version VARCHAR(64) NOT NULL DEFAULT '1';

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS apple_auth_challenges (
    challenge_id VARCHAR(36) PRIMARY KEY,
    nonce_hash   VARCHAR(64) NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_apple_auth_challenges_expiry
    ON apple_auth_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS apple_auth_credentials (
    identity_id              VARCHAR(36) PRIMARY KEY
                             REFERENCES auth_external_identities(identity_id) ON DELETE CASCADE,
    refresh_token_encrypted  TEXT NOT NULL,
    last_validated_at        TIMESTAMPTZ,
    revoked_at               TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_data_consents (
    user_id        VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    channel_id     VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    bot_id         VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    policy_version VARCHAR(64) NOT NULL,
    granted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at     TIMESTAMPTZ,
    PRIMARY KEY (user_id, channel_id, bot_id, policy_version)
);
CREATE INDEX IF NOT EXISTS ix_ai_data_consents_channel
    ON ai_data_consents(channel_id, bot_id, user_id);

CREATE TABLE IF NOT EXISTS content_reports (
    report_id    VARCHAR(36) PRIMARY KEY,
    reporter_id  VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    target_type  VARCHAR(16) NOT NULL,
    target_id    VARCHAR(36) NOT NULL,
    channel_id   VARCHAR(36) REFERENCES channels(channel_id) ON DELETE SET NULL,
    reason       VARCHAR(32) NOT NULL,
    details      TEXT,
    status       VARCHAR(16) NOT NULL DEFAULT 'open',
    resolution   TEXT,
    resolved_by  VARCHAR(36) REFERENCES users(user_id) ON DELETE SET NULL,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_content_reports_target CHECK (target_type IN ('message', 'user')),
    CONSTRAINT chk_content_reports_reason CHECK (reason IN ('harassment', 'spam', 'illegal', 'privacy', 'other')),
    CONSTRAINT chk_content_reports_status CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed'))
);
CREATE INDEX IF NOT EXISTS ix_content_reports_queue
    ON content_reports(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_reports_open_duplicate
    ON content_reports(reporter_id, target_type, target_id)
    WHERE status IN ('open', 'reviewing');
