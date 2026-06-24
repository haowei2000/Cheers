-- DM dedup (decision 2026-06-24, CONVERSATION_MODEL.md). A DM is a type='dm' channel; at
-- most one DM should exist per participant pair. `dm_key` is the canonical, order-independent
-- key of the two members (tagged + sorted, e.g. "u:<a>|u:<b>" or "b:<bot>|u:<user>"). The
-- partial unique index enforces one-DM-per-pair and makes find-or-create race-safe.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS dm_key VARCHAR(160);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channels_dm_key
    ON channels (dm_key)
    WHERE type = 'dm';
