-- Password as an opt-in second factor, for accounts whose first step is an
-- OAuth provider or a passkey. A password can never be both steps, so this is
-- refused at enrolment unless another primary method exists (see
-- domain/two_factor.rs::set_password_factor) — the same rule email codes follow.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_2fa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
