-- Bot/member configuration extensions.
--
-- Channel resource authorization is member-based: users and bots share
-- channel_memberships.role plus object-level domain rules. Bot tokens only
-- authenticate a bot identity; they do not create a separate Grant/RBAC layer.

-- ── agentnexus_sessions 扩展列 ────────────────────────────────────────────────

ALTER TABLE agentnexus_sessions
    ADD COLUMN IF NOT EXISTS created_by VARCHAR(36);

-- ── channel_memberships 扩展列（bot 频道级配置覆盖）──────────────────────────

ALTER TABLE channel_memberships
    ADD COLUMN IF NOT EXISTS bot_override_config JSONB;
