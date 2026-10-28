-- no-transaction
-- Fleet cost-today filters a channel's usage to the current day; the
-- (channel_id, bot_id) index made it read the channel's whole history.
-- Built CONCURRENTLY, one statement per file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bot_usage_events_channel_created
    ON bot_usage_events (channel_id, created_at);
