-- Unified user authentication protocol. User access tokens are bound to an
-- auth_sessions row; refresh/trusted-device secrets are stored only as hashes.

ALTER TABLE auth_external_identities
    ADD COLUMN IF NOT EXISTS issuer VARCHAR(512) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS provider_config_id VARCHAR(128) NOT NULL DEFAULT 'default';

UPDATE auth_external_identities
SET issuer = 'https://appleid.apple.com'
WHERE provider = 'apple' AND issuer = '';

ALTER TABLE auth_external_identities
    DROP CONSTRAINT IF EXISTS uq_auth_external_identities_provider_subject;

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_external_identities_provider_key
    ON auth_external_identities(provider, issuer, provider_config_id, subject);

CREATE TABLE IF NOT EXISTS auth_transactions (
    transaction_id     VARCHAR(36) PRIMARY KEY,
    user_id            VARCHAR(36) REFERENCES users(user_id) ON DELETE CASCADE,
    kind               VARCHAR(32) NOT NULL,
    status             VARCHAR(24) NOT NULL DEFAULT 'pending',
    provider           VARCHAR(32),
    client_type        VARCHAR(16) NOT NULL,
    redirect_uri       VARCHAR(2048),
    state_hash         VARCHAR(64),
    nonce_hash         VARCHAR(64),
    pkce_verifier_hash VARCHAR(64),
    challenge_json     JSONB,
    context_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    failed_attempts    SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    expires_at         TIMESTAMPTZ NOT NULL,
    consumed_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN ('pending', 'factor_required', 'verified', 'consumed', 'failed', 'expired')),
    CHECK (kind IN ('login', 'oauth', 'passkey_login', 'passkey_register', 'link', 'step_up')),
    CHECK (client_type IN ('web', 'ios', 'macos'))
);

CREATE INDEX IF NOT EXISTS ix_auth_transactions_user
    ON auth_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_auth_transactions_expiry
    ON auth_transactions(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id          VARCHAR(36) PRIMARY KEY,
    user_id             VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    client_type         VARCHAR(16) NOT NULL,
    device_name         VARCHAR(255),
    token_family_id     VARCHAR(36) NOT NULL,
    csrf_token_hash     VARCHAR(64),
    authenticated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    step_up_at          TIMESTAMPTZ,
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    revoke_reason       VARCHAR(64),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (client_type IN ('web', 'ios', 'macos'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_sessions_token_family
    ON auth_sessions(token_family_id);
CREATE INDEX IF NOT EXISTS ix_auth_sessions_user_active
    ON auth_sessions(user_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    refresh_token_id VARCHAR(36) PRIMARY KEY,
    session_id       VARCHAR(36) NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
    token_hash       VARCHAR(64) NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL,
    replaced_by_id   VARCHAR(36) REFERENCES auth_refresh_tokens(refresh_token_id),
    consumed_at      TIMESTAMPTZ,
    revoked_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_refresh_tokens_hash
    ON auth_refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS ix_auth_refresh_tokens_session
    ON auth_refresh_tokens(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trusted_devices (
    trusted_device_id VARCHAR(36) PRIMARY KEY,
    user_id           VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_id        VARCHAR(36) REFERENCES auth_sessions(session_id) ON DELETE SET NULL,
    credential_hash   VARCHAR(64) NOT NULL,
    device_name       VARCHAR(255),
    expires_at        TIMESTAMPTZ NOT NULL,
    last_used_at      TIMESTAMPTZ,
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trusted_devices_credential_hash
    ON trusted_devices(credential_hash);
CREATE INDEX IF NOT EXISTS ix_trusted_devices_user_active
    ON trusted_devices(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webauthn_credentials (
    credential_pk    VARCHAR(36) PRIMARY KEY,
    user_id          VARCHAR(36) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    credential_id    TEXT NOT NULL,
    public_key       BYTEA NOT NULL,
    sign_count       BIGINT NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
    transports       JSONB NOT NULL DEFAULT '[]'::jsonb,
    backup_eligible  BOOLEAN NOT NULL DEFAULT FALSE,
    backup_state     BOOLEAN NOT NULL DEFAULT FALSE,
    name             VARCHAR(100) NOT NULL,
    last_used_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webauthn_credentials_id
    ON webauthn_credentials(credential_id);
CREATE INDEX IF NOT EXISTS ix_webauthn_credentials_user
    ON webauthn_credentials(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_security_events (
    event_id      VARCHAR(36) PRIMARY KEY,
    user_id       VARCHAR(36) REFERENCES users(user_id) ON DELETE SET NULL,
    session_id    VARCHAR(36) REFERENCES auth_sessions(session_id) ON DELETE SET NULL,
    event_type    VARCHAR(64) NOT NULL,
    provider      VARCHAR(32),
    factor        VARCHAR(32),
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_auth_security_events_user
    ON auth_security_events(user_id, created_at DESC);
