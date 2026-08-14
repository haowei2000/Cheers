-- Personal Fleet cockpit: durable bot/installation management audit.
-- Deliberately no foreign keys: the timeline must survive bot, installation,
-- channel, and user deletion.
CREATE TABLE IF NOT EXISTS bot_management_audit (
    id              VARCHAR(36) PRIMARY KEY,
    event_type      VARCHAR(64) NOT NULL,
    bot_id          VARCHAR(36),
    installation_id VARCHAR(36),
    actor_id        VARCHAR(36),
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_bot_management_audit_created
    ON bot_management_audit (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ix_bot_management_audit_bot
    ON bot_management_audit (bot_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_bot_management_audit_installation
    ON bot_management_audit (installation_id, created_at DESC)
    WHERE installation_id IS NOT NULL;
