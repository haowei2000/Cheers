-- 权限模型 + bot 配置扩展（对应 Phase 0-A 计划，BOT_PERMISSION §10）

-- ── bot_grants 表（RBAC Grant 授权码）────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_grants (
    code        TEXT PRIMARY KEY,
    bot_id      VARCHAR(36) NOT NULL REFERENCES bot_accounts(bot_id) ON DELETE CASCADE,
    scope_type  TEXT NOT NULL DEFAULT 'global',
    scope_id    TEXT,
    resource    TEXT NOT NULL,
    actions     TEXT[] NOT NULL,
    effect      TEXT NOT NULL DEFAULT 'allow',
    conditions  JSONB,
    granted_by  VARCHAR(36) NOT NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,
    revoked     BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at  TIMESTAMPTZ,
    revoked_by  VARCHAR(36),
    CONSTRAINT chk_scope_type CHECK (scope_type IN ('global','workspace','channel','user','session')),
    CONSTRAINT chk_scope_id   CHECK (scope_type = 'global' OR scope_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_grants_lookup  ON bot_grants(bot_id, scope_type, scope_id) WHERE revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_grants_expires ON bot_grants(expires_at) WHERE revoked = FALSE AND expires_at IS NOT NULL;

-- ── bot_accounts 扩展列 ────────────────────────────────────────────────────────

ALTER TABLE bot_accounts
    ADD COLUMN IF NOT EXISTS trust_level    TEXT NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS approval_mode  TEXT NOT NULL DEFAULT 'manual';

-- ── agentnexus_sessions 扩展列 ────────────────────────────────────────────────

ALTER TABLE agentnexus_sessions
    ADD COLUMN IF NOT EXISTS created_by VARCHAR(36);

-- ── channel_memberships 扩展列（bot 频道级配置覆盖）──────────────────────────

ALTER TABLE channel_memberships
    ADD COLUMN IF NOT EXISTS bot_override_config JSONB;

-- ── 默认 Grant 填充（对现有 bot 按 trust_level 插入标准 grant）─────────────────
-- 注意：granted_by 用 'system' 作为固定值（system-generated grants）
-- 对 standard 级别 bot：全局只读 + channel:messages/create + channel:files/create
-- 本 SQL 仅为新 bot 的模板；存量数据的填充建议在应用层初始化脚本里做

-- （留空，应用层在 bot 创建/加入频道时调用 seed_default_grants()）
