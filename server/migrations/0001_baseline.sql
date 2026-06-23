-- Cheers baseline schema
-- 从 Python SQLAlchemy models.py 逐字翻译（对应 Alembic revision 046）
-- 新建 DB 时由 sqlx migrate 运行；已有 DB 手动标记为已应用（见 README）

-- ── 可复用库 ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_models (
    model_id        VARCHAR(36) PRIMARY KEY,
    name            VARCHAR(64)  NOT NULL,
    provider        VARCHAR(32)  NOT NULL,
    model_name      VARCHAR(64)  NOT NULL,
    base_url        VARCHAR(512) NOT NULL,
    api_key         VARCHAR(512),
    description     TEXT,
    is_enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    is_builtin      BOOLEAN      NOT NULL DEFAULT FALSE,
    is_public       BOOLEAN      NOT NULL DEFAULT TRUE,
    config          JSONB,
    created_by      VARCHAR(36),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- bot_accounts と prompt_templates は循環 FK あり → 先に本体だけ作る

CREATE TABLE IF NOT EXISTS bot_accounts (
    bot_id              VARCHAR(36) PRIMARY KEY,
    username            VARCHAR(64)  NOT NULL UNIQUE,
    display_name        VARCHAR(255),
    description         TEXT,
    avatar_url          VARCHAR(512),
    model_id            VARCHAR(36) REFERENCES ai_models(model_id),
    template_id         VARCHAR(36),  -- FK to prompt_templates, added later
    custom_system_prompt TEXT,
    status              VARCHAR(32)  NOT NULL DEFAULT 'online',
    scope               VARCHAR(16)  NOT NULL DEFAULT 'friend',
    intro               TEXT,
    binding_type        VARCHAR(32)  NOT NULL DEFAULT 'http',
    bridge_provider     VARCHAR(32)  NOT NULL DEFAULT 'generic',
    binding_config      JSONB,
    bot_token_hash      VARCHAR(256),
    bot_token_prefix    VARCHAR(16),
    bot_token_rotated_at TIMESTAMPTZ,
    created_by          VARCHAR(36),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_bot_accounts_token_prefix ON bot_accounts(bot_token_prefix);

CREATE TABLE IF NOT EXISTS prompt_templates (
    template_id     VARCHAR(36) PRIMARY KEY,
    name            VARCHAR(64)  NOT NULL UNIQUE,
    description     TEXT,
    system_prompt   TEXT         NOT NULL,
    user_template   TEXT         NOT NULL,
    variables       JSONB        DEFAULT '[]',
    tags            JSONB        NOT NULL DEFAULT '[]',
    default_bot_id  VARCHAR(36)  REFERENCES bot_accounts(bot_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    is_builtin      BOOLEAN      NOT NULL DEFAULT FALSE,
    scope           VARCHAR(16)  NOT NULL DEFAULT 'friend',
    created_by      VARCHAR(36)  REFERENCES bot_accounts(bot_id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 补 bot_accounts → prompt_templates FK
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_bot_accounts_template_id'
          AND conrelid = 'bot_accounts'::regclass
    ) THEN
        ALTER TABLE bot_accounts
            ADD CONSTRAINT fk_bot_accounts_template_id
            FOREIGN KEY (template_id) REFERENCES prompt_templates(template_id) DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

-- ── 用户 ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    user_id         VARCHAR(36) PRIMARY KEY,
    username        VARCHAR(64)  NOT NULL UNIQUE,
    email           VARCHAR(255) UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(255),
    bio             TEXT,
    role            VARCHAR(32)  NOT NULL DEFAULT 'member',
    avatar_url      VARCHAR(512),
    is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_external_identities (
    identity_id     VARCHAR(36) PRIMARY KEY,
    provider        VARCHAR(32)  NOT NULL,
    subject         VARCHAR(255) NOT NULL,
    user_id         VARCHAR(36)  NOT NULL REFERENCES users(user_id),
    corp_id         VARCHAR(128) NOT NULL,
    union_id        VARCHAR(128),
    open_id         VARCHAR(128),
    display_name    VARCHAR(255),
    avatar_url      VARCHAR(512),
    mobile          VARCHAR(64),
    email           VARCHAR(255),
    profile         JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_auth_external_identities_provider_subject UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS ix_auth_external_identities_user     ON auth_external_identities(user_id);
CREATE INDEX IF NOT EXISTS ix_auth_external_identities_provider ON auth_external_identities(provider, corp_id);

CREATE TABLE IF NOT EXISTS email_codes (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    code        VARCHAR(10)  NOT NULL,
    purpose     VARCHAR(32)  NOT NULL,
    expires_at  TIMESTAMPTZ  NOT NULL,
    used        BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_email_codes_email ON email_codes(email);

-- ── ワークスペース ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id    VARCHAR(36) PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    avatar_url      VARCHAR(512),
    default_bot_id  VARCHAR(36)  REFERENCES bot_accounts(bot_id) ON DELETE SET NULL,
    kind            VARCHAR(16)  NOT NULL DEFAULT 'team',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
    workspace_id    VARCHAR(36) NOT NULL REFERENCES workspaces(workspace_id),
    user_id         VARCHAR(36) NOT NULL REFERENCES users(user_id),
    role            VARCHAR(20)  NOT NULL DEFAULT 'member',
    joined_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

-- ── チャンネル ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS channels (
    channel_id          VARCHAR(36) PRIMARY KEY,
    workspace_id        VARCHAR(36) NOT NULL REFERENCES workspaces(workspace_id),
    name                VARCHAR(255) NOT NULL,
    type                VARCHAR(32)  NOT NULL DEFAULT 'public',
    purpose             TEXT,
    auto_assist         BOOLEAN      NOT NULL DEFAULT FALSE,
    allow_member_invites BOOLEAN     NOT NULL DEFAULT TRUE,
    allow_bot_adds      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_memberships (
    channel_id  VARCHAR(36) NOT NULL REFERENCES channels(channel_id),
    member_id   VARCHAR(36) NOT NULL,
    member_type VARCHAR(16) NOT NULL,
    role        VARCHAR(20) NOT NULL DEFAULT 'member',
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by    VARCHAR(36),
    template_id VARCHAR(36) REFERENCES prompt_templates(template_id),
    last_read_at TIMESTAMPTZ,
    hidden_at   TIMESTAMPTZ,
    CONSTRAINT chk_channel_memberships_member_type CHECK (member_type IN ('user', 'bot')),
    CONSTRAINT chk_channel_memberships_role CHECK (role IN ('owner', 'admin', 'member', 'readonly')),
    PRIMARY KEY (channel_id, member_id)
);
CREATE INDEX IF NOT EXISTS ix_channel_memberships_member ON channel_memberships(member_id, member_type);

CREATE TABLE IF NOT EXISTS channel_unread_counts (
    channel_id  VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    user_id     VARCHAR(36) NOT NULL,
    unread_count INTEGER    NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_channel_unread_counts_user ON channel_unread_counts(user_id);

-- ── メッセージ ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
    msg_id              VARCHAR(36) PRIMARY KEY,
    task_id             VARCHAR(36),
    channel_id          VARCHAR(36) NOT NULL REFERENCES channels(channel_id),
    sender_id           VARCHAR(36) NOT NULL,
    sender_type         VARCHAR(16) NOT NULL,
    content             TEXT        NOT NULL DEFAULT '',
    file_ids            JSONB       DEFAULT '[]',
    mention_bot_ids     JSONB       DEFAULT '[]',
    mention_user_ids    JSONB       DEFAULT '[]',
    in_reply_to_msg_id  VARCHAR(36),
    msg_type            VARCHAR(16) NOT NULL DEFAULT 'normal',
    content_data        JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_secret           BOOLEAN     NOT NULL DEFAULT FALSE,
    secret_encrypted    TEXT,
    secret_token        VARCHAR(64),
    is_partial          BOOLEAN     NOT NULL DEFAULT FALSE,
    is_deleted          BOOLEAN     NOT NULL DEFAULT FALSE,
    deleted_at          TIMESTAMPTZ,
    deleted_by          VARCHAR(36)
);
CREATE INDEX IF NOT EXISTS ix_messages_channel_created_at ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS ix_messages_channel_created_msg_id ON messages(channel_id, created_at, msg_id);
CREATE INDEX IF NOT EXISTS ix_messages_in_reply_created_at ON messages(in_reply_to_msg_id, created_at);

CREATE TABLE IF NOT EXISTS history_pages (
    page_id         VARCHAR(36) PRIMARY KEY,
    channel_id      VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    page_number     INTEGER     NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ NOT NULL,
    first_msg_id    VARCHAR(36) NOT NULL,
    last_msg_id     VARCHAR(36) NOT NULL,
    summary         TEXT        NOT NULL,
    raw_content     TEXT        NOT NULL,
    message_count   INTEGER     NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_history_pages_channel_page UNIQUE (channel_id, page_number)
);

-- ── ファイル ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS file_records (
    file_id             VARCHAR(36) PRIMARY KEY,
    channel_id          VARCHAR(36) REFERENCES channels(channel_id),
    workspace_id        VARCHAR(36) REFERENCES workspaces(workspace_id),
    uploader_id         VARCHAR(36) NOT NULL,
    original_path       VARCHAR(512) NOT NULL,
    object_key          VARCHAR(512),
    storage_bucket      VARCHAR(255),
    original_filename   VARCHAR(255),
    content_type        VARCHAR(255),
    size_bytes          INTEGER,
    md_path             VARCHAR(512),
    status              VARCHAR(32) NOT NULL DEFAULT 'pending',
    summary_3lines      TEXT,
    last_error          TEXT,
    uploaded_at         TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    converted_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_file_records_channel ON file_records(channel_id, created_at);
CREATE INDEX IF NOT EXISTS ix_file_records_workspace ON file_records(workspace_id);
CREATE INDEX IF NOT EXISTS ix_file_records_expires ON file_records(expires_at);

CREATE TABLE IF NOT EXISTS file_scope_links (
    link_id         VARCHAR(36) PRIMARY KEY,
    file_id         VARCHAR(36) NOT NULL REFERENCES file_records(file_id) ON DELETE CASCADE,
    scope_type      VARCHAR(16) NOT NULL,
    scope_id        VARCHAR(128) NOT NULL,
    workspace_id    VARCHAR(36) REFERENCES workspaces(workspace_id),
    created_by      VARCHAR(36),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_file_scope_links_file_scope UNIQUE (file_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS ix_file_scope_links_scope ON file_scope_links(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS ix_file_scope_links_file  ON file_scope_links(file_id);

CREATE TABLE IF NOT EXISTS document_sets (
    set_id              VARCHAR(36) PRIMARY KEY,
    channel_id          VARCHAR(36) REFERENCES channels(channel_id) ON DELETE CASCADE,
    owner_id            VARCHAR(36),
    name                VARCHAR(255) NOT NULL,
    auto_rule           VARCHAR(64)  NOT NULL DEFAULT 'title_without_digits',
    similarity_threshold REAL        NOT NULL DEFAULT 0.9,
    created_by          VARCHAR(36),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_document_sets_channel ON document_sets(channel_id, created_at);
CREATE INDEX IF NOT EXISTS ix_document_sets_owner   ON document_sets(owner_id, created_at);

CREATE TABLE IF NOT EXISTS document_set_items (
    item_id     VARCHAR(36) PRIMARY KEY,
    set_id      VARCHAR(36) NOT NULL REFERENCES document_sets(set_id) ON DELETE CASCADE,
    file_id     VARCHAR(36) NOT NULL REFERENCES file_records(file_id) ON DELETE CASCADE,
    added_by    VARCHAR(36),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_manual   BOOLEAN     NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_document_set_items_set_file UNIQUE (set_id, file_id)
);
CREATE INDEX IF NOT EXISTS ix_document_set_items_set  ON document_set_items(set_id);
CREATE INDEX IF NOT EXISTS ix_document_set_items_file ON document_set_items(file_id);

CREATE TABLE IF NOT EXISTS document_set_exclusions (
    exclusion_id    VARCHAR(36) PRIMARY KEY,
    channel_id      VARCHAR(36) REFERENCES channels(channel_id) ON DELETE CASCADE,
    owner_id        VARCHAR(36),
    file_id         VARCHAR(36) NOT NULL REFERENCES file_records(file_id) ON DELETE CASCADE,
    updated_by      VARCHAR(36),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_document_set_exclusions_channel_file UNIQUE (channel_id, file_id),
    CONSTRAINT uq_document_set_exclusions_owner_file   UNIQUE (owner_id, file_id)
);
CREATE INDEX IF NOT EXISTS ix_document_set_exclusions_channel ON document_set_exclusions(channel_id);
CREATE INDEX IF NOT EXISTS ix_document_set_exclusions_owner   ON document_set_exclusions(owner_id);
CREATE INDEX IF NOT EXISTS ix_document_set_exclusions_file    ON document_set_exclusions(file_id);

-- ── その他 ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id         VARCHAR(36) PRIMARY KEY,
    channel_id      VARCHAR(36) NOT NULL,
    bot_id          VARCHAR(36) NOT NULL,
    trigger_msg_id  VARCHAR(36) NOT NULL,
    response_msg_id VARCHAR(36),
    latency_ms      INTEGER,
    token_count     INTEGER,
    feedback        VARCHAR(32),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_runs (
    bot_run_id          VARCHAR(36) PRIMARY KEY,
    task_id             VARCHAR(36) NOT NULL,
    channel_id          VARCHAR(36) NOT NULL,
    trigger_msg_id      VARCHAR(36) NOT NULL,
    bot_id              VARCHAR(36) NOT NULL,
    placeholder_msg_id  VARCHAR(36) NOT NULL,
    binding_type        VARCHAR(32) NOT NULL DEFAULT 'http',
    status              VARCHAR(32) NOT NULL DEFAULT 'placeholder_created',
    last_event_type     VARCHAR(64),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_bot_runs_placeholder_msg_id UNIQUE (placeholder_msg_id)
);
CREATE INDEX IF NOT EXISTS ix_bot_runs_task_bot       ON bot_runs(task_id, bot_id);
CREATE INDEX IF NOT EXISTS ix_bot_runs_channel_status ON bot_runs(channel_id, status);

CREATE TABLE IF NOT EXISTS channel_profiles (
    channel_id  VARCHAR(36) NOT NULL REFERENCES channels(channel_id),
    user_id     VARCHAR(36) NOT NULL REFERENCES users(user_id),
    nickname    VARCHAR(255),
    bio         TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS friendships (
    friendship_id   VARCHAR(36) PRIMARY KEY,
    user_id         VARCHAR(36) NOT NULL REFERENCES users(user_id),
    friend_id       VARCHAR(36) NOT NULL REFERENCES users(user_id),
    pair_key        VARCHAR(80) NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    notice_msg_id   VARCHAR(36),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at    TIMESTAMPTZ,
    CONSTRAINT uq_friendships_pair_key UNIQUE (pair_key)
);

CREATE TABLE IF NOT EXISTS system_settings (
    key     VARCHAR(128) PRIMARY KEY,
    value   JSONB        NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bulletin_issues (
    issue_id    VARCHAR(36) PRIMARY KEY,
    title       VARCHAR(255) NOT NULL,
    content     TEXT,
    status      VARCHAR(32)  NOT NULL DEFAULT 'open',
    priority    VARCHAR(32)  NOT NULL DEFAULT 'medium',
    tags        JSONB        DEFAULT '[]',
    creator_id  VARCHAR(36),
    creator_name VARCHAR(128),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS todo_items (
    todo_id         VARCHAR(36) PRIMARY KEY,
    channel_id      VARCHAR(36) NOT NULL REFERENCES channels(channel_id),
    creator_id      VARCHAR(36) NOT NULL,
    creator_type    VARCHAR(16) NOT NULL,
    assignee_id     VARCHAR(36),
    assignee_type   VARCHAR(16),
    content         TEXT        NOT NULL,
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_todo_items_channel ON todo_items(channel_id);

CREATE TABLE IF NOT EXISTS memory_entries (
    entry_id    VARCHAR(36) PRIMARY KEY,
    channel_id  VARCHAR(36) NOT NULL,
    layer       VARCHAR(50) NOT NULL,
    title       VARCHAR(255),
    content     TEXT        NOT NULL,
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    created_by  VARCHAR(36),
    creator_type VARCHAR(16),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_memory_entries_channel_layer_order UNIQUE (channel_id, layer, sort_order)
);
CREATE INDEX IF NOT EXISTS ix_memory_entries_channel ON memory_entries(channel_id);

CREATE TABLE IF NOT EXISTS keychain_items (
    key_id      VARCHAR(36) PRIMARY KEY,
    owner_id    VARCHAR(36) NOT NULL REFERENCES users(user_id),
    name        VARCHAR(128) NOT NULL,
    value       TEXT         NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_keychain_items_owner ON keychain_items(owner_id);

CREATE TABLE IF NOT EXISTS agent_bridge_events (
    event_id    BIGSERIAL PRIMARY KEY,
    bot_id      VARCHAR(36) NOT NULL,
    stream      VARCHAR(16) NOT NULL,
    seq         BIGINT      NOT NULL,
    payload     JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_agent_bridge_event_bot_stream_seq UNIQUE (bot_id, stream, seq)
);

CREATE TABLE IF NOT EXISTS cheers_sessions (
    session_id          VARCHAR(36) PRIMARY KEY,
    bot_id              VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    provider            VARCHAR(32) NOT NULL DEFAULT 'generic',
    provider_account_id VARCHAR(128) NOT NULL,
    provider_agent_id   VARCHAR(128) NOT NULL DEFAULT 'main',
    provider_session_key VARCHAR(512) NOT NULL UNIQUE,
    provider_session_id VARCHAR(128),
    current_scope_type  VARCHAR(16) NOT NULL,
    current_scope_id    VARCHAR(128) NOT NULL,
    status              VARCHAR(32) NOT NULL DEFAULT 'active',
    metadata            JSONB,
    last_used_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_cheers_sessions_bot ON cheers_sessions(bot_id, provider, provider_agent_id, provider_account_id);

CREATE TABLE IF NOT EXISTS cheers_session_bindings (
    binding_id          VARCHAR(36) PRIMARY KEY,
    session_id          VARCHAR(36) NOT NULL REFERENCES cheers_sessions(session_id) ON DELETE CASCADE,
    bot_id              VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    provider            VARCHAR(32) NOT NULL DEFAULT 'generic',
    provider_account_id VARCHAR(128) NOT NULL,
    provider_agent_id   VARCHAR(128) NOT NULL DEFAULT 'main',
    scope_type          VARCHAR(16) NOT NULL,
    scope_id            VARCHAR(128) NOT NULL,
    channel_id          VARCHAR(36) REFERENCES channels(channel_id),
    topic_id            VARCHAR(36),
    dm_id               VARCHAR(36),
    task_id             VARCHAR(36),
    role                VARCHAR(16) NOT NULL DEFAULT 'primary',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detached_at         TIMESTAMPTZ,
    CONSTRAINT uq_cheers_session_binding_scope UNIQUE (bot_id, provider, provider_agent_id, provider_account_id, scope_type, scope_id),
    CONSTRAINT uq_cheers_session_binding_session_scope UNIQUE (session_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS ix_cheers_session_bindings_lookup ON cheers_session_bindings(bot_id, provider, provider_agent_id, provider_account_id, scope_type, scope_id);
