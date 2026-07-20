-- Official workbench scenario templates, mirroring 0048's official-plugin machinery:
-- `origin` marks who owns a row ('system' = seeded from the gateway binary, 'admin' =
-- API-installed), and the state table records the last seeded manifest `version` per
-- template so an admin deletion sticks across restarts of the same release (only a
-- release shipping a HIGHER version re-seeds it).

ALTER TABLE workbench_templates
    ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'admin';

CREATE TABLE IF NOT EXISTS workbench_official_template_state (
    tpl_id         TEXT PRIMARY KEY,
    seeded_version INT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
