-- Human-message triggers and their recoverable offers share the durable run
-- ledger. Historical runs without dispatch_input remain non-replayable.
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS dispatch_input JSONB;
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS task_frame JSONB;
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS next_offer_at TIMESTAMPTZ;
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS dispatch_lease_id VARCHAR(36);
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS dispatch_lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_bot_runs_due_human_dispatch
    ON bot_runs (next_offer_at, created_at, bot_run_id)
    WHERE dispatch_input IS NOT NULL
      AND status IN ('pending', 'prepared')
      AND execution_id IS NULL;
