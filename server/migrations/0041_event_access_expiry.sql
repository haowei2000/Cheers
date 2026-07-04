-- Optional expiry for bot event-access rules (time-boxed grants). NULL = permanent
-- (every pre-existing row keeps today's behavior). Enforcement filters expired rows
-- at resolution time (bot_event_policy::load_rules); expired rules remain listed in
-- the owner UI (marked as expired) until deleted, so a lapsed grant stays visible
-- instead of silently vanishing.
ALTER TABLE bot_event_access ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
