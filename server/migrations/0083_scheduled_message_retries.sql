-- Retry only failures known to happen before message persistence. The original
-- scheduled timestamp remains stable while next_run_at temporarily points at the
-- retry wake-up time.
ALTER TABLE scheduled_messages
    ADD COLUMN IF NOT EXISTS retry_attempt INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retry_scheduled_for TIMESTAMPTZ;

ALTER TABLE scheduled_message_runs
    ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;

ALTER TABLE scheduled_message_runs
    DROP CONSTRAINT IF EXISTS scheduled_message_runs_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_message_runs_attempt
    ON scheduled_message_runs(task_id, scheduled_for, trigger, attempt);
