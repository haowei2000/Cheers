-- ② Cost dashboard: per-turn usage snapshots, aggregated (SUM / latest) at read time.
-- Source: ACP session/update:usage_update, parsed by domain::acp_session_updates.
CREATE TABLE IF NOT EXISTS bot_usage_events (
    id             VARCHAR(36) PRIMARY KEY,
    channel_id     VARCHAR(36) NOT NULL,
    bot_id         VARCHAR(36) NOT NULL,
    session_id     VARCHAR(128),  -- matches acp_event_log.session_id (can exceed 36)
    input_tokens   BIGINT,
    output_tokens  BIGINT,
    total_tokens   BIGINT,
    context_window BIGINT,
    cost_usd       DOUBLE PRECISION,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bot_usage_events_channel ON bot_usage_events(channel_id, bot_id);
