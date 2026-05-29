# AgentNexus Bot 权限模型

> 版本：v7
> 分支：`break/rust-gateway-arch`
> 配套：[ACP_INTEGRATION](./ACP_INTEGRATION.md) · [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md)

本文定义 bot 的能力声明、权限控制与安全边界模型。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 架构 | Browser → Platform → Daemon(事件网关) → Agent → 本地工作区 | 用户代码留在本地 |
| Daemon 定位 | ACP 事件网关：控制哪些事件能放行，不执行操作 | 实际执行在 Agent 侧 |
| 权限粒度 | 只关注 session 生命周期 + bot 配置，不关注细粒度工具权限 | 平台管大事，Agent 管细节 |
| 权限存储 | **授权码（Grant）**，每条权限一个独立记录 | 可审计、可过期、可吊销、可追溯 |
| 权限格式 | ACP `resource + actions + effect` | 标准 RBAC |
| 授权范围 | 五级 scope：global → workspace → channel → user → session | 越细粒度优先级越高 |
| 授权检查 | **两层**：Grant（资源级） + 业务逻辑（对象级） | Grant 管"能不能做这类操作"，业务逻辑管"能不能操作这个具体对象" |
| 安全边界 | Daemon 事件过滤策略不可被服务端修改 | 用户控制事件放行规则 |
| 设备认证 | 设备注册 + 短期凭证 + 会话签名 | transport identity ≠ auth token |
| 内置 vs 外置 | 协议层零区别，仅预设不同 | 统一契约 |
| **资源写操作** | **走 Grant**（`channel:messages` / `channel:memory` / `channel:files` 的写） | **防 untrusted bot 改写频道记忆/冒发消息**（见 §5.3、§7） |
| 资源读操作 | **仅频道成员**（不走 Grant） | 读不破坏状态；与 [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) 一致 |

> **trust_level 规范枚举（全仓唯一来源）**：`system` > `trusted` > `standard` > `untrusted`。
> 其它文档若出现 `trusted_partner` 等旧词，一律等价于 `trusted`，并以本表为准。
> 默认值：内置 Agent Service = `system`；外置 ACP bot = `standard`（人工提级到 `trusted`，未验证可降到 `untrusted`）。见 §7。

---

## 1. 架构

```
┌─ 用户本地 ──────────────────────────────────────────────────┐
│                                                              │
│  ┌─ Local Agent (OpenCode 等) ─────────────────────────────┐ │
│  │  · 产生 ACP 事件                                         │ │
│  │  · 实际执行操作                                          │ │
│  │  · 自己的确认流程                                        │ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │ ACP 事件                                │
│  ┌──────────────────▼──────────────────────────────────────┐ │
│  │  Local Daemon (事件网关)                                 │ │
│  │  · 过滤 ACP 事件                                         │ │
│  │  · 设备认证                                              │ │
│  │  · 确认协调                                              │ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │ WebSocket (Agent Bridge)                │
└─────────────────────┼────────────────────────────────────────┘
                      ▼
┌─ 平台云端 ───────────────────────────────────────────────────┐
│  Platform Agent Gateway (Rust Backend)                       │
│  · Session 管理                                              │
│  · Bot 配置管理                                              │
│  · 授权码（Grant）管理                                        │
│  · 审批流                                                    │
│                                                              │
│  Cloud Agent Service (可选, Python)                           │
│  · 内置 bot                                                  │
│                                                              │
│  PostgreSQL + Redis + S3                                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 平台关注的权限

平台管三类事：

| 维度 | 操作 | 说明 |
|------|------|------|
| **Session 生命周期** | create, stop, resume, delete | bot 的任务会话管理 |
| **Bot 配置** | read, write (模型、模板、权限、token、可见性) | bot 自身配置变更 |
| **平台资源写**（见 §5.3） | `channel:messages` create、`channel:memory` write、`channel:files` create/delete | bot 经 resource 协议改写平台侧状态 |

> **为何把资源写纳入 Grant**：resource 协议（[AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md)）让任何频道成员 bot 都能改写频道记忆、冒名发消息、增删文件。若只校验「是不是频道成员」，一个 `untrusted` 外置 bot 就能把 `DECISIONS` 记忆整层 replace 掉。因此**资源写操作统一走 Grant**，按 trust_level 分级放行（§7）。**读操作不走 Grant**（仅频道成员即可），读不破坏状态。

平台不关注（仍由 Agent + Daemon 管，见 §12）：
- 具体读了什么**本地**文件、执行了什么命令、调了什么工具
- Agent 内部的执行策略与确认流程

> 注意区分：**本地资源**（`local:*`）由 Daemon 事件过滤管，平台不介入；**平台资源**（`channel:*` 的写）由本节的 Grant 管。

---

## 3. 授权码（Grant）

每一条权限 = 一个授权码（Grant）。授权码记录了授权范围、到期时间和授权人。

### 3.1 Grant 结构

```jsonc
{
  "code": "grant_xxx",              // 唯一授权码
  "bot_id": "bot-opencode",         // 被授权的 bot
  "scope_type": "channel",          // 授权范围: global | workspace | channel | user | session
  "scope_id": "ch-dev",             // scope_type='channel' → channel_id
  "resource": "session",            // ACP resource 标识
  "actions": ["create", "stop"],    // ACP actions 列表
  "effect": "allow",                // allow | deny
  "conditions": null,               // 附加条件 (可选)
  "granted_by": "user-haowei",      // 谁授权的
  "granted_at": "2026-05-29T10:00:00Z",
  "expires_at": "2026-06-29T10:00:00Z",  // null = 永不过期
  "revoked": false,
  "revoked_at": null,
  "revoked_by": null
}
```

### 3.2 Scope 语义

```
global ──── workspace ──── channel ──── user ──── session
 最广                                                最窄
```

| scope_type | scope_id | 含义 | 谁能用 | 优先级 |
|------------|---------|------|--------|:---:|
| `global` | NULL | 全局有效 | 所有场景 | 5 (最低) |
| `workspace` | workspace_id | 工作区内有效 | 该工作区所有成员 | 4 |
| `channel` | channel_id | 频道内有效 | 该频道所有成员 | 3 |
| `user` | user_id | 用户级有效 | **仅该用户** | 2 |
| `session` | session_id | Session 级有效 | **仅该 session** | 1 (最高) |

**越细粒度的 grant 优先级越高。** session 级 grant 可以覆盖 global 级 deny。

### 3.3 各 scope 的使用场景

| 场景 | scope_type | scope_id | 签发者 |
|------|-----------|---------|--------|
| bot 创建时的默认权限 | `global` | NULL | 系统 |
| bot 加入频道的权限 | `channel` | channel_id | 系统（自动） |
| 工作区管理员授权 | `workspace` | workspace_id | workspace 管理员 |
| 用户个人授权 | `user` | user_id | 用户自己 |
| 审批后给特定 session 提权 | `session` | session_id | 审批流（自动） |

### 3.4 授权码格式

授权码是 JWT（可验证签名）：

```
grant_eyJhbGciOiJFZDI1NTE5IiwidHlwIjoiSldUIn0...
```

### 3.5 授权码生命周期

```
签发 (granted_by + granted_at)
  │
  ▼ 生效中
  │  Platform 验证: 签名有效? 未过期? 未吊销?
  │
  ├─ 到期 (expires_at) → 自动失效
  ├─ 吊销 (revoked = true) → 立即失效
  └─ 续期 → 签发新 grant
```

---

## 4. 两层授权检查

权限检查分两层：**Grant 管资源级，业务逻辑管对象级。**

```
请求: 用户 B 删除 session-xyz
  │
  ▼ 第 1 层：Grant 检查（资源级）
  │  "用户 B 有没有权限在该频道做 delete session 操作？"
  │  → 查 bot_grants 表
  │  → 有匹配的 channel 级 session.delete grant ✓
  │
  ▼ 第 2 层：业务逻辑检查（对象级）
  │  "用户 B 能不能删除 session-xyz 这个具体对象？"
  │  → session.created_by == user B？
  │  ├─ yes → 允许
  │  └─ no → 拒绝（"只能删除自己创建的 session"）
  │
  ▼ 执行
```

### 4.1 两层分工

| 层 | 检查什么 | 怎么检查 | 例子 |
|---|---------|---------|------|
| **Grant（RBAC）** | 用户能不能做这类操作 | `bot_grants` 表查询 | "用户能在该频道 delete session" |
| **业务逻辑** | 用户能不能操作这个具体对象 | domain 层代码 | "用户只能 delete 自己创建的 session" |

### 4.2 业务逻辑检查示例

```python
# Session 删除
def delete_session(session_id, user_id):
    session = db.get(AgentNexusSession, session_id)

    # 第 1 层: Grant
    grant = evaluate(bot_id=session.bot_id, resource="session", action="delete",
                     user_id=user_id, channel_id=session.channel_id)
    if not grant.allowed:
        return Error("no grant for session.delete")

    # 第 2 层: 业务逻辑
    is_owner = (session.created_by == user_id)
    is_admin = is_channel_admin(user_id, session.channel_id)
    if not (is_owner or is_admin):
        return Error("只能删除自己创建的 session，或需要管理员权限")

    db.delete(session)
```

```python
# Session 停止
def stop_session(session_id, user_id):
    session = db.get(AgentNexusSession, session_id)

    # 第 1 层: Grant
    grant = evaluate(...)
    if not grant.allowed:
        return Error("no grant")

    # 第 2 层: 业务逻辑
    # 停止 session: 创建者、管理员、或 bot 所有者都可以
    is_creator = (session.created_by == user_id)
    is_admin = is_channel_admin(user_id, session.channel_id)
    is_bot_owner = (session.bot.created_by == user_id)
    if not (is_creator or is_admin or is_bot_owner):
        return Error("无权停止此 session")

    session.stop()
```

```python
# Bot 配置修改
def update_bot_config(bot_id, user_id, config):
    bot = db.get(BotAccount, bot_id)

    # 第 1 层: Grant
    grant = evaluate(bot_id=bot_id, resource="bot:config", action="write", user_id=user_id)
    if not grant.allowed:
        return Error("no grant")

    # 第 2 层: 业务逻辑
    # 配置修改: 只有 bot 所有者或系统管理员
    is_owner = (bot.created_by == user_id)
    is_admin = is_system_admin(user_id)
    if not (is_owner or is_admin):
        return Error("只有 bot 所有者可以修改配置")

    bot.update(config)
```

---

## 5. 权限清单

### 5.1 Session 操作

| 授权码前缀 | resource | actions | 业务逻辑 |
|-----------|----------|---------|---------|
| `grant-sess-create` | `session` | `create` | 频道成员即可（由 channel scope grant 控制） |
| `grant-sess-stop` | `session` | `stop` | 创建者 / 管理员 / bot 所有者 |
| `grant-sess-resume` | `session` | `resume` | 创建者 / 管理员 |
| `grant-sess-delete` | `session` | `delete` | 创建者 / 管理员 |

### 5.2 Bot 配置操作

| 授权码前缀 | resource | actions | 业务逻辑 |
|-----------|----------|---------|---------|
| `grant-cfg-read` | `bot:config` | `read` | 无额外限制 |
| `grant-cfg-write` | `bot:config` | `write` | bot 所有者 / 系统管理员 |
| `grant-perm-read` | `bot:permissions` | `read` | 无额外限制 |
| `grant-perm-write` | `bot:permissions` | `write` | bot 所有者 / 系统管理员 |
| `grant-token-rotate` | `bot:token` | `rotate` | bot 所有者 / 系统管理员 |
| `grant-token-revoke` | `bot:token` | `revoke` | bot 所有者 / 系统管理员 |
| `grant-vis-read` | `bot:visibility` | `read` | 无额外限制 |
| `grant-vis-write` | `bot:visibility` | `write` | bot 所有者 |
| `grant-account-delete` | `bot:account` | `delete` | bot 所有者 / 系统管理员 |

### 5.3 平台资源写操作（resource 协议）

bot 通过 [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) 的写类 `resource_req` 改写平台状态时，Backend 在执行前 `evaluate()`。**读类 resource 不在此列**（仅校验频道成员）。

| 授权码前缀 | resource | actions | resource_req | 业务逻辑（对象级） |
|-----------|----------|---------|--------------|---------|
| `grant-msg-create` | `channel:messages` | `create` | `channel.messages.create` / `send` 帧 | 频道成员即可 |
| `grant-mem-write` | `channel:memory` | `write` | `channel.memory.update` | 频道成员；`replace` 模式建议加审批 |
| `grant-file-create` | `channel:files` | `create` | `channel.files.create` | 频道成员即可 |
| `grant-file-delete` | `channel:files` | `delete` | 文件删除 | 上传者 / 频道管理员（与 [FILE_STORAGE §7](./FILE_STORAGE.md) 一致） |

> - Grant 的 scope 通常是 **channel 级**（bot 加入频道时按 trust_level 自动签发，见 §7）。
> - `channel:memory` 的 `write` 默认**只签发给 `trusted`/`system`**；`standard` 需审批，`untrusted` 不可写记忆（§7 矩阵）。
> - `delta`/`done` 回流**不在本节**——它续写的是 Backend 预建的占位消息，由 [ACP_CONNECTION_MODEL §8](./ACP_CONNECTION_MODEL.md) 的 R1–R4 所有权/盖戳规则裁决，不另发 `channel:messages` grant。`send`（bot 主动新建消息）才需要 `channel:messages`/`create`。

---

## 6. 授权码签发场景

### 6.1 Bot 加入频道 → 自动签发 channel 级 Grant

```sql
-- Bot 加入 #dev-project 时自动签发
INSERT INTO bot_grants (code, bot_id, scope_type, scope_id, resource, actions, effect, granted_by) VALUES
  ('grant-ch-dev-sess', 'bot-opencode', 'channel', 'ch-dev', 'session',
   ARRAY['create','resume','stop','delete'], 'allow', 'system');
```

该频道所有成员都可以使用这个 grant。具体能操作哪些 session 由业务逻辑控制。

### 6.2 Bot 离开频道 → 吊销 channel 级 Grant

```sql
UPDATE bot_grants SET revoked = TRUE, revoked_at = NOW()
WHERE bot_id = 'bot-opencode' AND scope_type = 'channel' AND scope_id = 'ch-dev';
```

### 6.3 审批卡 → 签发带过期的 Grant

```sql
-- 用户审批后签发 30 天有效的额外权限
INSERT INTO bot_grants (code, bot_id, scope_type, scope_id, resource, actions, effect, granted_by, expires_at) VALUES
  ('grant-pr001-cfg-w', 'bot-opencode', 'global', NULL, 'bot:config', ARRAY['write'], 'allow',
   'user-haowei', NOW() + INTERVAL '30 days');
```

### 6.4 频道管理员额外授权

```sql
-- 管理员给 bot 签发额外的 session.delete 权限（30天有效）
INSERT INTO bot_grants (code, bot_id, scope_type, scope_id, resource, actions, effect, granted_by, expires_at) VALUES
  ('grant-admin-del', 'bot-opencode', 'channel', 'ch-dev', 'session', ARRAY['delete'], 'allow',
   'user-admin', NOW() + INTERVAL '30 days');
```

### 6.5 用户个人授权（user 级 Grant）

```sql
-- 用户 B 个人授权 bot 可以停止他的 session
INSERT INTO bot_grants (code, bot_id, scope_type, scope_id, resource, actions, effect, granted_by) VALUES
  ('grant-ub-stop', 'bot-opencode', 'user', 'user-B', 'session', ARRAY['stop'], 'allow', 'user-B');
```

只有用户 B 能用这个 grant，其他用户不行。

### 6.6 审批后给特定 session 提权（session 级 Grant）

```sql
-- 审批后给特定 session 签发临时 delete 权限（24h 有效）
INSERT INTO bot_grants (code, bot_id, scope_type, scope_id, resource, actions, effect, granted_by, expires_at) VALUES
  ('grant-sess-del', 'bot-opencode', 'session', 'sess-xyz', 'session', ARRAY['delete'], 'allow',
   'user-haowei', NOW() + INTERVAL '24 hours');
```

只有 session-xyz 可以用这个 grant，其他 session 不行。24h 后自动过期。

### 6.7 用户拒绝特定 session 的操作（session 级 deny Grant）

```sql
-- 用户明确拒绝某个 session 的 stop 权限
INSERT INTO bot_grants (code, bot_id, scope_type, scope_id, resource, actions, effect, granted_by) VALUES
  ('grant-sess-stop-deny', 'bot-opencode', 'session', 'sess-abc', 'session', ARRAY['stop'], 'deny', 'user-B');
```

session-abc 无法 stop，即使 channel 级 grant 允许。session 级 deny 优先级最高。

---

## 7. 信任等级 → 默认 Grants

### 7.1 `standard`（默认外置 Agent）

```sql
-- 全局 grants（创建 bot 时签发）
INSERT INTO bot_grants (code, bot_id, scope_type, resource, actions, effect, granted_by) VALUES
  ('grant-std-cfg-r',   'bot-id', 'global', 'bot:config',      ARRAY['read'],   'allow', 'system'),
  ('grant-std-perm-r',  'bot-id', 'global', 'bot:permissions', ARRAY['read'],   'allow', 'system'),
  ('grant-std-vis-r',   'bot-id', 'global', 'bot:visibility',  ARRAY['read'],   'allow', 'system'),
  ('grant-std-account', 'bot-id', 'global', 'bot:account',     ARRAY['delete'], 'allow', 'system');

-- channel 级 grants（bot 加入频道时自动签发；以下为 standard 预设）
INSERT INTO bot_grants (code, bot_id, scope_type, scope_id, resource, actions, effect, granted_by) VALUES
  ('grant-ch-sess',  'bot-id', 'channel', '{channel_id}', 'session',
   ARRAY['create','resume','stop','delete'], 'allow', 'system'),
  -- 资源写：standard 默认可发消息 + 建文件，但 memory.write 不在内（需审批）
  ('grant-ch-msg',   'bot-id', 'channel', '{channel_id}', 'channel:messages', ARRAY['create'], 'allow', 'system'),
  ('grant-ch-file',  'bot-id', 'channel', '{channel_id}', 'channel:files',    ARRAY['create'], 'allow', 'system');
-- trusted/system 额外签发: channel:memory write + channel:files delete
-- untrusted 不签发任何资源写 grant（全部需审批）
```

### 7.2 其他 trust_level

trust_level 规范枚举：`system` > `trusted` > `standard` > `untrusted`（见 §0）。各级默认 grant：

| trust_level | 默认值场景 | 全局 grants（bot 配置） | channel 级 session grants | channel 级**资源写** grants |
|-------------|-----------|------------------------|--------------------------|---------------------------|
| `system` | 内置 Agent Service | 全部读写 | session 全部操作 | messages.create + memory.write + files.create/delete |
| `trusted` | 人工提级的合作方 | 全部读写 | session 全部操作 | messages.create + memory.write + files.create/delete |
| `standard` | 默认外置 ACP bot | 只读 | session 全部操作 | messages.create + files.create（**memory.write 需审批**） |
| `untrusted` | 未验证外置 | 只读 | session create + resume only | **无**（messages/memory/files 写**全部需审批**） |

> **关键**：`channel:memory` 的 `write` 只对 `trusted`/`system` 默认放行——这是 §2 安全洞的收口点。`standard`/`untrusted` 改记忆必须走 §9 审批流，临时签发 `channel`/`session` 级 grant。

---

## 8. 权限解析

```python
def evaluate(bot_id, resource, action, user_id, channel_id=None, workspace_id=None, session_id=None):
    # 查询所有有效 grants
    grants = db.query("""
        SELECT * FROM bot_grants
        WHERE bot_id = %s
          AND revoked = FALSE
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (
            scope_type = 'global'
            OR (scope_type = 'workspace' AND scope_id = %s)
            OR (scope_type = 'channel'   AND scope_id = %s)
            OR (scope_type = 'user'      AND scope_id = %s)
            OR (scope_type = 'session'   AND scope_id = %s)
          )
        ORDER BY
          CASE scope_type
            WHEN 'session'   THEN 1
            WHEN 'user'      THEN 2
            WHEN 'channel'   THEN 3
            WHEN 'workspace' THEN 4
            ELSE 5
          END
    """, bot_id, workspace_id, channel_id, user_id, session_id)

    # 匹配 resource + action
    candidates = [g for g in grants
                  if resource_match(g.resource, resource) and action in g.actions]

    # deny-wins
    deny = [g for g in candidates if g.effect == "deny"]
    if deny:
        return EvaluationResult(effect="deny", grant=deny[0])

    allow = [g for g in candidates if g.effect == "allow"]
    if allow:
        return EvaluationResult(effect="allow", grant=allow[0])

    return EvaluationResult(effect="deny", reason="no matching grant")
```

---

## 9. 审批流

```
Bot 请求操作（无匹配 grant）
  │
  ▼ Platform 发审批卡
  {
    "type": "permission_request",
    "resource": "bot:config",
    "actions": ["write"],
    "title": "请求修改 Bot 配置",
    "options": [
      { "option_id": "allow_once",   "name": "允许本次" },
      { "option_id": "allow_30d",    "name": "允许 30 天", "expires_in": "30d" },
      { "option_id": "allow_always", "name": "始终允许" },
      { "option_id": "reject",       "name": "拒绝" }
    ]
  }
  │
  ▼ 用户选择 → 签发 grant → 通知 bot
```

---

## 10. 存储 Schema

```sql
CREATE TABLE bot_grants (
    code         TEXT PRIMARY KEY,
    bot_id       TEXT NOT NULL REFERENCES bot_accounts(id),
    scope_type   TEXT NOT NULL DEFAULT 'global',     -- global | workspace | channel | user | session
    scope_id     TEXT,
    resource     TEXT NOT NULL,
    actions      TEXT[] NOT NULL,
    effect       TEXT NOT NULL DEFAULT 'allow',
    conditions   JSONB,
    granted_by   TEXT NOT NULL REFERENCES users(id),
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ,
    revoked      BOOLEAN DEFAULT FALSE,
    revoked_at   TIMESTAMPTZ,
    revoked_by   TEXT REFERENCES users(id)
);

-- scope_type 检查约束
ALTER TABLE bot_grants ADD CONSTRAINT chk_scope_type
  CHECK (scope_type IN ('global', 'workspace', 'channel', 'user', 'session'));
-- scope_id 非 null 约束（global 除外）
ALTER TABLE bot_grants ADD CONSTRAINT chk_scope_id
  CHECK (scope_type = 'global' OR scope_id IS NOT NULL);

CREATE INDEX idx_grants_lookup ON bot_grants(bot_id, scope_type, scope_id)
  WHERE revoked = FALSE;
CREATE INDEX idx_grants_expires ON bot_grants(expires_at)
  WHERE revoked = FALSE AND expires_at IS NOT NULL;
```

### Session 表

```sql
ALTER TABLE agentnexus_sessions ADD COLUMN created_by TEXT REFERENCES users(id);
-- 记录 session 创建者，用于对象级权限检查
```

### Daemon 侧（用户本地）

```
~/.agentnexus/
├── daemon.json              ← 事件过滤策略（服务端不可修改）
├── device.key               ← 设备私钥
├── device.cert              ← 设备证书
├── session.token            ← 短期 session token
└── audit.log                ← 事件审计日志
```

---

## 11. 设备认证

```
Daemon 首次连接: 生成 Ed25519 密钥对 → 注册 → 获取设备证书
Daemon 每次连接: 签名验证 → 签发短期 session token (1h)
关键操作: 附带 session_signature
```

---

## 12. 安全边界：三方控制范围

### 12.1 总览

```
┌─ ACP Agent 控制 ────────────────────────────────────────────┐
│  · 实际执行什么操作（读文件、写文件、执行命令、调 LLM）        │
│  · Agent 内部的确认流程（OpenCode 确认 UI 等）                │
│  · Agent 内部的工具权限（Agent 自己的权限系统）                │
│  · Agent 的执行策略（怎么执行、执行顺序）                      │
│                                                              │
│  ┌─ Daemon 控制 ──────────────────────────────────────────┐ │
│  │  · 哪些 ACP 事件能放行到平台（事件过滤）                  │ │
│  │  · 本地资源的目录/命令白名单（事件过滤规则）               │ │
│  │  · 设备认证（密钥对、证书、签名）                         │ │
│  │  · 确认协调（本地弹窗 or 委托给 Agent）                   │ │
│  │  · 事件审计日志                                         │ │
│  │                                                         │ │
│  │  ┌─ Platform 控制 ────────────────────────────────────┐ │ │
│  │  │  · Session 生命周期（Grant + 业务逻辑）              │ │ │
│  │  │  · Bot 配置变更（Grant + 业务逻辑）                  │ │ │
│  │  │  · 授权码（Grant）签发、吊销、过期管理               │ │ │
│  │  │  · 审批流（permission_request）                     │ │ │
│  │  │  · 设备注册验证（验证 Daemon 的证书和签名）           │ │ │
│  │  │  · 平台业务逻辑（session 所有权、bot 所有权等）       │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### 12.2 详细控制范围

#### Platform（服务端）控制

| 控制项 | 说明 | 不可被谁覆盖 |
|--------|------|------------|
| **Grant 管理** | 签发、吊销、过期管理 | Daemon 不可修改 Grant |
| **Session 生命周期** | create/stop/resume/delete 的 Grant 检查 | Daemon 不可绕过 |
| **Bot 配置变更** | config/permissions/token/visibility 的 Grant 检查 | Daemon 不可绕过 |
| **业务逻辑** | session 所有权、bot 所有权、管理员判断 | Daemon 不可修改 |
| **审批流** | 发起审批卡、处理审批结果 | Agent 不可跳过 |
| **设备注册验证** | 验证 Daemon 的 Ed25519 证书和签名 | Daemon 不可伪造 |

#### Daemon（本地事件网关）控制

| 控制项 | 说明 | 不可被谁覆盖 |
|--------|------|------------|
| **事件过滤策略** | 哪些 local:* 事件能放行 | **Platform 不可修改** |
| **目录白名单/黑名单** | 哪些本地目录可访问 | **Platform 不可修改** |
| **命令白名单/黑名单** | 哪些 shell 命令可执行 | **Platform 不可修改** |
| **确认协调** | 本地弹窗 or 委托 Agent | **Platform 不可修改** |
| **设备密钥** | Ed25519 私钥，不上传 | **Platform 不可获取** |
| **事件审计** | 本地操作日志 | **Platform 不可删除** |

#### ACP Agent 控制

| 控制项 | 说明 | 不可被谁覆盖 |
|--------|------|------------|
| **实际执行** | 读写文件、执行命令、调 LLM | Daemon 不执行，只过滤事件 |
| **Agent 内部确认** | OpenCode 等 Agent 自己的确认 UI | Daemon 可委托确认给 Agent |
| **Agent 工具权限** | Agent 自己的权限系统 | Platform 不干预 Agent 内部权限 |
| **执行策略** | 怎么执行、执行顺序、重试策略 | Platform/Daemon 不干预 |

### 12.3 不可修改性总结

```
Platform 不可修改:
  · Daemon 的事件过滤策略
  · Daemon 的目录/命令白名单
  · Daemon 的设备私钥
  · Agent 的内部权限系统

Daemon 不可修改:
  · Platform 的 Grant 配置
  · Platform 的业务逻辑规则
  · Platform 的审批流配置

Agent 不可修改:
  · Platform 的 Grant 配置
  · Daemon 的事件过滤策略
  · Platform 的审批流

任何一方都不可绕过其他方的控制。
```

### 12.4 安全决策优先级

```
操作请求
  │
  ▼ 第 1 道门：Daemon 事件过滤（local 资源）
  ├─ 目录白名单 → 不通过 → 拒绝（Platform 无法覆盖）
  ├─ 命令白名单 → 不通过 → 拒绝
  │
  ▼ 第 2 道门：Platform Grant 检查
  ├─ evaluate() → 无 grant → 拒绝（Daemon 无法绕过）
  │
  ▼ 第 3 道门：Platform 业务逻辑
  ├─ session 所有权检查 → 不通过 → 拒绝
  │
  ▼ 第 4 道门：Agent 内部确认（如果 Agent 有）
  ├─ Agent 拒绝 → 操作终止
  │
  ▼ 执行

任何一道门拒绝 → 操作终止
```

---

## 13. 迁移路径

| Phase | 动作 |
|-------|------|
| **0** | DB: `bot_grants` 表 + 索引；`agentnexus_sessions.created_by`；按 trust_level 填充默认 grants |
| **1** | Backend: Grant CRUD API；evaluate()；业务逻辑检查（session 所有权等）；设备注册 |
| **2** | Daemon: 事件过滤引擎；确认弹窗 |
| **3** | 前端: Grant 管理 UI；审批卡增强；设备管理 |

---

## 附录 A：授权检查速查

| 操作 | 第 1 层: Grant (scope) | 第 2 层: 业务逻辑 |
|------|:---:|:---:|
| 创建 session | channel 级 session.create grant | 频道成员即可 |
| 停止 session | channel 级 session.stop grant（可被 session 级 deny 覆盖） | 创建者 / 管理员 / bot 所有者 |
| 恢复 session | channel 级 session.resume grant | 创建者 / 管理员 |
| 删除 session | channel 级 session.delete grant | 创建者 / 管理员 |
| 查看配置 | global 级 bot:config.read grant | 无额外限制 |
| 修改配置 | global 级 bot:config.write grant（或审批） | bot 所有者 / 系统管理员 |
| 查看权限 | global 级 bot:permissions.read grant | 无额外限制 |
| 修改权限 | global 级 bot:permissions.write grant | bot 所有者 / 系统管理员 |
| 轮换 token | global 级 bot:token.rotate grant | bot 所有者 / 系统管理员 |
| 吊销 token | global 级 bot:token.revoke grant | bot 所有者 / 系统管理员 |
| 删除 bot | global 级 bot:account.delete grant | bot 所有者 / 系统管理员 |
| 发消息 / `send` | channel 级 channel:messages.create grant（standard+ 默认有） | 频道成员即可 |
| 写频道记忆 | channel 级 channel:memory.write grant（**仅 trusted/system 默认；其余审批**） | 频道成员即可 |
| 建频道文件 | channel 级 channel:files.create grant（standard+ 默认有） | 频道成员即可 |
| 删频道文件 | channel 级 channel:files.delete grant（仅 trusted/system 默认） | 上传者 / 频道管理员 |
| 读资源（成员/消息/文件/记忆/上下文） | **不走 grant** | 仅需频道成员 |

### Scope 优先级示例

```
场景: 用户 B 想停止 session-xyz

有效 grants (按优先级):
  1. session 级: session-xyz 的 deny grant  → 拒绝（最高优先级）
  2. user 级:    user-B 的 allow grant      → 允许
  3. channel 级: ch-dev 的 allow grant      → 允许
  4. global 级:  无

结果: session 级 deny 生效 → 拒绝
```

## 附录 B：完整时序

```
1. Bot 创建 → 按 trust_level 签发全局 grants
2. Bot 加入频道 → 自动签发 channel 级 session grants
3. Daemon 启动 → 设备认证 → 连接 Platform

4. 用户 B: "@opencode 帮我重构"
   Platform: evaluate(session.create, channel=ch-dev) → channel grant ✓
   Platform: check_membership(B, ch-dev) ✓
   → 创建 session (created_by=B) → 派发 task

5. Agent 执行任务（Daemon 事件过滤）

6. 用户 C 想停止 session-xyz:
   Platform: evaluate(session.stop, channel=ch-dev) → channel grant ✓
   Platform: session.created_by == C? → no
   Platform: is_admin(C, ch-dev)? → no
   → 拒绝（"只能停止自己创建的 session"）

7. 用户 B 停止 session-xyz:
   Platform: evaluate(session.stop, channel=ch-dev) → channel grant ✓
   Platform: session.created_by == B? → yes
   → 允许停止

8. 用户 B 个人授权 bot 可以停止他的所有 session:
   → 签发 user 级 grant (scope_type='user', scope_id='user-B')

9. Bot 想修改配置:
   Platform: evaluate(bot:config.write) → 无 grant → 审批卡
   用户审批 → 签发 global 级临时 grant (30天) → 允许修改

10. session-xyz 需要临时 delete 权限:
    → 审批后签发 session 级 grant (scope_type='session', scope_id='sess-xyz', 24h 有效)
```
