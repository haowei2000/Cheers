-- Event-centric bot permission model (docs/arch/ACP_EVENT_TAXONOMY.md +
-- BOT_PERMISSION_MODEL.md). Cheers governs, per (subject × ACP-event-class ×
-- capability), what a user may do with a bot's events:
--   * INITIATE — user→agent events (prompt / set_mode / cancel): may this subject cause it?
--   * SEE      — agent→user events (output / tool_call / plan / trace / permission_request):
--                may this subject view it?
--   * RESPOND  — answer an agent request (only permission_request today): may this subject
--                approve/reject it?
--
-- subject_kind = 'role'  → subject_id is a channel role ('owner'|'admin'|'member') or '*'
-- subject_kind = 'user'  → subject_id is a user_id (per-user override, wins over role)
-- channel_id = '' is the bot-wide default (applies to every channel).
--
-- Resolution is most-specific-wins: (channel,user) ▸ (channel,role) ▸ (channel,'*')
--   ▸ (bot-wide,user) ▸ (bot-wide,role) ▸ (bot-wide,'*') ▸ a membership-derived default
--   (members may INITIATE + SEE; RESPOND defaults to owner/approvers only).
-- This LAYERS ON channel membership — it never grants access to a non-member; it only
-- narrows (deny) or widens (RESPOND) within the channel.
--
-- This is orthogonal to bot_permission_rules (0027): that is the bot OWNER's auto-answer
-- policy for request_permission per operation_kind (allow/deny/ask); this is the per-user
-- authorization over event classes. They compose.
CREATE TABLE IF NOT EXISTS bot_event_access (
    bot_id        VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    channel_id    VARCHAR(36) NOT NULL DEFAULT '',
    subject_kind  VARCHAR(8)  NOT NULL,
    subject_id    VARCHAR(64) NOT NULL,
    event_class   VARCHAR(32) NOT NULL,
    capability    VARCHAR(16) NOT NULL,
    decision      VARCHAR(8)  NOT NULL,
    updated_by    VARCHAR(36),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_bea_subject_kind CHECK (subject_kind IN ('role', 'user')),
    CONSTRAINT chk_bea_capability   CHECK (capability IN ('initiate', 'see', 'respond')),
    CONSTRAINT chk_bea_decision     CHECK (decision IN ('allow', 'deny')),
    PRIMARY KEY (bot_id, channel_id, subject_kind, subject_id, event_class, capability)
);

CREATE INDEX IF NOT EXISTS ix_bot_event_access_bot
    ON bot_event_access (bot_id, channel_id);
