-- Phase 2 of the session-model refactor: allow MULTIPLE sessions per channel
-- without a "topic" concept. A channel has exactly ONE primary (default) session
-- plus any number of "other" sessions addressed by their session_id.
--
-- The old one-binding-per-scope unique forbade a second session in the same
-- channel. Replace it with a PRIMARY-ONLY partial unique: at most one
-- role='primary' binding per (bot, scope), and unlimited non-primary bindings.

ALTER TABLE cheers_session_bindings
    DROP CONSTRAINT IF EXISTS uq_cheers_session_binding_scope;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cheers_session_binding_primary
    ON cheers_session_bindings (
        bot_id, provider, provider_agent_id, provider_account_id, scope_type, scope_id
    )
    WHERE role = 'primary';
