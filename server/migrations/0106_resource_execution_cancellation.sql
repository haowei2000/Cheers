-- Cancellation must survive a race with terminal startup and a gateway restart.
ALTER TABLE resource_executions ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS resource_execution_user_history ON resource_executions(user_id,channel_id,created_at DESC);
