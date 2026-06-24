# Cheers 文件存储与权限

> 版本：v1
> 分支：`break/rust-gateway-arch`
> 配套：[AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) · [SECURITY.md](./SECURITY.md) · [BOT_PERMISSION.md](./BOT_PERMISSION.md)

本文定义文件存储架构、权限模型和 Agent 文件交互方式。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 平台文件存储 | S3 (RustFS) | 现有方案，不变 |
| 本地文件 | 不在平台管理范围 | Agent 自行管理 |
| Agent 生成文件 | 通过 contract 约定返回格式 | Daemon 捕获转发，Platform 存 S3 |
| 文件**读取**权限 | FileScopeLink（channel/personal/workspace）+ 频道成员 | 读不破坏状态，不走 Grant |
| 文件**写**权限（bot create/delete） | FileScopeLink **+ Grant** `channel:files`/`create\|delete` | 与 [BOT_PERMISSION §5.3](./BOT_PERMISSION.md) 对齐，防 untrusted bot 乱写/乱删 |
| E2EE 文件 | **未来计划**（本期不做，见 [SECURITY.md](./SECURITY.md)） | 上 E2EE 后服务端 `files.read` 文本失效 |

---

## 1. 文件存储架构

### 1.1 两类文件

```
平台文件 (S3):
  ├─ 用户上传: presigned URL → S3
  ├─ Agent 生成: resource_req → Daemon → Platform → S3
  └─ 权限: FileScopeLink

本地文件 (用户本地):
  ├─ 不在平台管理范围
  ├─ Agent 自行管理
  └─ 权限: Daemon 事件过滤
```

| 类型 | 存储位置 | 上传方式 | 谁管理 | 权限控制 |
|------|---------|---------|--------|---------|
| **用户上传** | S3 | presigned URL | Platform | scope link |
| **Agent 生成** | S3 | resource_req → Platform | Platform | scope link |
| **本地文件** | 用户本地 | 不上传 | Agent + Daemon | Daemon 事件过滤 |

### 1.2 平台文件存储 (S3)

```
S3 bucket:
├─ uploads/
│   └─ {prefix_a}/{prefix_b}/{file_id}/source     ← 用户上传
│       └─ {object_key}.meta.json                  ← 元数据 sidecar
│
└─ generated/
    └─ {prefix_a}/{prefix_b}/{file_id}/source     ← Agent 生成
        └─ {object_key}.meta.json
```

**Object key 格式**: `{scope}/{prefix_a}/{prefix_b}/{file_id}/source`

UUID 前 4 字符作为 2 级 fan-out 前缀，分散 S3 key 命名空间。

### 1.3 本地文件

本地文件不上传到平台，不创建 FileRecord。Agent 在本地读写文件，通过 Daemon 事件过滤控制访问。

---

## 2. Agent 文件交互

### 2.1 Agent 生成文件 → Platform 存储

Agent 通过 contract（prompt 约定）返回文件，Daemon 捕获转发：

```
Contract (prompt 约定):
  "当你生成了文件，请通过 resource_req: channel.files.create 返回:
   { channel_id, filename, content_type, data_b64 }
   返回后你会收到 file_id，在最终回复中引用它。"
```

完整流程：

```
Agent 生成文件 (本地)
  │
  ▼ Agent 按 contract 格式发 resource_req
  │  { resource: "channel.files.create",
  │    params: { channel_id: "ch-dev",
  │              filename: "refactored_main.py",
  │              content_type: "text/x-python",
  │              data_b64: "base64..." } }
  │
  ▼ Daemon
  │  resource = "channel:files" → platform 资源 → 放行
  │
  ▼ Platform
  │  存储到 S3 (generated/ scope)
  │  创建 FileRecord (status=ready, expires_at=None)
  │  创建 FileScopeLink (scope_type=channel, scope_id=ch-dev)
  │  返回 file_id
  │
  ▼ Daemon → Agent
  │  resource_res: { ok: true, data: { file_id: "file-xxx" } }
  │
  ▼ Agent
  │  在 done 帧中引用 file_id
  │  用户看到文件附件
```

### 2.2 Agent 读取平台文件

```
Agent 需要读取频道文件:
  │
  ▼ Agent → Daemon → Platform
  │  resource_req: channel.files.read
  │  { file_id, channel_id, format: "text" }
  │
  ▼ Platform
  │  检查 FileScopeLink: bot 是频道成员 ✓
  │  读取文件内容（或解析 markdown 缓存）
  │  返回 content
  │
  ▼ Platform → Daemon → Agent
  │  resource_res: { content: "..." }
```

### 2.3 Agent 列出频道文件

```
Agent → Daemon → Platform:
  resource_req: channel.files
  { channel_id, scope: "all", limit: 50 }

Platform:
  查询 FileScopeLink + FileRecord
  返回 files 列表

Platform → Daemon → Agent:
  resource_res: { files: [...] }
```

### 2.4 Agent 操作本地文件

本地文件不经过 Platform：

```
Agent 读本地文件:
  Agent → Daemon: resource_req (local:files.read, path=main.py)
  Daemon: 目录白名单 ✓ → 放行（但 Platform 不参与）
  Agent: 自己读取文件（不经过 Platform）

Agent 写本地文件:
  Agent → Daemon: resource_req (local:files.write, path=main.py)
  Daemon: 目录白名单 ✓ + 确认 → 放行
  Agent: 自己写入文件
```

**本地文件的 resource_req 由 Daemon 处理，不转发给 Platform。**

---

## 3. 文件权限模型

### 3.1 平台文件权限（FileScopeLink）

平台文件权限由 FileScopeLink 控制，不由 bot_grants 控制。

```
FileScopeLink:
  ├─ scope_type: channel | personal | workspace | dm | task
  ├─ scope_id: 对应的 ID
  └─ file_id: 文件 ID

权限检查 (user_can_access):
  ├─ 管理员/上传者 → 始终可访问
  ├─ personal scope → 该用户可访问
  ├─ workspace scope → 工作区成员可访问
  ├─ channel scope → 频道成员可访问
  └─ task scope → 任务频道成员可访问
```

### 3.2 Bot 访问平台文件

Bot **读取**平台文件的权限检查（不走 Grant）：

```
Bot 发 resource_req: channel.files.read / channel.files
  │
  ▼ Platform 检查
  ├─ Bot 是该频道的成员？ → check_bot_in_channel() ✓
  ├─ 文件是否关联到该频道？ → check_files_in_channel() ✓
  └─ 允许读取
```

Bot **写**平台文件（`channel.files.create` / 删除）**额外需要 Grant**：

```
Bot 发 resource_req: channel.files.create
  │
  ▼ Platform 检查
  ├─ check_bot_in_channel() ✓
  ├─ evaluate(bot_id, "channel:files", "create", channel_id) ✓   ← 新增
  │     无 grant → 审批流（BOT_PERMISSION §9），或 PERMISSION_DENIED
  └─ 存储 + 创建 FileRecord + scope link
```

> **读 = 成员；写 = 成员 + Grant。** standard 及以上默认有 `channel:files`/`create`；删除默认仅 trusted/system。详见 [BOT_PERMISSION §5.3 / §7](./BOT_PERMISSION.md)。这与早期「文件完全不走 bot_grants」的说法不同——**写操作已收口到 Grant**。

### 3.3 本地文件权限

本地文件权限由 Daemon 事件过滤控制：

```
Daemon 事件过滤策略:
  local:files.read   → directory_check → 白名单内 ✓
  local:files.write  → directory_check + confirm → 白名单内 + 用户确认 ✓
  local:files.list   → directory_check → 白名单内 ✓
```

### 3.4 权限模型对比

| 维度 | 平台文件 | 本地文件 |
|------|---------|---------|
| 权限控制 | FileScopeLink (Platform)；写另加 Grant | Daemon 事件过滤 |
| 谁检查 | Platform | Daemon |
| Bot 读取 | 频道成员即可 | 目录白名单 |
| Bot 写入（create/delete） | 频道成员 **+ Grant** `channel:files` | 目录白名单 + 确认 |
| 用户访问 | scope link + 频道成员 | 不涉及（本地文件不在平台） |
| 由 Grant 管？ | **读 ❌ / 写 ✅** | ❌（Daemon 过滤） |

---

## 4. 文件上传流程

### 4.1 用户上传（presigned URL）

```
Step 1: 用户 → Platform: POST /files/presign
  ├─ 验证: 用户是频道成员，有权发送消息
  ├─ 验证: 文件类型、大小
  ├─ 创建 FileRecord (status=pending_upload)
  └─ 返回: { file_id, upload_url, headers }

Step 2: 用户 → S3: PUT (presigned URL)
  └─ 直传文件到 S3

Step 3: 用户 → Platform: POST /files/{file_id}/confirm
  ├─ 验证: S3 对象存在
  ├─ 更新 FileRecord (status=uploaded)
  └─ 创建 FileScopeLink
```

### 4.2 Agent 生成（resource_req）

```
Step 1: Agent → Daemon → Platform: resource_req (channel.files.create)
  ├─ Daemon: 事件过滤 ✓ (platform 资源)
  ├─ Platform: 存储到 S3 (generated/ scope)
  ├─ Platform: 创建 FileRecord (status=ready, expires_at=None)
  └─ Platform: 创建 FileScopeLink

Step 2: Platform → Daemon → Agent: resource_res (file_id)
```

### 4.3 大文件分块

```
Agent → Daemon → Platform: resource_req (channel.files.create, upload_mode=chunked)
Agent → Daemon → Platform: resource_chunk (data, index:0)
Agent → Daemon → Platform: resource_chunk (data, index:1)
Agent → Daemon → Platform: resource_chunk (end)
Platform → Daemon → Agent: resource_res (file_id)
```

---

## 5. 文件保留策略

| 文件类型 | 保留策略 | 说明 |
|---------|---------|------|
| 用户上传 | `file_retention_days` (默认 365 天) | 过期后自动清理 S3 对象 + DB 记录 |
| Agent 生成（平台） | **永不过期** | `expires_at = NULL`，不受保留策略影响 |
| 本地文件 | 不在平台管理范围 | 用户自行管理 |
| 未确认上传 | `file_pending_upload_ttl_seconds` (1h) | 超时清理悬空上传 |

---

## 6. E2EE 下的文件处理

> 🔮 **未来计划，本期不实现**（见 [SECURITY.md](./SECURITY.md) §8）。本期文件以明文存 S3，服务端可做 `files.read` 文本提取 / markdown 转换 / 预览。上 E2EE 后这些服务端读取失效，须挪到客户端/Daemon——以下为存档设计。

### 6.1 用户上传

```
用户客户端:
  1. 用 group_key 加密文件内容
  2. 上传密文到 S3 (presigned URL)
  3. Platform 存储密文

其他成员/Bot:
  4. 从 S3 下载密文
  5. 用 group_key 解密
```

### 6.2 Agent 生成

```
Agent:
  1. 用 group_key 加密文件内容
  2. resource_req: channel.files.create { data_b64: <密文> }

Daemon:
  3. 事件过滤（只看元数据：resource 类型、channel_id）
  4. 转发给 Platform

Platform:
  5. 存储密文到 S3
  6. 返回 file_id

其他成员:
  7. 下载密文 → group_key 解密
```

**Daemon 不需要解密文件内容。** 文件内容从 Agent 到 Platform 是加密的，Daemon 只看元数据做事件过滤。

### 6.3 文件预览

```
E2EE 下文件预览:
  ├─ 文本文件: 客户端下载密文 → 解密 → 本地预览
  ├─ 图片: 客户端下载密文 → 解密 → 显示
  └─ 复杂格式 (doc/ppt): 客户端解密 → 上传到 kkfileview → 预览
```

---

## 7. 文件删除

### 7.1 删除逻辑

```
用户/Bot 请求删除文件:
  │
  ▼ 权限检查
  ├─ 管理员/上传者 → 可删除
  ├─ channel admin → 可从频道移除
  └─ 其他 → 拒绝
  │
  ▼ 删除 scope link
  ├─ 如果还有其他 scope link → 只移除当前 scope
  └─ 如果没有其他 scope link 且无消息引用 → 物理删除 S3 对象
```

### 7.2 本地文件删除

本地文件删除由 Daemon 事件过滤控制：

```
Agent → Daemon: resource_req (local:files.delete, path=...)
  │
  ▼ Daemon
  ├─ 目录白名单 ✓
  ├─ 确认策略: 需要本地确认
  └─ 用户确认 → Agent 执行删除
```

---

## 8. 完整文件操作表

| 操作 | 存储位置 | 执行者 | 权限检查 | Daemon 过滤 |
|------|---------|--------|---------|-----------|
| 用户上传 | S3 | 用户直传 S3 | Platform (频道成员) | ❌ |
| Agent 生成 | S3 | Agent → Daemon → Platform | Platform (频道成员 **+ Grant** channel:files/create) | platform 资源，放行 |
| 用户下载 | S3 | Platform 返回 | Platform (scope link) | ❌ |
| Agent 读取 | S3 | Agent → Daemon → Platform | Platform (scope link，**不走 Grant**) | platform 资源，放行 |
| Agent 列出 | S3 | Agent → Daemon → Platform | Platform (频道成员，**不走 Grant**) | platform 资源，放行 |
| 本地读取 | 本地 | Agent 自己读 | Daemon (目录白名单) | local 资源，过滤 |
| 本地写入 | 本地 | Agent 自己写 | Daemon (目录白名单 + 确认) | local 资源，过滤 |
| 删除(平台) | S3 | Platform | Platform (上传者/管理员 **+ Grant** channel:files/delete) | ❌ |
| 删除(本地) | 本地 | Agent 自己删 | Daemon (目录白名单 + 确认) | local 资源，过滤 |

---

## 9. 数据库 Schema

### 9.1 FileRecord (现有，不变)

```sql
CREATE TABLE file_records (
    file_id          TEXT PRIMARY KEY,
    channel_id       TEXT,
    workspace_id     TEXT,
    uploader_id      TEXT NOT NULL,
    original_path    TEXT,
    object_key       TEXT,
    storage_bucket   TEXT,
    md_path          TEXT,
    status           TEXT NOT NULL,       -- pending_upload | uploaded | processing | ready | failed
    original_filename TEXT,
    content_type     TEXT,
    size_bytes       BIGINT,
    summary_3lines   TEXT,
    expires_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_at      TIMESTAMPTZ,
    converted_at     TIMESTAMPTZ
);
```

### 9.2 FileScopeLink (已废弃 / DROPPED)

> ⚠️ **未实现，已删除。** 这套 scope-link 模型从未被任何写入路径落地（表一直为空），
> 因此 bot 的文件鉴权改为直接按 `file_records.channel_id` + channel 成员关系
> （`authorize_channel_read`）。该表已在迁移 `0017_drop_file_scope_links` 中 `DROP`。
> 本节及下文凡涉及 `FileScopeLink` / `scope link` 的描述均为历史设计，**以当前代码为准**。

```sql
-- 历史设计（已删除，仅作参考）
CREATE TABLE file_scope_links (
    file_id     TEXT NOT NULL REFERENCES file_records(file_id),
    scope_type  TEXT NOT NULL,            -- personal | channel | dm | workspace | task | personal_hidden
    scope_id    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, scope_type, scope_id)
);
```

---

## 附录 A：文件操作速查

| resource_req | 存储 | Daemon 行为 | Platform 行为 |
|-------------|------|-----------|-------------|
| `channel.files` | S3 | 放行 | 频道成员 → 查询 FileRecord + FileScopeLink |
| `channel.files.read` | S3 | 放行 | 检查 scope link → 返回内容（**不走 Grant**） |
| `channel.files.create` | S3 | 放行 | **evaluate(channel:files/create)** → 存储 S3 → 创建 FileRecord + scope link |
| `local:files.read` | 本地 | **目录白名单检查** | 不转发，Agent 自己读 |
| `local:files.write` | 本地 | **目录白名单 + 确认** | 不转发，Agent 自己写 |
| `local:files.list` | 本地 | **目录白名单检查** | 不转发，Agent 自己列 |
| `local:files.delete` | 本地 | **目录白名单 + 确认** | 不转发，Agent 自己删 |

## 附录 B：文件完整时序

```
1. 用户上传文件到频道:
   用户 → presign → S3 直传 → confirm → Platform 创建 FileRecord + scope link

2. 用户发消息附带文件:
   用户 → POST /messages { file_ids: [...] }
   Platform: prepare_attachments() → 解析文件内容 → 传给 LLM

3. Agent 生成文件:
   Agent → resource_req (channel.files.create) → Daemon → Platform → S3
   Platform → file_id → Agent → done 帧中引用

4. Agent 读取频道文件:
   Agent → resource_req (channel.files.read) → Daemon → Platform
   Platform: scope link 检查 → 返回内容

5. Agent 读取本地文件:
   Agent → resource_req (local:files.read) → Daemon 目录检查 → Agent 自己读

6. E2EE 文件:
   Agent 加密 → resource_req (密文) → Daemon (只看元数据) → Platform (存密文)
   其他成员下载密文 → group_key 解密
```
