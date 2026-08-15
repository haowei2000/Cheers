-- Unified Workbench extension store. The legacy plugin/template tables remain
-- untouched as historical data, but the application no longer reads or writes them.
CREATE TABLE IF NOT EXISTS workbench_extensions (
    extension_id VARCHAR(64) PRIMARY KEY,
    version VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    manifest JSONB NOT NULL,
    package BYTEA NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    origin VARCHAR(16) NOT NULL DEFAULT 'admin',
    installed_by VARCHAR(36) NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT workbench_extensions_origin_check CHECK (origin IN ('admin', 'system'))
);

CREATE TABLE IF NOT EXISTS workbench_official_extension_state (
    extension_id VARCHAR(64) PRIMARY KEY,
    seeded_version VARCHAR(64) NOT NULL,
    package_sha256 VARCHAR(64) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workbench_extensions_origin
    ON workbench_extensions(origin);
