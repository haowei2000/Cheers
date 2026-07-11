-- Sidebar channel listing (list_channels / list_dms) counts each channel's unread
-- message range on every load. The scan filters `is_partial = FALSE AND sender_id <> $me`
-- over `(channel_id, created_at > last_read_at)`, so a partial covering index makes it
-- index-only (no heap fetches for the is_partial / sender_id filters).
CREATE INDEX IF NOT EXISTS ix_messages_unread_scan
    ON messages (channel_id, created_at)
    INCLUDE (sender_id, msg_id)
    WHERE is_partial = FALSE;

-- Net index count on the hot `messages` table stays flat: ix_messages_channel_created_at
-- (channel_id, created_at) is a strict prefix of ix_messages_channel_created_msg_id
-- (channel_id, created_at, msg_id), so it is redundant and can go.
DROP INDEX IF EXISTS ix_messages_channel_created_at;
