-- Proactive task claiming: per-channel bot monitoring policy, durable evaluation
-- reservations, and human-approved claim requests.

CREATE TABLE IF NOT EXISTS channel_bot_monitoring (
    channel_id                 VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    bot_id                     VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    mode                       VARCHAR(32) NOT NULL DEFAULT 'off',
    scope                      TEXT NOT NULL DEFAULT '',
    debounce_seconds           INTEGER NOT NULL DEFAULT 15,
    min_interval_seconds       INTEGER NOT NULL DEFAULT 60,
    max_evaluations_per_hour   INTEGER NOT NULL DEFAULT 20,
    batch_size                 INTEGER NOT NULL DEFAULT 8,
    confidence_threshold       NUMERIC(4,3) NOT NULL DEFAULT 0.750,
    last_evaluated_seq         BIGINT NOT NULL DEFAULT 0,
    next_eligible_at           TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_channel_bot_monitoring PRIMARY KEY (channel_id, bot_id),
    CONSTRAINT chk_monitoring_mode CHECK (mode IN ('off', 'text', 'text_and_transcript', 'all_activity')),
    CONSTRAINT chk_monitoring_timing CHECK (debounce_seconds BETWEEN 1 AND 3600 AND min_interval_seconds BETWEEN 1 AND 86400),
    CONSTRAINT chk_monitoring_budget CHECK (max_evaluations_per_hour BETWEEN 1 AND 1000 AND batch_size BETWEEN 1 AND 100),
    CONSTRAINT chk_monitoring_confidence CHECK (confidence_threshold BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS ix_channel_bot_monitoring_due
    ON channel_bot_monitoring(next_eligible_at) WHERE mode <> 'off';

CREATE TABLE IF NOT EXISTS task_claim_evaluations (
    evaluation_id       VARCHAR(36) PRIMARY KEY,
    channel_id          VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    bot_id              VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    source_seq_from     BIGINT NOT NULL,
    source_seq_to       BIGINT NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'reserved',
    error               TEXT,
    reserved_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatched_at       TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    CONSTRAINT uq_task_claim_evaluation_range UNIQUE (channel_id, bot_id, source_seq_from, source_seq_to),
    CONSTRAINT chk_task_claim_evaluation_range CHECK (source_seq_from > 0 AND source_seq_to >= source_seq_from),
    CONSTRAINT chk_task_claim_evaluation_status CHECK (status IN ('reserved', 'dispatched', 'completed', 'ignored', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_task_claim_evaluations_hourly
    ON task_claim_evaluations(channel_id, bot_id, reserved_at DESC);

CREATE TABLE IF NOT EXISTS task_claim_requests (
    claim_id             VARCHAR(36) PRIMARY KEY,
    evaluation_id        VARCHAR(36) NOT NULL REFERENCES task_claim_evaluations(evaluation_id) ON DELETE CASCADE,
    channel_id           VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    bot_id               VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    summary              TEXT NOT NULL,
    proposed_action      TEXT NOT NULL,
    confidence           NUMERIC(4,3) NOT NULL,
    impact               VARCHAR(16) NOT NULL DEFAULT 'medium',
    status               VARCHAR(20) NOT NULL DEFAULT 'pending',
    resolved_by          VARCHAR(36),
    resolution_note      TEXT,
    resolved_at          TIMESTAMPTZ,
    execution_msg_id     VARCHAR(36),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_task_claim_request_evaluation UNIQUE (evaluation_id),
    CONSTRAINT chk_task_claim_confidence CHECK (confidence BETWEEN 0 AND 1),
    CONSTRAINT chk_task_claim_impact CHECK (impact IN ('low', 'medium', 'high')),
    CONSTRAINT chk_task_claim_status CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'executing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS ix_task_claim_requests_channel_created
    ON task_claim_requests(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_task_claim_requests_pending
    ON task_claim_requests(channel_id, status, created_at DESC);
