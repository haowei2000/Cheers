-- Staged file support: bot registers a remote-path reference without uploading content.
-- The file is uploaded on-demand when the user clicks "realize".
ALTER TABLE file_records ADD COLUMN IF NOT EXISTS remote_ref TEXT;
