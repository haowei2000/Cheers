-- Android uses native refresh credentials, with the same rotation and revocation
-- protocol as the other native clients. Preserve every existing client value.
ALTER TABLE auth_transactions
    DROP CONSTRAINT IF EXISTS auth_transactions_client_type_check;
ALTER TABLE auth_transactions
    ADD CONSTRAINT auth_transactions_client_type_check
    CHECK (client_type IN ('web', 'ios', 'macos', 'android'));

ALTER TABLE auth_sessions
    DROP CONSTRAINT IF EXISTS auth_sessions_client_type_check;
ALTER TABLE auth_sessions
    ADD CONSTRAINT auth_sessions_client_type_check
    CHECK (client_type IN ('web', 'ios', 'macos', 'android'));
