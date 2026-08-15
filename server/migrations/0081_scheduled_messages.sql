-- Durable user-owned tasks whose action is posting a message into a channel.
-- Extension automations may create instances of these tasks, but installed
-- extension definitions and scheduled task state intentionally have separate
-- lifecycles.
CREATE TABLE IF NOT EXISTS scheduled_messages (
    task_id VARCHAR(36) PRIMARY KEY,
    created_by VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    channel_id VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL,
    content TEXT NOT NULL,
    mention_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    schedule_kind VARCHAR(16) NOT NULL,
    run_at TIMESTAMPTZ,
    interval_minutes INTEGER,
    next_run_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    source_extension_id VARCHAR(64),
    source_automation_id VARCHAR(64),
    lease_until TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT scheduled_messages_kind_check
        CHECK (schedule_kind IN ('once', 'interval')),
    CONSTRAINT scheduled_messages_shape_check CHECK (
        (schedule_kind = 'once' AND run_at IS NOT NULL AND interval_minutes IS NULL)
        OR
        (schedule_kind = 'interval' AND run_at IS NULL
         AND interval_minutes BETWEEN 5 AND 10080)
    ),
    CONSTRAINT scheduled_messages_source_check CHECK (
        (source_extension_id IS NULL) = (source_automation_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
    ON scheduled_messages(next_run_at)
    WHERE enabled = TRUE AND next_run_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_owner
    ON scheduled_messages(created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_message_runs (
    run_id VARCHAR(36) PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL REFERENCES scheduled_messages(task_id) ON DELETE CASCADE,
    scheduled_for TIMESTAMPTZ NOT NULL,
    trigger VARCHAR(16) NOT NULL DEFAULT 'schedule',
    status VARCHAR(16) NOT NULL DEFAULT 'running',
    message_id VARCHAR(36),
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT scheduled_message_runs_trigger_check
        CHECK (trigger IN ('schedule', 'manual')),
    CONSTRAINT scheduled_message_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'failed')),
    CONSTRAINT scheduled_message_runs_unique UNIQUE (task_id, scheduled_for, trigger)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_message_runs_task
    ON scheduled_message_runs(task_id, started_at DESC);
