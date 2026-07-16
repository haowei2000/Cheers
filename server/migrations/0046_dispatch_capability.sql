-- Bot-to-bot dispatch as a first-class capability (docs/design/BOT_DISPATCH.md).
--
-- Before this, bot@bot triggering was gated by INITIATE·prompt with the initiating
-- bot overloaded onto the human `role='bot'` / `user=<bot_id>` subject tiers — a
-- hack invisible to the owner UI and unauditable. This makes the initiating bot a
-- first-class grant subject (`subject_kind='bot'`) under a dedicated `dispatch`
-- capability, so "which bots may command bot B" is authored and evaluated in the
-- same matrix, distinct from "which humans may prompt bot B".

-- 1) Allow the new capability and the new subject kind.
ALTER TABLE bot_event_access DROP CONSTRAINT IF EXISTS chk_bea_capability;
ALTER TABLE bot_event_access
    ADD CONSTRAINT chk_bea_capability
    CHECK (capability IN ('initiate', 'see', 'respond', 'dispatch'));

ALTER TABLE bot_event_access DROP CONSTRAINT IF EXISTS chk_bea_subject_kind;
ALTER TABLE bot_event_access
    ADD CONSTRAINT chk_bea_subject_kind
    CHECK (subject_kind IN ('role', 'user', 'group', 'bot'));

-- 2) Migrate any pre-existing bot@bot hack rows to first-class bot subjects.
--    (Undocumented + never surfaced in UI, so realistically zero rows — but a
--    hand-written deny must not silently re-open when the old gate path is removed.)
--    role='bot' (all bots) → bot:* ; user=<a real bot_id> → bot:<that id>.
UPDATE bot_event_access
   SET subject_kind = 'bot', subject_id = '*', capability = 'dispatch'
 WHERE capability = 'initiate' AND event_class = 'prompt'
   AND subject_kind = 'role' AND subject_id = 'bot';

UPDATE bot_event_access
   SET subject_kind = 'bot', capability = 'dispatch'
 WHERE capability = 'initiate' AND event_class = 'prompt'
   AND subject_kind = 'user'
   AND subject_id IN (SELECT bot_id FROM bot_accounts);
