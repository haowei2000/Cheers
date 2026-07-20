-- Idempotency ledger for LiveKit webhook delivery. LiveKit retries webhooks, so
-- provider event ids must be claimed transactionally before mutating presence.

CREATE TABLE IF NOT EXISTS voice_webhook_events (
    provider       VARCHAR(32) NOT NULL,
    event_id       VARCHAR(255) NOT NULL,
    event_type     VARCHAR(64) NOT NULL,
    provider_room_id VARCHAR(255),
    received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS ix_voice_webhook_events_received
    ON voice_webhook_events(received_at);
