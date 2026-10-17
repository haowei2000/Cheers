-- Resource identity is independent of path, viewer and device.
CREATE TABLE IF NOT EXISTS resource_service_identity (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    service_id VARCHAR(36) NOT NULL DEFAULT gen_random_uuid()::text
);
INSERT INTO resource_service_identity(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS resource_revisions (
    resource_id VARCHAR(36) NOT NULL,
    version BIGINT NOT NULL,
    channel_id VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    is_dir BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(resource_id, version)
);
INSERT INTO resource_revisions(resource_id,version,channel_id,path,content,is_dir)
SELECT file_id,version,channel_id,path,content,is_dir FROM context_files ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION capture_resource_revision() RETURNS trigger AS $$
BEGIN
    INSERT INTO resource_revisions(resource_id,version,channel_id,path,content,is_dir)
    VALUES(NEW.file_id,NEW.version,NEW.channel_id,NEW.path,NEW.content,NEW.is_dir)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS context_file_revision ON context_files;
CREATE TRIGGER context_file_revision AFTER INSERT OR UPDATE ON context_files
FOR EACH ROW EXECUTE FUNCTION capture_resource_revision();

CREATE TABLE IF NOT EXISTS resource_view_drafts (
    user_id VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    resource_id VARCHAR(36) NOT NULL,
    view_id VARCHAR(128) NOT NULL,
    schema_version BIGINT NOT NULL,
    source_version BIGINT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,resource_id,view_id,schema_version),
    CHECK(octet_length(data::text) <= 65536)
);

CREATE TABLE IF NOT EXISTS resource_executions (
    execution_id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    channel_id VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    bot_id VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    host_id VARCHAR(36) NOT NULL,
    invocation_id VARCHAR(36) NOT NULL,
    request JSONB NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'accepted',
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id,invocation_id),
    CHECK(status IN ('accepted','running','succeeded','failed','cancelled','unknown'))
);
