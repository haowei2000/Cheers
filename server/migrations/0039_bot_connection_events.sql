-- Bot bridge connection history: one row per control/data socket connect /
-- disconnect (with reason), so operators can inspect a bot's uptime timeline
-- instead of only its instantaneous presence.
-- Read by GET /api/v1/bots/:bot_id/connection-events and the status endpoint's
-- last_connected_at/last_disconnected_at; pruned by
-- gateway::connection_event_reaper after a retention window.
CREATE TABLE IF NOT EXISTS bot_connection_events (
    id            BIGSERIAL PRIMARY KEY,
    bot_id        VARCHAR(36) NOT NULL,
    stream        VARCHAR(16) NOT NULL,  -- 'control' | 'data'
    event         VARCHAR(16) NOT NULL,  -- 'connected' | 'disconnected'
    reason        VARCHAR(32),           -- disconnects only: closed | superseded |
                                         -- protocol_error | idle_timeout | write_failed | unbound
    connection_id VARCHAR(36),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bot_connection_events_bot
    ON bot_connection_events(bot_id, created_at DESC);
