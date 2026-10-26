-- no-transaction
-- Fleet audit reads each visible bot's newest ACP events. The existing
-- (bot_id, channel_id, created_at) index cannot serve a per-bot time order, so
-- the audit feed scanned and sorted the whole log. Built CONCURRENTLY (outside a
-- transaction, one statement per file) so the hot log keeps accepting writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_acp_event_log_bot_created
    ON acp_event_log (bot_id, created_at DESC);
