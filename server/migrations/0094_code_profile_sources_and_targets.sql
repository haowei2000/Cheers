-- Separate optional remote repository metadata from the Host-local execution target.
-- Existing GitHub profiles keep their remote source. Their old optional bot_id did not
-- identify a concrete Host or primary checkout, so it cannot be promoted safely.
UPDATE channel_profiles
SET config = jsonb_strip_nulls(jsonb_build_object(
        'remote_source', CASE
            WHEN config ? 'repository' THEN jsonb_build_object(
                'kind', 'github',
                'installation_id', config->'installation_id',
                'repository', config->'repository',
                'branch', config->'branch'
            )
            ELSE NULL
        END,
        'execution_target', NULL
    )),
    status = status - 'workspace_path',
    updated_at = NOW()
WHERE profile = 'code'
  AND (config ? 'repository' OR config ? 'installation_id' OR config ? 'bot_id');
