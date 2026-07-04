-- ① Plan board: the latest agent plan per (channel, bot, session).
-- Source: ACP session/update:plan, parsed by domain::acp_session_updates.
-- session_id defaults to '' (the primary/unkeyed session) so the PK is total.
CREATE TABLE IF NOT EXISTS bot_session_plans (
    channel_id  VARCHAR(36) NOT NULL,
    bot_id      VARCHAR(36) NOT NULL,
    session_id  VARCHAR(128) NOT NULL DEFAULT '',  -- matches acp_event_log.session_id (can exceed 36)
    entries     JSONB NOT NULL DEFAULT '[]'::jsonb,
    total       INTEGER NOT NULL DEFAULT 0,
    completed   INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, bot_id, session_id)
);
