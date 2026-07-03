-- Presence "status" + self-describable "information" for users and bots.
--
-- Two distinct concepts, don't conflate them:
--   • INFORMATION = the longer self-description. Already exists: users.bio and
--     bot_accounts.description/intro. No new column — we just make them editable
--     (self-service for users, owner/admin for bots).
--   • STATUS = a short, frequently-changing presence line (+ optional emoji), like
--     a Slack custom status. New columns below. Distinct from bot_accounts liveness
--     (bot_locator.is_online) and the is_disabled kill-switch — this is human-facing
--     text ("focusing", "on vacation", "reviewing PRs"), not a connectivity signal.

-- ── Users: self-service status line ──────────────────────────────────────────
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS status_text    VARCHAR(140),
    ADD COLUMN IF NOT EXISTS status_emoji   VARCHAR(32),
    ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;

-- ── Bots: status line + scheduled self-refresh config ────────────────────────
-- A bot's status can be set three ways (all write the same columns):
--   1. its owner/admin edits it in the UI (manual),
--   2. the connector calls POST /bots/:id/self-status with the bot token (the bot
--      "updates itself"),
--   3. on a schedule: the connector re-runs `status_update_prompt` every
--      `status_update_interval_minutes` and writes the answer back via #2. The
--      schedule config lives here and is handed to the connector via connector-config.
ALTER TABLE bot_accounts
    ADD COLUMN IF NOT EXISTS status_text    VARCHAR(140),
    ADD COLUMN IF NOT EXISTS status_emoji   VARCHAR(32),
    ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ,
    -- Scheduled self-update (the "定时 ask the bot" loop).
    ADD COLUMN IF NOT EXISTS status_auto_update BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS status_update_prompt TEXT,
    ADD COLUMN IF NOT EXISTS status_update_interval_minutes INTEGER,
    ADD COLUMN IF NOT EXISTS status_last_auto_update_at TIMESTAMPTZ;

-- Partial index for the scheduler's "which bots are due?" scan — only rows that
-- actually opted into auto-update, so the index stays tiny.
CREATE INDEX IF NOT EXISTS ix_bot_accounts_status_auto_update
    ON bot_accounts (status_last_auto_update_at)
    WHERE status_auto_update = TRUE;
