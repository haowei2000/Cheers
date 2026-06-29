-- Retire the per-tool-kind auto-answer policy (old "Axis B"). In the event-centric
-- model (docs/arch/ACP_EVENT_TAXONOMY.md) the agent decides WHEN to ask, the
-- connector gates which event-TYPES pass, and Cheers routes the answer to
-- RESPOND-authorized users (bot_event_access). Cheers no longer auto-answers a
-- request_permission per tool kind, so this table is removed.
DROP TABLE IF EXISTS bot_permission_rules;
