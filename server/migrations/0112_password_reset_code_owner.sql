-- Reset proof belongs to the account selected when it was issued, not to a
-- later arbitrary match on a case-folded mailbox address.
ALTER TABLE email_codes
    ADD COLUMN IF NOT EXISTS user_id VARCHAR(36) REFERENCES users(user_id) ON DELETE CASCADE;

-- Existing reset codes have no provable account binding. Request a new code;
-- other email-code purposes retain their existing contract.
UPDATE email_codes SET used = TRUE
WHERE purpose = 'password_reset' AND user_id IS NULL AND used = FALSE;

CREATE INDEX IF NOT EXISTS ix_email_codes_reset_owner
    ON email_codes(user_id, id)
    WHERE purpose = 'password_reset' AND used = FALSE;
