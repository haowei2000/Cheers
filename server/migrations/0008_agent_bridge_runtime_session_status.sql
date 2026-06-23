-- Agent Bridge runtime session lifecycle states.
--
-- Existing statuses remain valid; paused/terminated are needed by
-- runtime_session_control(create/pause/terminate/resume) acknowledgements.

ALTER TABLE cheers_sessions
    DROP CONSTRAINT IF EXISTS chk_cheers_sessions_status;

ALTER TABLE cheers_sessions
    ADD CONSTRAINT chk_cheers_sessions_status
    CHECK (status IN ('active', 'busy', 'idle', 'paused', 'terminated', 'revoked', 'expired', 'error'));
