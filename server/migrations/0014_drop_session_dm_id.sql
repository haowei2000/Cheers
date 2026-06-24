-- Fold the "dm" session scope into "channel" (decision 2026-06-24, CONVERSATION_MODEL.md):
-- a DM is a type='dm' channel, so a DM session's scope IS that channel. The dm_id
-- denormalized projection is redundant with channel_id and is dropped; the "dm" scope_type
-- folds into "channel" in code (domain/sessions.rs). Like topic_id (0013), dm_id has no
-- constraint/index dependency (the scope unique key is scope_type+scope_id), so it drops cleanly.
ALTER TABLE cheers_session_bindings DROP COLUMN IF EXISTS dm_id;
