-- no-transaction
-- Fleet audit reads each visible bot's newest approval events; the existing
-- index is keyed by channel. Built CONCURRENTLY, one statement per file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_approval_audit_bot_created
    ON approval_audit (bot_id, created_at DESC);
