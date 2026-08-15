-- Calendar-time daily schedules. Keep 0080 immutable: this migration extends
-- the protocol with an IANA timezone and a local wall-clock time.
ALTER TABLE scheduled_messages
    ADD COLUMN IF NOT EXISTS local_time TIME,
    ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);

ALTER TABLE scheduled_messages
    DROP CONSTRAINT IF EXISTS scheduled_messages_kind_check,
    DROP CONSTRAINT IF EXISTS scheduled_messages_shape_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'scheduled_messages_kind_check'
          AND conrelid = 'scheduled_messages'::regclass
    ) THEN
        ALTER TABLE scheduled_messages
            ADD CONSTRAINT scheduled_messages_kind_check
            CHECK (schedule_kind IN ('once', 'interval', 'daily'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'scheduled_messages_shape_check'
          AND conrelid = 'scheduled_messages'::regclass
    ) THEN
        ALTER TABLE scheduled_messages
            ADD CONSTRAINT scheduled_messages_shape_check CHECK (
                (schedule_kind = 'once' AND run_at IS NOT NULL
                 AND interval_minutes IS NULL AND local_time IS NULL AND timezone IS NULL)
                OR
                (schedule_kind = 'interval' AND run_at IS NULL
                 AND interval_minutes BETWEEN 5 AND 10080
                 AND local_time IS NULL AND timezone IS NULL)
                OR
                (schedule_kind = 'daily' AND run_at IS NULL
                 AND interval_minutes IS NULL AND local_time IS NOT NULL AND timezone IS NOT NULL)
            );
    END IF;
END $$;
