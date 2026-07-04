-- Per-operation approvers (Axis B of docs/arch/BOT_PERMISSION_MODEL.md).
--
-- An approver delegation is now scoped to an ACP operation_kind (the opaque
-- toolCall.kind). operation_kind = '*' (the default — i.e. today's behavior)
-- means the user may resolve an 'ask' for ANY kind on this (bot, channel).
-- This pairs with bot_permission_rules (0027): a rule decides allow/deny/ask
-- per kind; approvers decide WHO may resolve an 'ask' for that kind.
ALTER TABLE approval_delegations
    ADD COLUMN IF NOT EXISTS operation_kind VARCHAR(64) NOT NULL DEFAULT '*';

-- The uniqueness key now includes operation_kind so one user can hold distinct
-- per-kind delegations. Replace the old (bot, channel, user) unique with one
-- that includes the kind; the auto-generated old name is deterministic.
ALTER TABLE approval_delegations
    DROP CONSTRAINT IF EXISTS approval_delegations_bot_id_channel_id_user_id_key;
ALTER TABLE approval_delegations
    DROP CONSTRAINT IF EXISTS approval_delegations_scope_key;
ALTER TABLE approval_delegations
    ADD CONSTRAINT approval_delegations_scope_key
        UNIQUE (bot_id, channel_id, user_id, operation_kind);
