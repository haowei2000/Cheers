-- `terminal_installations` named the wrong thing. A row is a machine running a
-- connector daemon — a host — while "installation" in this codebase also means a
-- provider-side install (`integration_installations`, which keeps the name because
-- GitHub's own API returns `installation.id`). One word for two unrelated concepts
-- is why the two `/installations` route families read as a collision.
--
-- A rename leaves indexes and constraints on their old names, so each is renamed
-- explicitly. Every statement is guarded so a database already carrying the new
-- names is left alone.
--
-- `bot_management_audit.event_type` is deliberately NOT backfilled. Rows written
-- before this migration say `installation.revoked`; rows after say `host.revoked`.
-- An audit log records what happened under the words in force at the time, and
-- nothing reads the value as an enum — the fleet timeline renders it verbatim
-- (frontend/src/features/fleet/FleetAudit.tsx), so both spellings display fine.

DO $$
BEGIN
    IF to_regclass('public.terminal_installations') IS NOT NULL
       AND to_regclass('public.connector_hosts') IS NULL THEN
        ALTER TABLE terminal_installations RENAME TO connector_hosts;
    END IF;
END $$;

DO $$
DECLARE
    target RECORD;
BEGIN
    -- The primary key travels to every table that references it.
    FOR target IN
        SELECT unnest(ARRAY[
            'connector_hosts',
            'enrollment_codes',
            'mcp_oauth_authorization_codes',
            'mcp_oauth_refresh_tokens',
            'bot_management_audit'
        ]) AS name
    LOOP
        IF to_regclass('public.' || target.name) IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = target.name
                 AND column_name = 'installation_id'
           ) THEN
            EXECUTE format('ALTER TABLE %I RENAME COLUMN installation_id TO host_id', target.name);
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    renaming RECORD;
BEGIN
    FOR renaming IN
        SELECT * FROM (VALUES
            ('terminal_installations_pkey',                  'connector_hosts_pkey'),
            ('terminal_installations_credential_hash_key',   'connector_hosts_credential_hash_key'),
            ('ix_terminal_installations_bot',                'ix_connector_hosts_bot'),
            ('uq_terminal_installations_one_active_per_bot', 'uq_connector_hosts_one_active_per_bot'),
            ('uq_enrollment_codes_installation',             'uq_enrollment_codes_host'),
            ('ix_mcp_oauth_refresh_installation',            'ix_mcp_oauth_refresh_host'),
            ('ix_bot_management_audit_installation',         'ix_bot_management_audit_host')
        ) AS t(old, new)
    LOOP
        IF to_regclass('public.' || renaming.old) IS NOT NULL
           AND to_regclass('public.' || renaming.new) IS NULL THEN
            EXECUTE format('ALTER INDEX %I RENAME TO %I', renaming.old, renaming.new);
        END IF;
    END LOOP;
END $$;

-- Foreign-key and CHECK constraints are not indexes, so they are renamed against
-- pg_constraint. Their auto-generated names embed the old table and column.
DO $$
DECLARE
    renaming RECORD;
BEGIN
    FOR renaming IN
        SELECT * FROM (VALUES
            ('connector_hosts', 'terminal_installations_bot_id_fkey',                  'connector_hosts_bot_id_fkey'),
            ('connector_hosts', 'terminal_installations_status_check',                 'connector_hosts_status_check'),
            ('connector_hosts', 'terminal_installations_mcp_connection_state_check',    'connector_hosts_mcp_connection_state_check'),
            ('enrollment_codes', 'enrollment_codes_installation_id_fkey',              'enrollment_codes_host_id_fkey'),
            ('mcp_oauth_authorization_codes', 'mcp_oauth_authorization_codes_installation_id_fkey', 'mcp_oauth_authorization_codes_host_id_fkey'),
            ('mcp_oauth_refresh_tokens', 'mcp_oauth_refresh_tokens_installation_id_fkey', 'mcp_oauth_refresh_tokens_host_id_fkey')
        ) AS t(table_name, old, new)
    LOOP
        IF EXISTS (
               SELECT 1 FROM pg_constraint
               WHERE conname = renaming.old
                 AND conrelid = to_regclass('public.' || renaming.table_name)
           )
           AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = renaming.new) THEN
            EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                           renaming.table_name, renaming.old, renaming.new);
        END IF;
    END LOOP;
END $$;
