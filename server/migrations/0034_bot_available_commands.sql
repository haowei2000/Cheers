-- ⑦ Command palette: the latest advertised slash/MCP command set per (channel, bot).
-- Source: ACP session/update:available_commands_update, parsed by
-- domain::acp_session_updates and persisted at handle_acp_event_frame.
CREATE TABLE IF NOT EXISTS bot_available_commands (
    channel_id  VARCHAR(36) NOT NULL,
    bot_id      VARCHAR(36) NOT NULL,
    session_id  VARCHAR(128),  -- matches acp_event_log.session_id (frame session_id can exceed 36)
    commands    JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, bot_id)
);
