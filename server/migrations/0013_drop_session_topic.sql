-- Remove the "topic" conversation scope (scope cut 2026-06-24: v1 keeps only channel + DM).
-- `cheers_session_bindings.topic_id` was the only schema trace of a topic-scoped session;
-- it has no constraint/index dependency (the scope unique key is on scope_type+scope_id),
-- so it drops cleanly. The "topic" scope_type is removed in code (domain/sessions.rs); any
-- legacy "topic" rows keep their scope_type string harmlessly (never produced again).
ALTER TABLE cheers_session_bindings DROP COLUMN IF EXISTS topic_id;
