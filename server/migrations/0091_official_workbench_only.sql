-- Server-stored Workbench packages are release-managed official content only.
-- Personal and temporary extensions stay on the client and are never persisted here.
DELETE FROM workbench_extensions WHERE origin = 'admin';

ALTER TABLE workbench_extensions
    DROP CONSTRAINT IF EXISTS workbench_extensions_origin_check;

ALTER TABLE workbench_extensions
    ADD CONSTRAINT workbench_extensions_origin_check CHECK (origin = 'system');
