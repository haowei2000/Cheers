-- Repurpose the vestigial bot_accounts.status into an explicit admin kill-switch.
--
-- `status` was a VARCHAR set to 'online' at creation and never changed — its only
-- effect was the agent-bridge connect gate (status != 'online' → reject), which
-- therefore never fired. We replace it with an honest boolean so "disabled" can't
-- be confused with live connectivity (which is now bot_locator.is_online()).

ALTER TABLE bot_accounts
    ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve any intent of the old flag: a bot explicitly parked 'offline' becomes disabled.
UPDATE bot_accounts SET is_disabled = TRUE WHERE status = 'offline';

ALTER TABLE bot_accounts DROP COLUMN IF EXISTS status;
