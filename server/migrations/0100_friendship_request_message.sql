-- Add optional verification message for friend requests
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS message TEXT;
