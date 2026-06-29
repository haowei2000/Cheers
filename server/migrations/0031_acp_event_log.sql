-- Complete ACP event log (docs/arch/ACP_EVENT_TAXONOMY.md). The connector forwards
-- every ACP session/update (and notable client→agent actions) verbatim as a generic
-- acp_event frame; the gateway classifies each via the acp_events registry and
-- records it here. This is the observability/audit substrate that makes "every ACP
-- event flows into Cheers" true — high-frequency streaming chunks are skipped
-- (the bot's message already captures the text).
CREATE TABLE IF NOT EXISTS acp_event_log (
    id          VARCHAR(36) PRIMARY KEY,
    bot_id      VARCHAR(36) NOT NULL,
    channel_id  VARCHAR(36),
    session_id  VARCHAR(128),
    -- ACP event name: a method, or session/update:<subtype>.
    name        VARCHAR(96) NOT NULL,
    -- Registry home: agent | connector | cheers | observe (blank if unclassified).
    home        VARCHAR(16) NOT NULL DEFAULT '',
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_acp_event_log_bot_channel
    ON acp_event_log (bot_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_acp_event_log_name
    ON acp_event_log (name, created_at DESC);
