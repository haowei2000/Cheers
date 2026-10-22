-- The existing run record owns the first execution grant. Keep it after a
-- placeholder is deleted so a reconnect or retry cannot re-execute that task.
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS execution_id VARCHAR(36);
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS execution_connection_id VARCHAR(36);
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
