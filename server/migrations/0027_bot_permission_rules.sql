-- Axis B of the bot permission model (docs/arch/BOT_PERMISSION_MODEL.md):
-- a per-(bot, channel, operation_kind) authorization rule. When an ACP
-- session/request_permission is forwarded, the gateway evaluates the
-- most-specific matching rule:
--   allow → auto-approve, deny → auto-reject, ask → route to approvers (card).
--
-- channel_id = '' is the bot-wide default (applies to every channel);
-- operation_kind = '*' is the catch-all (any ACP toolCall.kind). The kind is an
-- opaque ACP string — the gateway never interprets its meaning.
CREATE TABLE IF NOT EXISTS bot_permission_rules (
    bot_id         VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    channel_id     VARCHAR(36) NOT NULL DEFAULT '',
    operation_kind VARCHAR(64) NOT NULL,
    decision       VARCHAR(8)  NOT NULL,
    updated_by     VARCHAR(36),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_bot_permission_rules_decision CHECK (decision IN ('allow', 'deny', 'ask')),
    PRIMARY KEY (bot_id, channel_id, operation_kind)
);

CREATE INDEX IF NOT EXISTS ix_bot_permission_rules_bot ON bot_permission_rules (bot_id);
