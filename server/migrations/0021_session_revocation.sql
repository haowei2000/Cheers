-- Session revocation + account suspension (W6).
--
-- token_version: bumping it invalidates every previously-issued JWT for the
--   user. The gateway embeds the user's current value in each access token and
--   rejects any request whose claim is lower (a forced logout / "sign out
--   everywhere" / suspend). Defaults to 0 so tokens minted before this column
--   existed (claim defaults to 0) keep working until they expire.
-- is_suspended: an admin-set ban flag, checked at login and on every request.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE;
