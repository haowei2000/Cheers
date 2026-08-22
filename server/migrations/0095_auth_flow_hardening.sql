-- Bind step-up transactions to the exact active session and stop persisting
-- newly-issued email OTPs in plaintext.

ALTER TABLE auth_transactions
    ADD COLUMN IF NOT EXISTS session_id VARCHAR(36)
        REFERENCES auth_sessions(session_id) ON DELETE CASCADE;

-- 0064 declared multiple unnamed CHECK constraints, so PostgreSQL's generated
-- name depends on declaration order. Locate the status constraint by definition.
DO $$
DECLARE
    existing TEXT;
BEGIN
    SELECT conname INTO existing
    FROM pg_constraint
    WHERE conrelid = 'auth_transactions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
      AND conname <> 'chk_auth_transactions_status'
    LIMIT 1;

    IF existing IS NOT NULL THEN
        EXECUTE format('ALTER TABLE auth_transactions DROP CONSTRAINT %I', existing);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'auth_transactions'::regclass
          AND conname = 'chk_auth_transactions_status'
    ) THEN
        ALTER TABLE auth_transactions
            ADD CONSTRAINT chk_auth_transactions_status
            CHECK (status IN (
                'pending', 'method_required', 'factor_required', 'verified',
                'consumed', 'failed', 'expired'
            ));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_auth_transactions_session_active
    ON auth_transactions(session_id, created_at DESC)
    WHERE consumed_at IS NULL;

ALTER TABLE email_codes
    ADD COLUMN IF NOT EXISTS code_hash VARCHAR(64);

-- Existing codes were written before the keyed-hash protocol and are both
-- short-lived and non-migratable. Invalidate them instead of retaining a
-- plaintext fallback.
UPDATE email_codes
SET used = TRUE
WHERE used = FALSE AND code_hash IS NULL;

ALTER TABLE email_codes ALTER COLUMN code DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ix_email_codes_active
    ON email_codes(email, purpose, created_at DESC)
    WHERE used = FALSE;
