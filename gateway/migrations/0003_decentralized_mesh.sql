-- 去中心化 Bot 网格 schema（DECENTRALIZED_MESH §11 step 1）
-- ids 一律 VARCHAR(36) 与 baseline 对齐；greenfield 空表无需 backfill。

-- ── §3 频道时钟 channel_seq ───────────────────────────────────────────────────
-- 每频道单调、gap-free、连续序列。分配在 create_message / finalize 事务内、行锁下。
ALTER TABLE channels ADD COLUMN IF NOT EXISTS next_seq BIGINT NOT NULL DEFAULT 0;

-- §2 频道默认 bot（无 @ 时兜底；覆盖 workspaces.default_bot_id）
ALTER TABLE channels ADD COLUMN IF NOT EXISTS default_bot_id VARCHAR(36)
    REFERENCES bot_accounts(bot_id) ON DELETE SET NULL;

-- §9 频道级链路预算（chain_budget，默认 NULL = 无界）等设置
ALTER TABLE channels ADD COLUMN IF NOT EXISTS settings JSONB;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_seq BIGINT;  -- NULL while partial
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_seq
    ON messages(channel_id, channel_seq) WHERE channel_seq IS NOT NULL;

-- ── §2 / context-and-environment §5.2 @mention join 表 ────────────────────────
-- 多态 (member_id, member_type)，与 channel_memberships / messages.sender_* 同形。
-- @me 通知 = 走 ix_message_mentions_member 的反查；dispatch 用写入时解析结果。
CREATE TABLE IF NOT EXISTS message_mentions (
    msg_id      VARCHAR(36) NOT NULL REFERENCES messages(msg_id) ON DELETE CASCADE,
    member_id   VARCHAR(36) NOT NULL,
    member_type VARCHAR(16) NOT NULL,
    PRIMARY KEY (msg_id, member_id),
    CONSTRAINT chk_message_mentions_type CHECK (member_type IN ('user','bot'))
);
CREATE INDEX IF NOT EXISTS ix_message_mentions_member ON message_mentions(member_id, member_type);

-- 退场：legacy 双列（identity-split，context-and-environment §5.2）
ALTER TABLE messages DROP COLUMN IF EXISTS mention_bot_ids;
ALTER TABLE messages DROP COLUMN IF EXISTS mention_user_ids;

-- ── §8 Bot@Bot 任务链 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_chains (
    chain_id      VARCHAR(36) PRIMARY KEY,
    channel_id    VARCHAR(36) NOT NULL REFERENCES channels(channel_id),
    root_task_id  VARCHAR(36) NOT NULL,
    root_msg_id   VARCHAR(36) NOT NULL,        -- 用户的触发消息
    status        VARCHAR(16) NOT NULL DEFAULT 'active',  -- active|paused|cancelled|done
    cancelled_by  VARCHAR(36),
    cancelled_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_task_chains_status CHECK (status IN ('active','paused','cancelled','done'))
);
CREATE INDEX IF NOT EXISTS ix_task_chains_channel ON task_chains(channel_id, status);

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS chain_id       VARCHAR(36);
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS parent_task_id VARCHAR(36);  -- NULL=root
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS depth          INTEGER DEFAULT 0;  -- 仅可观测
ALTER TABLE bot_runs    ADD COLUMN IF NOT EXISTS chain_id       VARCHAR(36);
CREATE INDEX IF NOT EXISTS ix_bot_runs_chain_status ON bot_runs(chain_id, status);

-- ── §6 频道操作日志（VARCHAR(36)，修正原 §6 DDL 的 UUID 错误）────────────────
-- 文件变更等非对话事件：记录、可见、可重放，但对控制流惰性（不触发 bot）。
CREATE TABLE IF NOT EXISTS channel_operations (
    id           VARCHAR(36) PRIMARY KEY,
    channel_id   VARCHAR(36) NOT NULL REFERENCES channels(channel_id),
    channel_seq  BIGINT NOT NULL,        -- 同 channels.next_seq 计数器
    op_type      TEXT NOT NULL,          -- fs.write|fs.rm|file.upload|member.join|chain.cancelled ...
    actor_type   VARCHAR(16) NOT NULL,   -- bot|user|system
    actor_id     VARCHAR(36),
    target_ref   TEXT,                   -- path|file_id|member_id
    payload      JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chan_ops_seq ON channel_operations(channel_id, channel_seq);

-- ── §5 / context-and-environment §2.2 memory_files（Class 2 agent workspace）──
-- 物化路径树；per-node version 乐观锁；string-replace 局部编辑；多文件改包事务。
-- 替代旧 memory_entries 层模型（clean rebuild，下方 DROP）。
CREATE TABLE IF NOT EXISTS memory_files (
    file_id      VARCHAR(36) PRIMARY KEY,
    channel_id   VARCHAR(36) NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
    path         VARCHAR(1024) NOT NULL,     -- 'notes/2026-05-30.md'；子树 WHERE path LIKE 'a/b/%'
    content      TEXT NOT NULL DEFAULT '',
    version      BIGINT NOT NULL DEFAULT 1,  -- 乐观锁；写带 if_version
    is_dir       BOOLEAN NOT NULL DEFAULT FALSE,  -- 空目录才需持久化
    created_by   VARCHAR(36),
    creator_type VARCHAR(16),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_memory_files_channel_path UNIQUE (channel_id, path)
);
CREATE INDEX IF NOT EXISTS ix_memory_files_channel ON memory_files(channel_id);

-- 退场：旧记忆层模型（clean rebuild，不与 memory_files 共存）
DROP TABLE IF EXISTS memory_entries;
