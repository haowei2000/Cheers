-- Grants and terminal commits resolve older claims through their persisted
-- execution-message link, including rows created before placeholder markers.
-- Ordinary tasks also make this lookup, so keep absent matches inexpensive.
CREATE INDEX IF NOT EXISTS ix_task_claim_requests_execution_message
    ON task_claim_requests(execution_msg_id)
    WHERE execution_msg_id IS NOT NULL;
