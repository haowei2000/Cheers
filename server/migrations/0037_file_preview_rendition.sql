-- Office documents get a server-side PDF rendition (generated via Gotenberg) so the
-- UI can preview them inline. The derived PDF's S3 key lives in preview_object_key;
-- conversion_attempts bounds retries so a permanently-failing document stops being
-- re-polled by the conversion worker.
--
-- Design note: status stays 'uploaded' during and after conversion. Preview readiness
-- is signalled by preview_object_key IS NOT NULL, NOT by a status flip — this keeps
-- files inside the ('uploaded','converted') list gate and avoids a broader change to
-- the file access/state semantics. 'converted' remains reserved for a future
-- doc→markdown pipeline.

ALTER TABLE file_records ADD COLUMN IF NOT EXISTS preview_object_key VARCHAR(512);
ALTER TABLE file_records ADD COLUMN IF NOT EXISTS conversion_attempts INTEGER NOT NULL DEFAULT 0;

-- Cheap candidate lookup for the conversion worker's poll.
CREATE INDEX IF NOT EXISTS idx_file_records_conversion_pending
    ON file_records (conversion_attempts, created_at)
    WHERE status = 'uploaded' AND preview_object_key IS NULL AND converted_at IS NULL;
