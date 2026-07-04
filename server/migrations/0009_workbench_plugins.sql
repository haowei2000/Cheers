-- Server-level (global) workbench plugins. A plugin = manifest (metadata, JSON) + a
-- sandboxed UI bundle (HTML/JS rendered in a sandboxed iframe on the client). Installed
-- by admins; visible to every channel. The bundle is OPAQUE to the server — it never
-- runs server-side; it runs sandboxed in the browser and reaches the workspace only via
-- the host's postMessage fs proxy (so server-side channel-role authz still applies).
CREATE TABLE IF NOT EXISTS workbench_plugins (
    plugin_id    VARCHAR(64)  PRIMARY KEY,   -- manifest id
    title        VARCHAR(255) NOT NULL,
    manifest     TEXT         NOT NULL,      -- JSON: { id, title, panels:[{id,title}], ... }
    bundle       TEXT         NOT NULL,      -- the sandboxed HTML/JS document (iframe srcdoc)
    installed_by VARCHAR(36),
    installed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
