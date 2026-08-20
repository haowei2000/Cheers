-- Workflow profiles are orthogonal to channel features. A Code Channel may
-- enable Voice while generic channel authorization stays shared.
-- The baseline used `channel_profiles` for per-user nickname/bio rows. Preserve
-- those rows under a name that reflects their actual ownership before creating
-- the channel-level workflow table.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'channel_profiles'
          AND column_name = 'user_id'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'channel_member_profiles'
    ) THEN
        ALTER TABLE channel_profiles RENAME TO channel_member_profiles;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS channel_profiles (
    channel_id VARCHAR(36) PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
    profile    VARCHAR(64) NOT NULL,
    config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by VARCHAR(36) NOT NULL REFERENCES users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT channel_profiles_profile_check CHECK (profile IN ('code'))
);

CREATE INDEX IF NOT EXISTS ix_channel_profiles_profile ON channel_profiles(profile);
