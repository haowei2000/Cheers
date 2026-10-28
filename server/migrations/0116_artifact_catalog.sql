-- One identity for channel-authored text and delivered attachments. Providers keep
-- their bytes; triggers make catalog/history updates atomic with every old writer.
CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    channel_id VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    source_kind VARCHAR(16) NOT NULL CHECK (source_kind IN ('text', 'attachment')),
    source_id VARCHAR(36) NOT NULL,
    title TEXT NOT NULL,
    path TEXT,
    content_type TEXT,
    size_bytes BIGINT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    source_version BIGINT NOT NULL,
    source_status TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    internal BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(36),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS ix_artifacts_channel_page
    ON artifacts(channel_id, created_at DESC, artifact_id DESC);

CREATE TABLE IF NOT EXISTS artifact_revisions (
    artifact_id VARCHAR(36) NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    version BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (artifact_id, version)
);

CREATE OR REPLACE FUNCTION sync_channel_artifact(provider TEXT, item JSONB, removed BOOLEAN)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    artifact artifacts%ROWTYPE;
    fingerprint TEXT := md5(item::text || removed::text);
    file_path TEXT := item->>'path';
BEGIN
    -- Unscoped uploads and directory entries are not channel artifacts.
    IF item->>'channel_id' IS NULL THEN RETURN; END IF;
    IF provider = 'text' AND COALESCE((item->>'is_dir')::boolean, FALSE) THEN
        UPDATE artifacts SET deleted_at = COALESCE(deleted_at, NOW())
          WHERE source_kind = provider AND source_id = item->>'file_id';
        RETURN;
    END IF;

    INSERT INTO artifacts (
        channel_id, source_kind, source_id, title, path, content_type, size_bytes,
        source_version, source_status, source_fingerprint, internal, created_by,
        created_at, expires_at, deleted_at
    ) VALUES (
        item->>'channel_id', provider, item->>'file_id',
        CASE WHEN provider = 'text' THEN regexp_replace(file_path, '^.*/', '')
             ELSE COALESCE(item->>'original_filename', item->>'file_id') END,
        CASE WHEN provider = 'text' THEN file_path END, item->>'content_type',
        CASE WHEN provider = 'text' THEN octet_length(COALESCE(item->>'content', ''))
             ELSE COALESCE((item->>'size_bytes')::bigint, 0) END,
        CASE WHEN provider = 'text' THEN (item->>'version')::bigint ELSE 1 END,
        CASE WHEN provider = 'text' THEN 'ready' ELSE item->>'status' END,
        fingerprint, provider = 'text' AND file_path ~ '(^|/)\.',
        COALESCE(item->>'created_by', item->>'uploader_id'),
        (item->>'created_at')::timestamptz, (item->>'expires_at')::timestamptz,
        CASE WHEN removed THEN NOW() END
    ) ON CONFLICT (source_kind, source_id) DO UPDATE SET
        channel_id = EXCLUDED.channel_id, title = EXCLUDED.title, path = EXCLUDED.path,
        content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
        source_version = EXCLUDED.source_version, source_status = EXCLUDED.source_status,
        source_fingerprint = EXCLUDED.source_fingerprint, internal = EXCLUDED.internal,
        expires_at = EXCLUDED.expires_at, deleted_at = EXCLUDED.deleted_at,
        version = artifacts.version + 1, updated_at = NOW()
    WHERE artifacts.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint
    RETURNING * INTO artifact;

    IF artifact.artifact_id IS NOT NULL THEN
        INSERT INTO artifact_revisions(artifact_id, version, snapshot)
        VALUES (artifact.artifact_id, artifact.version,
                item || jsonb_build_object('deleted', removed));
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION channel_artifact_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE provider TEXT := CASE WHEN TG_TABLE_NAME = 'context_files' THEN 'text' ELSE 'attachment' END;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Parent channel deletion cascades through the catalog independently.
        IF EXISTS (SELECT 1 FROM channels WHERE channel_id = OLD.channel_id) THEN
            PERFORM sync_channel_artifact(provider, to_jsonb(OLD), TRUE);
        END IF;
        RETURN OLD;
    END IF;
    PERFORM sync_channel_artifact(provider, to_jsonb(NEW), FALSE);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS context_file_artifact_changed ON context_files;
CREATE TRIGGER context_file_artifact_changed AFTER INSERT OR UPDATE OR DELETE ON context_files
    FOR EACH ROW EXECUTE FUNCTION channel_artifact_changed();
DROP TRIGGER IF EXISTS attachment_artifact_changed ON file_records;
CREATE TRIGGER attachment_artifact_changed AFTER INSERT OR UPDATE OR DELETE ON file_records
    FOR EACH ROW EXECUTE FUNCTION channel_artifact_changed();

-- Repeatable backfill: the fingerprint prevents duplicate revisions on a re-run.
SELECT sync_channel_artifact('text', to_jsonb(f), FALSE) FROM context_files f WHERE NOT is_dir;
SELECT sync_channel_artifact('attachment', to_jsonb(f), FALSE) FROM file_records f WHERE channel_id IS NOT NULL;
