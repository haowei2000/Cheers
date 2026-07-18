-- OS push: one row per registered device token (APNs today; the platform column
-- keeps the table transport-agnostic). Rows are pruned when the transport
-- reports the token dead ("Unregistered"/"BadDeviceToken") and on logout.
CREATE TABLE IF NOT EXISTS user_devices (
    device_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    push_token    TEXT        NOT NULL UNIQUE,
    platform      VARCHAR(16) NOT NULL DEFAULT 'ios',
    device_name   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_user_devices_user ON user_devices(user_id);
