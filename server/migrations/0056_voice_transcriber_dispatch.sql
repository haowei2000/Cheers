ALTER TABLE voice_sessions
    ADD COLUMN IF NOT EXISTS transcriber_dispatch_id VARCHAR(255);
