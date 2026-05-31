-- Persist capability rejection decisions for audit and troubleshooting.

CREATE TABLE IF NOT EXISTS acp_capability_reject_logs (
    log_id                      BIGSERIAL PRIMARY KEY,
    bot_id                      VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    provider_account_id         VARCHAR(255) NOT NULL,
    delegation_id               VARCHAR(36) REFERENCES acp_capability_delegations(delegation_id) ON DELETE SET NULL,
    decision_scope_type         VARCHAR(16),
    decision_scope_id           VARCHAR(128),
    frame_type                  VARCHAR(32) NOT NULL,
    action                      VARCHAR(32),
    request_id                  TEXT,
    request_session_id          VARCHAR(36),
    resolved_session_id         VARCHAR(36),
    resolved_session_status     VARCHAR(32),
    resolved_session_scope_type VARCHAR(16),
    resolved_session_scope_id   VARCHAR(128),
    session_locator_source      VARCHAR(32),
    session_locator_value       VARCHAR(255),
    resource                    VARCHAR(255),
    decision_reason             TEXT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_acp_capability_reject_logs_bot_created
    ON acp_capability_reject_logs (bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_acp_capability_reject_logs_delegation
    ON acp_capability_reject_logs (delegation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_acp_capability_reject_logs_scope
    ON acp_capability_reject_logs (decision_scope_type, decision_scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_acp_capability_reject_logs_locator
    ON acp_capability_reject_logs (session_locator_source, session_locator_value, created_at DESC);
