-- Fleet inbox pending scan (fleet::find_pending_for_user / find_pending_for_user_all)
-- selects unresolved `permission` messages `ORDER BY created_at DESC LIMIT 100`. With no
-- index on `msg_type`, that scan reads the hot `messages` table by created_at and filters
-- rows post-hoc. A partial index on the small `permission` subset makes the ordered scan
-- index-driven (permission rows are a tiny fraction of all messages), so the badge/fleet
-- queries touch only pending cards instead of walking the whole timeline.
CREATE INDEX IF NOT EXISTS ix_messages_pending_permission
    ON messages (created_at DESC)
    WHERE msg_type = 'permission';
