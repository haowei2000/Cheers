-- Group subjects for the event-access matrix (docs/arch/ACP_EVENT_TAXONOMY.md):
-- besides 'role' and 'user', a rule's subject may be a dynamic 'group' whose
-- subject_id is a group ref — `friends` (the bot owner's accepted friends),
-- `channel:<id>` (that channel's members), or `workspace:<id>` (that workspace's
-- members). Membership is resolved live at evaluation time.
ALTER TABLE bot_event_access DROP CONSTRAINT IF EXISTS chk_bea_subject_kind;
ALTER TABLE bot_event_access
    ADD CONSTRAINT chk_bea_subject_kind CHECK (subject_kind IN ('role', 'user', 'group'));
