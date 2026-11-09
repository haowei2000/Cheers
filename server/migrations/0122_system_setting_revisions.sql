-- Review trail for admin-edited instance settings. `new_value` NULL means the
-- override was removed. Deliberately no foreign keys: the history must survive
-- user deletion.
CREATE TABLE IF NOT EXISTS system_setting_revisions (
    id          VARCHAR(36) PRIMARY KEY,
    key         VARCHAR(128) NOT NULL,
    old_value   JSONB,
    new_value   JSONB,
    actor_id    VARCHAR(36) NOT NULL,
    reason      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_system_setting_revisions_key
    ON system_setting_revisions (key, created_at DESC, id DESC);
