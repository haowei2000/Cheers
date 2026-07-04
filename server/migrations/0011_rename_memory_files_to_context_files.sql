-- Rename memory_files → context_files.
--
-- The table is the agent's per-channel CONTEXT workspace (files the agent pulls on
-- demand). It was never a "memory" store: conversation history is reached through a
-- separate pull interface the agent/bot calls, and the platform has no independent
-- "memory" concept (see docs/arch/context-and-environment.md «CURRENT MODEL»). The old
-- name predates that decision and is misleading; "context_files" matches the model.
--
-- Migrations 0003 (CREATE memory_files) and 0010 (a passing comment) keep their original
-- text — they are immutable history. This forward migration is the source-of-truth rename.
ALTER TABLE memory_files RENAME TO context_files;
ALTER INDEX ix_memory_files_channel RENAME TO ix_context_files_channel;
ALTER TABLE context_files
    RENAME CONSTRAINT uq_memory_files_channel_path TO uq_context_files_channel_path;
