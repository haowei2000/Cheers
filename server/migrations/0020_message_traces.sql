-- Durable, append-only agent-trace timeline anchored to the bot-turn message it
-- belongs to. "Approve" folds in as kind='approval' rows so the approval
-- lifecycle (requested -> resolved/expired) interleaves with tool_call/plan/
-- thought traces for the same turn. See docs/arch/TRACE_PERSISTENCE.md.
--
-- Design discipline (mirrors 0019_acp_approval.sql + AGENTS.md):
--   * VARCHAR(36) ids (never UUID type).
--   * IF NOT EXISTS everywhere (idempotent; safe on a clean or live DB).
--   * Constraints INLINE only (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
--   * NO foreign keys -- an audit/trace trail must outlive a hard-deleted
--     message/bot/channel; the anchor msg_id may also be a session id during
--     history replay, which has no messages row.
--   * Purely ADDITIVE: no ALTER to messages or approval_audit, so existing sqlx
--     checksums and the working approval flow are untouched.

CREATE TABLE IF NOT EXISTS message_traces (
    id            VARCHAR(36) PRIMARY KEY,          -- uuid v4, gateway-minted
    msg_id        VARCHAR(36) NOT NULL,             -- ANCHOR: bot-turn placeholder messages.msg_id
                                                    -- (= ActiveRun.msg_id = content_data.source_msg_id)
    channel_id    VARCHAR(36) NOT NULL,             -- routing / authz scope (no FK)
    bot_id        VARCHAR(36),                      -- sender bot (no FK)
    task_id       VARCHAR(36),                      -- run/task correlation
    run_id        VARCHAR(128),                     -- acp_session_id (a msg_id may span runs)
    trace_seq     BIGINT NOT NULL,                  -- SERVER-stamped, monotonic per msg_id
    stream        VARCHAR(16) NOT NULL DEFAULT 'acp',
    kind          VARCHAR(16) NOT NULL DEFAULT 'trace', -- 'trace' | 'approval'
    phase         VARCHAR(48) NOT NULL,             -- tool_call|plan|prompt_*|approval|...
    status        VARCHAR(32),                      -- running|completed|error|cancelled
    title         TEXT,
    message       TEXT,
    data          JSONB,                            -- plan entries, tool detail, approval reason/options
    -- Approval lifecycle promoted to first-class columns; populated only when
    -- kind='approval', NULL otherwise.
    request_id    VARCHAR(64),
    approval_kind VARCHAR(32),                      -- requested|auto_allowed|rejected|resolved|expired
    decision      VARCHAR(32),                      -- allow_once|allow_always|reject_*|expired
    option_id     VARCHAR(128),
    actor_id      VARCHAR(36),                      -- resolver (resolve only)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (msg_id, trace_seq)                      -- per-anchor ordering + idempotency guard
);

-- Per-turn read (display + "the trace that led to this approval").
CREATE INDEX IF NOT EXISTS idx_traces_msg ON message_traces (msg_id, trace_seq);

-- Channel-wide audit feed + cheap "approvals only" filter.
CREATE INDEX IF NOT EXISTS idx_traces_channel_kind
    ON message_traces (channel_id, kind, created_at DESC);

-- Approval-by-request lookups ("the lifecycle of request X").
CREATE INDEX IF NOT EXISTS idx_traces_request ON message_traces (request_id)
    WHERE request_id IS NOT NULL;

-- Retention prune support: age out high-frequency trace rows, keep approval rows.
CREATE INDEX IF NOT EXISTS idx_traces_prune ON message_traces (created_at)
    WHERE kind = 'trace';
