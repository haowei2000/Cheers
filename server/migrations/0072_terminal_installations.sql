-- A bot is the durable channel identity; an installation is one concrete
-- terminal/connector allowed to act as that bot. Credentials are per
-- installation so one device can be rotated or revoked without changing the
-- bot identity, memberships, history, or another device's credential.
CREATE TABLE IF NOT EXISTS terminal_installations (
    installation_id       VARCHAR(36)  PRIMARY KEY,
    bot_id                VARCHAR(36)  NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    device_name           VARCHAR(128) NOT NULL,
    agent_type            VARCHAR(64)  NOT NULL DEFAULT 'generic',
    credential_hash       VARCHAR(64)  UNIQUE,
    credential_prefix     VARCHAR(16),
    status                VARCHAR(16)  NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'active', 'standby')),
    connector_version     VARCHAR(64),
    capabilities          JSONB,
    last_seen_at          TIMESTAMPTZ,
    connected_at          TIMESTAMPTZ,
    credential_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_terminal_installations_bot
    ON terminal_installations (bot_id, created_at DESC);

-- v1 is active/passive: retain multiple registered terminals but permit one
-- active installation per bot. A later multi-active protocol can replace this
-- index only after delivery semantics are defined.
CREATE UNIQUE INDEX IF NOT EXISTS uq_terminal_installations_one_active_per_bot
    ON terminal_installations (bot_id)
    WHERE status = 'active' AND revoked_at IS NULL;

-- New codes bind one concrete pending installation at mint time. Nullable only
-- so pre-0072 unredeemed rows can survive migration; new application writes
-- always populate it.
ALTER TABLE enrollment_codes
    ADD COLUMN IF NOT EXISTS installation_id VARCHAR(36)
    REFERENCES terminal_installations(installation_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_codes_installation
    ON enrollment_codes (installation_id)
    WHERE installation_id IS NOT NULL;
