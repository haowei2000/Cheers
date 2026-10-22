-- A terminal receipt is committed with its message. Keep it with the durable
-- execution claim even when the message is later deleted; retries only replay
-- the matching acknowledgement and never recreate a message or an execution.
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS terminal_client_msg_id VARCHAR(36);
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS terminal_fingerprint VARCHAR(64);
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS terminal_committed_at TIMESTAMPTZ;
