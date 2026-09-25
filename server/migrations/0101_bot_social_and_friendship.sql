-- Add social policy columns to bot_accounts and loosen friendship FK to allow bots as social actors.

ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'public';
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS friend_policy VARCHAR(16) NOT NULL DEFAULT 'open';
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS invite_policy VARCHAR(16) NOT NULL DEFAULT 'require_approval';

-- Allow friendships between users and bots (Actor model)
ALTER TABLE friendships DROP CONSTRAINT IF EXISTS friendships_user_id_fkey;
ALTER TABLE friendships DROP CONSTRAINT IF EXISTS friendships_friend_id_fkey;
