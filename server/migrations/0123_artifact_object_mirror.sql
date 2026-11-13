-- F2 expand only. Provider reads and revision snapshots remain authoritative.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS object_key TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS object_bucket TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS sha256 VARCHAR(64);
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS legacy_id VARCHAR(36);
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS object_key TEXT;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS object_bucket TEXT;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS sha256 VARCHAR(64);
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS verification_error TEXT;
ALTER TABLE artifact_revisions ALTER COLUMN snapshot DROP NOT NULL;
CREATE INDEX IF NOT EXISTS ix_artifacts_legacy_id ON artifacts(legacy_id);
CREATE INDEX IF NOT EXISTS ix_artifact_revision_verification
    ON artifact_revisions(verified_at NULLS FIRST, artifact_id, version)
    WHERE object_key IS NOT NULL AND sha256 IS NOT NULL;

-- A revision and its copy intent commit atomically for EVERY provider writer.
-- No historical rows are enqueued here: that is the separate resumable F3 backfill.
CREATE TABLE IF NOT EXISTS artifact_object_jobs (
    artifact_id VARCHAR(36) NOT NULL,
    version BIGINT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_token VARCHAR(36),
    lease_until TIMESTAMPTZ,
    last_error TEXT,
    PRIMARY KEY (artifact_id, version),
    FOREIGN KEY (artifact_id, version) REFERENCES artifact_revisions(artifact_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_artifact_object_jobs_due ON artifact_object_jobs(next_attempt_at);

CREATE OR REPLACE FUNCTION reset_artifact_object_head() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.legacy_id := NEW.source_id;
    IF TG_OP = 'INSERT' OR NEW.version IS DISTINCT FROM OLD.version THEN
        NEW.object_key := NULL;
        NEW.object_bucket := NULL;
        NEW.sha256 := NULL;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS artifact_object_head ON artifacts;
CREATE TRIGGER artifact_object_head BEFORE INSERT OR UPDATE OF version ON artifacts
    FOR EACH ROW EXECUTE FUNCTION reset_artifact_object_head();

CREATE OR REPLACE FUNCTION enqueue_artifact_object() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE provider TEXT;
BEGIN
    SELECT source_kind INTO provider FROM artifacts WHERE artifact_id = NEW.artifact_id;
    IF provider = 'text' OR (
        NEW.snapshot->>'object_key' IS NOT NULL AND
        NEW.snapshot->>'status' IN ('uploaded', 'converted') AND
        NOT COALESCE((NEW.snapshot->>'deleted')::boolean, FALSE)
    ) THEN
        INSERT INTO artifact_object_jobs(artifact_id, version)
        VALUES (NEW.artifact_id, NEW.version) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS artifact_object_enqueue ON artifact_revisions;
CREATE TRIGGER artifact_object_enqueue AFTER INSERT ON artifact_revisions
    FOR EACH ROW EXECUTE FUNCTION enqueue_artifact_object();

-- Only keys minted by this worker are eligible for orphan cleanup. Attachment keys
-- belong to file_records and its expiry lifecycle, so they never enter this ledger.
CREATE TABLE IF NOT EXISTS artifact_object_uploads (
    object_bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,
    artifact_id VARCHAR(36) NOT NULL,
    version BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (object_bucket, object_key)
);
CREATE INDEX IF NOT EXISTS ix_artifact_object_uploads_age ON artifact_object_uploads(created_at);
