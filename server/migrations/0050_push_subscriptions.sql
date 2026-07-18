-- Web Push subscriptions (PWA): one row per browser push endpoint. The endpoint
-- URL is unique per subscription by construction (the push service mints it), so
-- it is the natural primary key; re-subscribing from the same browser upserts.
-- p256dh/auth are the client keys from PushSubscription.getKey(), stored as
-- base64url (unpadded) — the sender needs them to encrypt per RFC 8291.
-- Rows die with the user, and the sender also deletes rows the push service
-- reports gone (404/410), so the table is self-cleaning.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_push_subscriptions_user
    ON push_subscriptions (user_id);
