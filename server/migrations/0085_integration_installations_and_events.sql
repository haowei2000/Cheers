-- Generic inbound webhook surface.
--
-- Before this, the only inbound webhook was LiveKit's: a bespoke route, a
-- hand-written signature check, and its own dedupe table. Every integration
-- would have cloned that shape. These two tables are the generic form.
--
-- `voice_webhook_events` (0054) is deliberately left alone. Its dedupe key is
-- already correct and the voice path still owns its own event semantics; only
-- verification was generalised, not storage.

-- One installation of one integration into one workspace. The webhook secret
-- lives here rather than in config because each installation has its own —
-- a GitHub App issues a distinct secret per installation.
CREATE TABLE IF NOT EXISTS integration_installations (
    installation_id     VARCHAR(36)  PRIMARY KEY,
    integration_id      VARCHAR(64)  NOT NULL,
    workspace_id        VARCHAR(36)  NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    -- The provider-side installation identity (a GitHub App installation id).
    external_account    VARCHAR(255) NOT NULL DEFAULT '',
    -- base64(nonce ‖ AES-256-GCM), same envelope as integration_credentials.
    -- NULL means this integration does not receive webhooks.
    webhook_secret_enc  TEXT,
    config              JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Set instead of deleting, so inbound events for a paused installation are
    -- rejected uniformly rather than looking like an unknown installation.
    disabled_at         TIMESTAMPTZ,
    installed_by        VARCHAR(36)  NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_integration_installations
        UNIQUE (integration_id, workspace_id, external_account)
);

CREATE INDEX IF NOT EXISTS ix_integration_installations_workspace
    ON integration_installations (workspace_id, integration_id);

-- Inbound events, deduplicated by the provider's own event id.
--
-- Same key shape as voice_webhook_events (0054), widened by installation:
-- two installations of one integration can legitimately see the same event id.
CREATE TABLE IF NOT EXISTS integration_webhook_events (
    integration_id   VARCHAR(64)  NOT NULL,
    installation_id  VARCHAR(36)  NOT NULL
                     REFERENCES integration_installations(installation_id) ON DELETE CASCADE,
    event_id         VARCHAR(255) NOT NULL,
    event_type       VARCHAR(128) NOT NULL,
    payload          JSONB        NOT NULL,
    received_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- NULL until the mapper has turned it into channel activity. Retrying a
    -- failed mapping must not re-admit the event, so delivery and processing
    -- are tracked separately.
    processed_at     TIMESTAMPTZ,
    process_attempts SMALLINT     NOT NULL DEFAULT 0,
    last_error       TEXT,
    PRIMARY KEY (integration_id, installation_id, event_id)
);

-- The mapper's work queue: admitted but not yet processed, oldest first.
CREATE INDEX IF NOT EXISTS ix_integration_webhook_events_pending
    ON integration_webhook_events (received_at)
    WHERE processed_at IS NULL;
