-- Broaden two-factor authentication beyond the authenticator app.
--
-- Before this migration `users.totp_enabled` *was* the 2FA switch: the only way to
-- arm a second factor was to enrol TOTP, so passkey-only users were treated as
-- having no 2FA at all (and were blocked from remote agent access).
--
-- The new model: 2FA is on when at least one second factor is armed.
--   * totp    -> users.totp_enabled            (explicit enrolment, unchanged)
--   * passkey -> any row in webauthn_credentials (armed automatically)
--   * email   -> users.email_2fa_enabled       (explicit opt-in, added here)
--
-- Recovery codes (users.backup_codes) become account-level rather than
-- TOTP-specific: they are minted when the first factor of any kind is armed.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_2fa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
