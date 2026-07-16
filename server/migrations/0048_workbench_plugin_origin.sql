-- Official (gateway-seeded) workbench plugins: provenance + seed bookkeeping.
-- Note: 0009's header comment still shows the retired `panels` manifest shape; applied
-- migrations are checksummed and immutable, so the correction lives here — the current
-- manifest shape is { id, protocol, title, renderers:[{id,title,match}] }, validated on
-- install (docs/developer/PLUGIN_DEVELOPMENT.md).

-- 'admin'  = installed via the API by an admin (the only value that existed before).
-- 'system' = seeded from the gateway binary; the binary is its source of truth, so the
--            API rejects PUT on these rows (copy under a new id to customize).
ALTER TABLE workbench_plugins
    ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'admin';

-- One row per official plugin ever seeded into THIS database: the embedded `version`
-- it has seen. Deleting the plugin row does NOT delete its state row — that is what
-- keeps an admin deletion sticky across restarts of the same release; only a release
-- shipping a HIGHER version re-seeds it.
CREATE TABLE workbench_official_plugin_state (
    plugin_id      VARCHAR(64) PRIMARY KEY,
    seeded_version INT         NOT NULL,
    seeded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
