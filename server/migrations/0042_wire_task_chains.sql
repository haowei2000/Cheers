-- Wire the dormant bot@bot chain-tracking (DECENTRALIZED_MESH §8).
--
-- `task_chains` was created in 0003 but never read/written. This migration gives
-- it a live back-pointer: every bot placeholder message carries the `chain_id`
-- of the cascade it belongs to, so a user can ⏹-cancel a whole runaway bot@bot
-- chain (not just one message), and the dispatch gate can block un-launched hops
-- of a cancelled chain.
--
-- A chain is rooted at the message that started the cascade (a user message, or a
-- bot's proactive post_message). Every hop the cascade spawns inherits the same
-- chain_id.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS chain_id VARCHAR(36);

-- Enumerating a chain's still-in-flight bot placeholders (to fan out the per-msg
-- cancel frame) and resolving a message → its chain both key on chain_id; the
-- partial-only predicate keeps the cancel-enumeration index small.
CREATE INDEX IF NOT EXISTS ix_messages_chain
    ON messages (chain_id)
    WHERE chain_id IS NOT NULL;
