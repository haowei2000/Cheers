-- Bind a channel to an external resource, and record which memberships an
-- integration projected.
--
-- Without the binding, an inbound push event has no way to find its channel
-- except pattern-matching on channel names, and nothing about sync is
-- idempotent.

CREATE TABLE IF NOT EXISTS channel_integration_bindings (
    channel_id      VARCHAR(36)  PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
    integration_id  VARCHAR(64)  NOT NULL,
    installation_id VARCHAR(36)  NOT NULL
                    REFERENCES integration_installations(installation_id) ON DELETE CASCADE,
    -- 'repo' for GitHub, 'project' for Overleaf.
    external_kind   VARCHAR(32)  NOT NULL,
    -- The provider's own identifier, e.g. 'haowei2000/Cheers'.
    external_id     VARCHAR(255) NOT NULL,
    config          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    synced_at       TIMESTAMPTZ,
    created_by      VARCHAR(36)  NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Load-bearing: makes "the channel for this repo" a single-row lookup in
    -- both directions, and stops a second channel silently binding to the same
    -- external resource.
    CONSTRAINT uq_channel_integration_binding
        UNIQUE (integration_id, installation_id, external_kind, external_id)
);

CREATE INDEX IF NOT EXISTS ix_channel_integration_bindings_lookup
    ON channel_integration_bindings (integration_id, installation_id, external_kind, external_id);

-- Which integration projected this membership, if any.
--
-- Authorization stays channel-role only: a projected row is an ordinary
-- membership with an ordinary role, and nothing in the permission check reads
-- this column. It exists so sync can tell its own rows from a human's and
-- never remove a member an admin added by hand.
ALTER TABLE channel_memberships
    ADD COLUMN IF NOT EXISTS projected_from VARCHAR(64);

CREATE INDEX IF NOT EXISTS ix_channel_memberships_projected
    ON channel_memberships (channel_id, projected_from)
    WHERE projected_from IS NOT NULL;
