-- Session 复用键与状态机制增强（ACP session 对齐）。

ALTER TABLE cheers_sessions
    ALTER COLUMN current_scope_type SET DEFAULT 'global',
    ALTER COLUMN current_scope_id SET DEFAULT 'global';

-- 强化会话键语义：provider + account + session_key 唯一。
ALTER TABLE cheers_sessions
    DROP CONSTRAINT IF EXISTS cheers_sessions_provider_session_key_key;

ALTER TABLE cheers_sessions
    ADD CONSTRAINT uq_cheers_sessions_provider_account_key
    UNIQUE (provider, provider_account_id, provider_session_key);

-- 收紧状态枚举，配合 runtime 状态机（active/busy/idle/revoked/expired/error）
ALTER TABLE cheers_sessions
    DROP CONSTRAINT IF EXISTS chk_cheers_sessions_status;

ALTER TABLE cheers_sessions
    ADD CONSTRAINT chk_cheers_sessions_status
    CHECK (status IN ('active', 'busy', 'idle', 'revoked', 'expired', 'error'));

CREATE INDEX IF NOT EXISTS ix_cheers_sessions_status
    ON cheers_sessions(status);

CREATE INDEX IF NOT EXISTS ix_cheers_sessions_provider_lookup
    ON cheers_sessions(provider, provider_account_id, provider_session_key);
