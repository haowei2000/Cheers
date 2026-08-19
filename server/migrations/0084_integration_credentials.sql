-- Third-party service credential custody.
--
-- `auth_external_identities` answers "which Cheers user is this person?" for
-- sign-in. It deliberately does not hold a usable provider token: `oauth.rs`
-- is built so the callback never yields one. Calling GitHub's API on a user's
-- behalf needs the opposite — a long-lived, refreshable credential — so it
-- gets its own table rather than overloading the identity row.
--
-- Tokens are stored as base64(nonce ‖ AES-256-GCM ciphertext) produced by
-- `infra::crypto::encrypt_secret`, matching `apple_auth_credentials` and
-- `users.totp_secret_encrypted`. No plaintext token is ever persisted.

CREATE TABLE IF NOT EXISTS integration_credentials (
    credential_id       VARCHAR(36) PRIMARY KEY,
    integration_id      VARCHAR(64)  NOT NULL,
    -- Who the credential acts as. A workspace-scoped credential lets an
    -- integration keep working when the installing user leaves.
    subject_type        VARCHAR(16)  NOT NULL,
    subject_id          VARCHAR(36)  NOT NULL,
    -- The account on the provider's side (a GitHub login, an Overleaf email).
    -- Not a Cheers identifier; used to attribute inbound events back to a user.
    external_account    VARCHAR(255) NOT NULL,
    access_token_enc    TEXT         NOT NULL,
    refresh_token_enc   TEXT,
    scopes              TEXT         NOT NULL DEFAULT '',
    -- NULL means the provider issued a non-expiring token.
    expires_at          TIMESTAMPTZ,
    -- Set when a refresh fails permanently; the row is kept so the UI can say
    -- "reconnect GitHub" instead of silently losing the binding.
    revoked_at          TIMESTAMPTZ,
    last_refreshed_at   TIMESTAMPTZ,
    created_by          VARCHAR(36)  NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_integration_credentials_subject
        CHECK (subject_type IN ('user', 'workspace')),
    CONSTRAINT uq_integration_credentials
        UNIQUE (integration_id, subject_type, subject_id, external_account)
);

-- The refresh worker's scan: live rows with a deadline, soonest first.
CREATE INDEX IF NOT EXISTS ix_integration_credentials_refresh
    ON integration_credentials (expires_at)
    WHERE revoked_at IS NULL AND refresh_token_enc IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_integration_credentials_subject
    ON integration_credentials (subject_type, subject_id);

-- Reuse the existing OAuth transaction machinery for the connect flow: it
-- already carries state/nonce/PKCE hashes, a deadline, an attempt counter, and
-- one-shot consumption. Only the `kind` vocabulary needs to grow.
--
-- 0064 declared these CHECKs inline and unnamed, so Postgres auto-named them
-- (`auth_transactions_check`, `_check1`, …) and the number depends on
-- declaration order. Look the constraint up by its definition instead of
-- guessing the name, and never edit 0064 itself — sqlx has checksummed it.
DO $$
DECLARE
    existing TEXT;
BEGIN
    SELECT conname INTO existing
    FROM pg_constraint
    WHERE conrelid = 'auth_transactions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%kind%'
      AND conname <> 'chk_auth_transactions_kind'
    LIMIT 1;

    IF existing IS NOT NULL THEN
        EXECUTE format('ALTER TABLE auth_transactions DROP CONSTRAINT %I', existing);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_auth_transactions_kind'
    ) THEN
        ALTER TABLE auth_transactions
            ADD CONSTRAINT chk_auth_transactions_kind
            CHECK (kind IN (
                'login', 'oauth', 'passkey_login', 'passkey_register',
                'link', 'step_up', 'integration_connect'
            ));
    END IF;
END $$;
