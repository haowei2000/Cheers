-- Global workbench scenario TEMPLATES (file/data, NOT code). A template is a declarative
-- manifest (JSON: views referencing built-in lenses + optional seed files). It carries NO
-- executable code, so — unlike a plugin — it needs no sandbox. It is server-level (global):
-- an admin installs it once and every user sees it in the scenario picker. Activating a
-- template seeds its data files into the current channel's workspace (memory_files); the
-- row here is just the reusable definition. Ad-hoc/one-off templates are NOT stored here —
-- a user can upload a manifest that lives only in their browser session (see frontend).
CREATE TABLE IF NOT EXISTS workbench_templates (
    tpl_id       VARCHAR(64)  PRIMARY KEY,   -- manifest id
    title        VARCHAR(255) NOT NULL,
    manifest     TEXT         NOT NULL,      -- JSON: { id, title, views:[...], seed:{...} }
    installed_by VARCHAR(36),
    installed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
