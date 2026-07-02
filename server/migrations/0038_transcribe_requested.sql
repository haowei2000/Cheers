-- Transcription becomes user-initiated (opt-in per file) instead of automatic:
-- the transcription worker only picks up audio files whose uploader/viewer
-- clicked "transcribe". NULL = never requested.
ALTER TABLE file_records ADD COLUMN IF NOT EXISTS transcribe_requested_at TIMESTAMPTZ;

-- Worker candidate scan: requested, not yet transcribed.
CREATE INDEX IF NOT EXISTS ix_file_records_transcribe_pending
    ON file_records (transcribe_requested_at)
    WHERE transcribe_requested_at IS NOT NULL AND md_path IS NULL;
