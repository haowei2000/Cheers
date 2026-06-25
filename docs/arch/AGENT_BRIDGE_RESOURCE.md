# Agent Bridge 资源访问协议 (Resource Protocol v1)

> 版本：v1.1（2026-06-25，R13 词表刷新 —— §3.4 权威清单以代码为准）
> 分支：`break/rust-gateway-arch`
> 适用范围：Bot（内置/外置）通过 Agent Bridge data channel 访问平台资源
> 配套：[WIRE_PROTOCOL.md](./WIRE_PROTOCOL.md) · [TASK_DELIVERY.md](./TASK_DELIVERY.md) · [FILE_STORAGE.md](./FILE_STORAGE.md)

---

> ## ⚠️ 本文档部分内容描述的是已被取代的旧模型
>
> 本文档成稿于「平台拥有 memory 层」的时代，下列概念在本文档中仍按**当前行为**呈现，但**均已废弃**：
> `channel.memory` / `channel.memory.update` 这两个 resource 动词（指向已 DROP 的 `memory_entries` 表）·
> ANCHOR/DECISIONS/PROGRESS 分层记忆模型 · `Grant` / `trust_level` 细粒度授权（R13 废弃）。
>
> **现行模型（一句话）**：无独立 memory 概念；文件是唯一基质；Context = 插件策展的文件；agent 一律 pull；授权唯 channel-role。
> 记忆相关动词请改用 `fs.*`（文件树），授权以 channel-role 为唯一事实源。
>
> 完整定义见 [context-and-environment.md](./context-and-environment.md) 顶部的「⚠️ CURRENT MODEL (2026-06-23)」声明。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 通道 | **data channel**（复用现有 WS） | 不新增连接；与 `reply`/`delta`/`send` 同通道 |
| 帧类型 | `resource_req` / `resource_res` | request/response 模式，req_id 关联 |
| 协议版本 | **帧带 `v`**（当前 1）；连接时上报支持的 resource 集合 | 可灰度演进，见 §1.1 |
| 权限（读） | **bot 必须是 channel 成员** | 和现有 `check_bot_in_channel` 一致 |
| 权限（写） | **频道成员 + Grant**（`evaluate()`） | 防 untrusted bot 改写记忆/冒发消息，见 §3.4、[BOT_PERMISSION §5.3](./BOT_PERMISSION.md)（⚠️ Grant/trust_level 已废弃，授权唯 channel-role — 见 CURRENT MODEL） |
| 资源粒度 | **channel 作用域** | bot 只能访问它所在 channel 的资源 |
| 文件传输 | 流式分块（data channel） | 大文件不走 HTTP，不阻塞 WS |
| 内置 vs 外置 | **协议完全一样，零特权** | 内置 Agent Service 和外置 ACP bot 走同一套 |
| 现有 HTTP 文件端点 | **保留，resource 协议是并行通道** | 向后兼容；HTTP 适合简单场景 |
| E2EE 配置 | 通过 hello 下发 `acp_security` 元数据 | 当前仅协商，不做 payload 层加解密 |
| provider 配置资源 | 增加 `provider.config.get` 与 `provider.config.update` | 用于查询与更新受控本地 provider 配置，默认白名单 + 敏感字段脱敏 |
| 文件安全 | 资源层提供统一鉴权和审计入口 | 继承 bot 身份鉴权与 provider 配置白名单约束 |

---

## 1. 动机

当前 Agent Bridge 协议定义了 bot 与平台之间的**任务链路**（接收任务 → 流式回复 → 最终结果）。但 bot 在执行任务过程中需要访问平台资源时，缺少统一的通道：

| 场景 | 现状 | 问题 |
|------|------|------|
| 读取 channel 成员列表 | 无标准方式 | bot 无法知道谁在频道里 |
| 读取 channel 历史消息 | 无标准方式 | bot 只能依赖 task 上下文中附带的片段 |
| 读取 channel 文件 | HTTP 端点 (`/agent-bridge/files/...`) | 需要独立 HTTP 连接，与 WS 协议割裂 |
| 上传文件到 channel | HTTP 端点 | 同上 |
| 读写 channel 记忆层 | 无标准方式 | 内置 bot 之前有特权 DB 访问，外置 bot 完全无法访问（⚠️ 历史设计，已废弃 — 现无独立 memory 概念，改用 `fs.*` 文件树；见 CURRENT MODEL） |

本协议通过在 data channel 上新增 `resource_req` / `resource_res` 帧，统一解决以上所有问题。

**核心原则**：bot 通过协议访问平台资源，而非直连数据库。内置 bot 和外置 bot 零区别。

---

## 2. 设计原则

1. **Request/Response 模式**：bot 发 `resource_req`，Backend 回 `resource_res`，通过 `req_id` 关联。
2. **异步非阻塞**：多个 `resource_req` 可以并行发出，不需要等前一个返回。
3. **Channel 作用域**：所有资源操作绑定到一个 `channel_id`，bot 必须是该 channel 的成员。
4. **幂等读操作**：相同参数的读请求返回相同结果（快照语义）。
5. **写操作返回副作用**：写请求的 response 携带被创建/修改资源的最终状态。
6. **可扩展**：新增资源类型只需 Backend 加一个 handler，bot 侧只需发新 `resource` 字段。
7. **向后兼容**：现有 HTTP 文件端点继续工作，resource 协议是并行的增强通道。
8. **受控最小化配置暴露**：`provider.config` 读写采用字段白名单和敏感字段分级返回，避免凭证原文透出。

---

## 3. 帧格式

### 3.1 Request（Bot → Backend）

```jsonc
{
  "type": "resource_req",
  "v": 1,                        // 协议版本，缺省视为 1
  "req_id": "<string>",          // 客户端生成，唯一，用于关联 response
  "resource": "<string>",        // 资源标识符，见 §4
  "params": { ... },             // 资源特定参数，见 §4
  // 或发送加密 envelope（在 acp_security 协商通过后可选）
  "encrypted": true,
  "ciphertext": "<base64>",
  "nonce": "<base64>",
  "tag": "<base64>",
  "kid": "<string | null>"            // 可选，密钥版本标识
}
```

- `v`：resource 协议版本。Backend 对不认识的 `v` 返回 `code: "UNSUPPORTED_VERSION"`。新增字段向后兼容（bot 忽略未知字段），破坏性变更才升 `v`。
- `req_id`：bot 生成的任意字符串（UUID 或递增序号均可），在同一 data channel 连接生命周期内唯一。
- `resource`：点分路径，格式 `{scope}.{entity}[.{action}]`。
- `params`：每个 resource 定义自己的参数结构。

> **Capability 协商**：bot 在 control channel `hello` 时可上报 `supported_resources: [...]`，Backend 据此判断该 connector 能用哪些 resource；未上报则按全集尝试，遇不支持的帧 bot 自行忽略。这让新增 resource 不必要求所有 connector 同步升级。

> **可选端到端加密（当前状态）**：若 connector 已收到 `hello.acp_security` 且 `enabled=true`，可用该握手信息决定是否发送加密 envelope；当前网关只透传配置，不对 `encrypted` 字段做解密与验签，resource 仍按明文解析执行。  
> 建议的握手值：`mode: X25519-ECDH`、`algorithm: AES-256-GCM | ChaCha20-Poly1305`、`allow_plaintext_fallback`。

> **provider.config 安全要求**：`provider.config.get` 与 `provider.config.update` 属于敏感资源。若请求包含敏感字段（`provider.config.get.include_sensitive=true` 或 `provider.config.update` 中任一变更路径处于敏感清单），但未设置 `encrypted=true`，服务端返回 `E2EE_REQUIRED`。  

### 3.2 Response（Backend → Bot）

**成功**：

```jsonc
{
  "type": "resource_res",
  "req_id": "<string>",          // 对应 request 的 req_id
  "ok": true,
  "data": { ... }                // 资源特定返回值，见 §4
}
```

**失败**：

```jsonc
{
  "type": "resource_res",
  "req_id": "<string>",
  "ok": false,
  "error": "<string>",           // 人类可读错误信息
  "code": "<string>"             // 机器可读错误码，见 §5
}
```

### 3.3 并发与顺序

- Bot 可以同时发出多个 `resource_req`，不需要等待前一个返回。
- Backend 按完成顺序返回 `resource_res`（不保证与请求顺序一致）。
- 单个 `resource_req` 的处理是原子的：要么完整成功，要么返回错误。

### 3.4 权限：读=频道成员，写=channel-role

> ⚠️ 历史设计，已废弃 — 本节描述的 `Grant` / `trust_level` 细粒度授权（R13）不再实现；现行授权以 **channel-role** 为唯一事实源；`channel.memory*` 相关行同样作废（见 CURRENT MODEL）。
>
> **现行词表（代码为准，`server/src/resource/mod.rs` dispatch 分支）** —— 本文 §4 各小节按早期版本编写，
> 实际词表已扩充 mesh step-6（`fs.*`、`activity`、by-seq）与 M3 lazy-deliver（`stage`/`realize`）。
> 以下为权威清单，与 DATA_FLOW_AND_REFACTOR_PLAN §2.4 对齐：
>
> | 读（频道成员即可） | 写（channel role ∈ owner/admin/member；`fs.rm`/`fs.mv` 用户路径需 owner/admin） |
> |---|---|
> | `channel.info` `channel.members` `channel.messages` `channel.files` `channel.files.read` `channel.context` `channel.activity.read` `channel.messages.index` `channel.messages.by-seq` `fs.ls` `fs.read` | `channel.messages.create` `channel.files.create` `channel.files.stage` `channel.files.realize` `fs.write` `fs.edit` `fs.append` `fs.rm` `fs.mv` |
>
> 已移除/从未实现的动词：`channel.memory` / `channel.memory.update`（`memory_entries` 表已 DROP）、
> `provider.config.get` / `provider.config.update`（§4.11–4.12 为提案，代码中无对应 dispatch 分支）。
> 错误码：`UNKNOWN_RESOURCE` / `NOT_MEMBER` / `PERMISSION_DENIED` / `NOT_FOUND` / `INTERNAL_ERROR`。

resource 分**读 / 写**两类，授权强度不同（早期表，保留作历史对照，**实际写权限只过 channel-role，不走 Grant**）：

| 类别 | resource | 权限检查 | 失败码 |
|------|----------|---------|--------|
| **读** | `channel.info` / `members` / `messages` / `files` / `files.read` / `context` / `activity.read` / `messages.index` / `messages.by-seq` / `fs.ls` / `fs.read` | `authorize_channel_read`（查 channel 成员 role） | `NOT_MEMBER` |
| **写** | `channel.messages.create` / `channel.files.create` / `channel.files.stage` / `channel.files.realize` / `fs.write` / `fs.edit` / `fs.append` / `fs.rm` / `fs.mv` | 频道成员 **且** `role_can_write`（owner/admin/member） | `NOT_MEMBER` / `PERMISSION_DENIED` |

**写操作的 Grant 映射**（详见 [BOT_PERMISSION §5.3 / §7](./BOT_PERMISSION.md)）：

| 写 resource | Grant resource / action | 默认放行 trust_level |
|-------------|------------------------|---------------------|
| `channel.messages.create` | `channel:messages` / `create` | standard 及以上 |
| `channel.memory.update` | `channel:memory` / `write` | **仅 trusted / system**；standard/untrusted 需审批 |
| `channel.files.create` | `channel:files` / `create` | standard 及以上 |
| 文件删除 | `channel:files` / `delete` | 仅 trusted / system |
| `provider.config.update` | `provider:config` / `update` | **仅 trusted / system**（建议） |

- 处理流程：Backend 收到写类 `resource_req` → 成员校验 → `evaluate(bot_id, resource, action, channel_id=...)` → 通过则执行，否则返回 `PERMISSION_DENIED`。
- 无 grant 时**可触发审批流**（[BOT_PERMISSION §9](./BOT_PERMISSION.md)）：Backend 不直接拒绝，而是发 `permission_request`，用户批准后临时签发 grant 再执行。此时 `resource_res` 在审批完成前不返回（bot 可设超时）。
- `provider.config.get/update` 不走 channel 成员鉴权，采用 bot 归属校验 + provider 级 `evaluate()`。
- **读操作不走 Grant**：读不破坏状态，仅频道成员即可。这与「平台只对会破坏状态的写做集中授权」的原则一致。

---

## 4. 资源目录

### 4.1 `channel.info` — 查询频道信息

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r1",
  "resource": "channel.info",
  "params": {
    "channel_id": "<uuid>"
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r1",
  "ok": true,
  "data": {
    "channel_id": "<uuid>",
    "name": "<string>",
    "type": "public | private | dm",
    "workspace_id": "<uuid>",
    "topic": "<string | null>",
    "created_at": "<RFC3339>",
    "member_count": <int>,
    "auto_assist": <bool>
  }
}
```

**权限**：bot 必须是该 channel 的成员。

### 4.2 `channel.members` — 查询频道成员

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r2",
  "resource": "channel.members",
  "params": {
    "channel_id": "<uuid>",
    "type": "all | user | bot",    // 可选，默认 "all"
    "limit": <int>,                 // 可选，默认 100，最大 500
    "cursor": "<string | null>"     // 可选，翻页游标
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r2",
  "ok": true,
  "data": {
    "members": [
      {
        "member_id": "<uuid>",
        "member_type": "user | bot",
        "display_name": "<string>",
        "username": "<string>",
        "avatar_url": "<string | null>",
        "role": "<string | null>",
        "joined_at": "<RFC3339 | null>"
      }
    ],
    "total": <int>,
    "next_cursor": "<string | null>"
  }
}
```

**权限**：bot 必须是该 channel 的成员。

---

### 4.3 `channel.messages` — 查询频道历史消息

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r3",
  "resource": "channel.messages",
  "params": {
    "channel_id": "<uuid>",
    "limit": <int>,                 // 可选，默认 50，最大 200
    "before": "<msg_id | null>",    // 可选，游标：此消息之前的消息
    "after": "<msg_id | null>",     // 可选，游标：此消息之后的消息
    "include_deleted": <bool>       // 可选，默认 false
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r3",
  "ok": true,
  "data": {
    "messages": [
      {
        "msg_id": "<uuid>",
        "sender_type": "user | bot | system",
        "sender_id": "<uuid>",
        "sender_name": "<string>",
        "content": "<string>",
        "content_data": { ... },
        "msg_type": "text | announcement | secret | permission | ...",
        "reply_to_msg_id": "<uuid | null>",
        "file_ids": ["<uuid>", ...],
        "mention_bot_ids": ["<uuid>", ...],
        "created_at": "<RFC3339>",
        "edited_at": "<RFC3339 | null>",
        "is_deleted": <bool>
      }
    ],
    "meta": {
      "has_more_before": <bool>,
      "has_more_after": <bool>,
      "has_more": <bool>,
      "anchor_found": <bool>,
      "limit": <int>
    }
  }
}
```

**注意**：
- `secret` 类型消息在此端点中以加密形式返回（和 REST API 行为一致）。
- `before` 和 `after` 互斥，不能同时提供。
- `before`（或 `before_id` / `around_id`）向更早方向分页。
- `after` 向更新方向分页（适配增量拉新）。
- 按 `created_at` / `msg_id` 稳定排序，返回给调用方为时间升序（最旧在前）。

**权限**：bot 必须是该 channel 的成员。

---

### 4.4 `channel.messages.create` — 发送消息到频道

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r4",
  "resource": "channel.messages.create",
  "params": {
    "channel_id": "<uuid>",
    "content": "<string>",
    "msg_type": "text | announcement",  // 可选，默认 "text"
    "reply_to_msg_id": "<uuid | null>",          // 可选
    "file_ids": ["<uuid>", ...]                   // 可选
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r4",
  "ok": true,
  "data": {
    "msg_id": "<uuid>",
    "created_at": "<RFC3339>"
  }
}
```

**注意**：
- 这等价于 data channel 的 `send` 帧，但走 resource 协议统一入口。
- 发送者身份为 bot 自身。
- 触发正常的 fan-out（频道内其他成员会收到 WS 推送）。

**权限**：频道成员 **+ Grant** `channel:messages`/`create`（见 §3.4）。无 grant 触发审批。

---

### 4.5 `channel.files` — 查询频道文件列表

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r5",
  "resource": "channel.files",
  "params": {
    "channel_id": "<uuid>",
    "scope": "all | uploaded | generated",  // 可选，默认 "all"
    "limit": <int>,                          // 可选，默认 50，最大 200
    "cursor": "<string | null>"              // 可选，翻页游标
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r5",
  "ok": true,
  "data": {
    "files": [
      {
        "file_id": "<uuid>",
        "filename": "<string>",
        "content_type": "<string>",
        "size_bytes": <int>,
        "status": "active | pending | expired",
        "scope": "uploaded | generated",
        "uploader_id": "<uuid>",
        "created_at": "<RFC3339>",
        "download_url": "<string | null>"      // presigned URL，可选
      }
    ],
    "total": <int>,
    "next_cursor": "<string | null>"
  }
}
```

**权限**：bot 必须是该 channel 的成员。

---

### 4.6 `channel.files.read` — 读取文件内容

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r6",
  "resource": "channel.files.read",
  "params": {
    "file_id": "<uuid>",
    "channel_id": "<uuid>",                   // 用于权限校验
    "format": "text | binary",                // 可选，默认 "text"
    "max_chars": <int>                         // 可选，text 格式截断，默认 200000
  }
}
```

**Response（text 格式）**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r6",
  "ok": true,
  "data": {
    "file_id": "<uuid>",
    "filename": "<string>",
    "content_type": "<string>",
    "content": "<string>",                     // 文本内容（或 markdown 转换结果）
    "truncated": <bool>,
    "size_bytes": <int>
  }
}
```

**Response（binary 格式 — 小文件直传）**：

当文件大小 ≤ 1MB 时，直接在 response 中返回：

```jsonc
{
  "type": "resource_res",
  "req_id": "r6",
  "ok": true,
  "data": {
    "file_id": "<uuid>",
    "filename": "<string>",
    "content_type": "<string>",
    "data_b64": "<base64 编码的文件内容>",
    "size_bytes": <int>
  }
}
```

**Response（binary 格式 — 大文件分块）**：

当文件大小 > 1MB 时，Backend 先返回一个 `chunk_start`，然后发送多个 `chunk`，最后发 `chunk_end`：

```jsonc
// 1. Backend → Bot: 开始传输
{
  "type": "resource_chunk",
  "req_id": "r6",
  "phase": "start",
  "file_id": "<uuid>",
  "filename": "<string>",
  "content_type": "<string>",
  "size_bytes": <int>,
  "chunk_size": <int>,              // 每块大小（字节）
  "total_chunks": <int>
}

// 2. Backend → Bot: 数据块（重复 N 次）
{
  "type": "resource_chunk",
  "req_id": "r6",
  "phase": "data",
  "index": <int>,                   // 从 0 开始
  "data_b64": "<base64>"
}

// 3. Backend → Bot: 传输完成
{
  "type": "resource_chunk",
  "req_id": "r6",
  "phase": "end",
  "checksum": "<string | null>"     // 可选，SHA-256 hex
}
```

Bot 通过 `req_id` 将 chunk 和原始请求关联。在收到 `chunk_end` 前，同一个 `req_id` 不会有新的 `resource_res`。

**权限**：bot 必须是该文件所属 channel 的成员。校验直接按 `file_records.channel_id` + channel 成员关系（`authorize_channel_read`）进行；旧的 `file_scope_links` join 表从未被写入，已在迁移 `0017_drop_file_scope_links` 中删除。

---

### 4.7 `channel.files.create` — 上传文件到频道

**Request（小文件，base64 直传）**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r7",
  "resource": "channel.files.create",
  "params": {
    "channel_id": "<uuid>",
    "filename": "<string>",
    "content_type": "<string | null>",         // 可选，默认按扩展名推断
    "data_b64": "<base64>"                     // ≤ 4MB
  }
}
```

**Request（大文件，分块上传）**：

```jsonc
// 1. Bot → Backend: 发起上传
{
  "type": "resource_req",
  "req_id": "r7",
  "resource": "channel.files.create",
  "params": {
    "channel_id": "<uuid>",
    "filename": "<string>",
    "content_type": "<string | null>",
    "size_bytes": <int>,                       // 必须提供，用于预分配
    "upload_mode": "chunked"
  }
}

// 2. Bot → Backend: 数据块（重复 N 次）
{
  "type": "resource_chunk",
  "req_id": "r7",
  "phase": "data",
  "index": <int>,
  "data_b64": "<base64>"                      // 每块 ≤ 1MB
}

// 3. Bot → Backend: 上传完成
{
  "type": "resource_chunk",
  "req_id": "r7",
  "phase": "end",
  "checksum": "<string | null>"
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r7",
  "ok": true,
  "data": {
    "file_id": "<uuid>",
    "filename": "<string>",
    "content_type": "<string>",
    "size_bytes": <int>,
    "created_at": "<RFC3339>"
  }
}
```

**注意**：
- 上传的文件直接记录到指定 channel（`file_records.channel_id`）。
- 文件大小限制：base64 直传 ≤ 4MB，分块上传 ≤ 50MB。
- 生成的 `file_id` 可以直接用于 `reply`/`send` 帧的 `file_ids` 字段。

**权限**：频道成员 **+ Grant** `channel:files`/`create`（见 §3.4）。无 grant 触发审批。

---

### 4.8 `channel.memory` — 读取频道记忆层

> ⚠️ 历史设计，已废弃 — `channel.memory` 动词指向已 DROP 的 `memory_entries` 表（`0003_decentralized_mesh.sql:89`），ANCHOR/DECISIONS/PROGRESS 分层模型不再存在；改用 `fs.*` 读取 `context_files` 文件树（见 CURRENT MODEL）。

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r8",
  "resource": "channel.memory",
  "params": {
    "channel_id": "<uuid>",
    "layer": "ANCHOR | DECISIONS | PROGRESS"   // 必须指定
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r8",
  "ok": true,
  "data": {
    "channel_id": "<uuid>",
    "layer": "<string>",
    "entries": [
      {
        "entry_id": "<uuid>",
        "title": "<string>",
        "content": "<string>",
        "metadata": { ... },
        "created_at": "<RFC3339>",
        "updated_at": "<RFC3339>"
      }
    ],
    "updated_at": "<RFC3339 | null>"
  }
}
```

**权限**：bot 必须是该 channel 的成员。

---

### 4.9 `channel.memory.update` — 写入频道记忆层

> ⚠️ 历史设计，已废弃 — `channel.memory.update` 写入已 DROP 的 `memory_entries` 表，其 `Grant`/`trust_level` 授权（R13）亦废弃；现无独立 memory 概念，写文件改用 `fs.*`，授权唯 channel-role（见 CURRENT MODEL）。

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r9",
  "resource": "channel.memory.update",
  "params": {
    "channel_id": "<uuid>",
    "layer": "ANCHOR | DECISIONS | PROGRESS",
    "mode": "replace | append",               // 可选，默认 "replace"
    "entries": [
      {
        "title": "<string>",
        "content": "<string>",
        "metadata": { ... }                    // 可选
      }
    ]
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r9",
  "ok": true,
  "data": {
    "channel_id": "<uuid>",
    "layer": "<string>",
    "entries": [ ... ],                        // 写入后的完整条目列表
    "updated_at": "<RFC3339>"
  }
}
```

**注意**：
- `replace` 模式：替换整个层的内容。
- `append` 模式：在现有条目后追加。
- 写入会触发记忆层的 `updated_at` 时间戳更新。

**权限**：频道成员 **+ Grant** `channel:memory`/`write`（见 §3.4）。
**默认仅 `trusted`/`system` 放行**；`standard`/`untrusted` 无默认 grant，须经审批临时签发——这是「防 untrusted bot 改写频道记忆」的收口点。
> ⚠️ 历史设计，已废弃 — `Grant`/`trust_level` 授权（R13）不再实现，授权唯 channel-role（见 CURRENT MODEL）。

---

### 4.10 `channel.context` — 查询频道上下文摘要

提供 bot 执行任务时常用的上下文信息的聚合查询，避免多次 round-trip。

> ⚠️ 部分内容历史设计，已废弃 — 本节 `include`/`data` 中的 `memory`（ANCHOR/DECISIONS/PROGRESS）已废弃；现行 Context = 插件策展的文件，经 `fs.*` 拉取（见 CURRENT MODEL）。

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r10",
  "resource": "channel.context",
  "params": {
    "channel_id": "<uuid>",
    "include": ["info", "members_summary", "recent_messages", "memory"],
    "recent_message_limit": <int>              // 可选，默认 20
  }
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r10",
  "ok": true,
  "data": {
    "info": { ... },                           // 同 channel.info 的 data
    "members_summary": {
      "total": <int>,
      "users": <int>,
      "bots": <int>,
      "online_users": <int>
    },
    "recent_messages": [ ... ],                // 同 channel.messages 的 data.messages
    "memory": {
      "ANCHOR": { ... },
      "DECISIONS": { ... },
      "PROGRESS": { ... }
    }
  }
}
```

**注意**：
- `include` 数组中未列出的字段不在 response 中出现。
- 这是纯读操作，幂等。

**权限**：bot 必须是该 channel 的成员。

### 4.11 `provider.config.get` — 查询受控 provider 配置

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r11",
  "resource": "provider.config.get",
  "params": {
    "fields": ["provider.timeout", "provider.base_url"], // 可选；空则返回可见字段集合
    "include_sensitive": false,                         // 可选，默认 false
    "config_version": 12                               // 可选，服务端回传一致性检查使用
  },
  "encrypted": true,                                  // 若请求敏感字段，必须 true
  "ciphertext": "...",
  "nonce": "...",
  "tag": "..."
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r11",
  "ok": true,
  "data": {
    "bot_id": "<uuid>",
    "provider_id": "<uuid>",
    "config_version": 12,
    "fields": [
      {
        "path": "provider.timeout",
        "value": "30s",
        "sensitivity": "public",
        "redacted": false
      },
      {
        "path": "provider.token_hint",
        "value": "sk_live_***",
        "sensitivity": "sensitive",
        "redacted": true
      }
    ],
    "missing_fields": ["provider.unknown_key"],
    "redacted_fields": ["provider.secret_key", "provider.credentials"]
  }
}
```

**注意**：
- `fields` 与 `redacted_fields` 同时返回，调用方可确认“可见值 vs 被策略过滤”。
- `sensitivity` 仅用于策略说明；实际策略以 backend 白名单为准。
- 当 `include_sensitive=true` 但未加密时，返回 `E2EE_REQUIRED`。
- `config_version` 用于更新时的乐观锁。

**权限**：bot 归属校验 + `evaluate(bot_id, "provider.config", "get", "provider")`；`FORBIDDEN_FIELD`、`DECRYPT_FAILED` 由后端返回。

### 4.12 `provider.config.update` — 更新受控 provider 配置

**Request**：

```jsonc
{
  "type": "resource_req",
  "req_id": "r12",
  "resource": "provider.config.update",
  "params": {
    "expected_version": 12,
    "updates": [
      {
        "path": "provider.timeout",
        "op": "set",
        "value": "45s"
      },
      {
        "path": "provider.token_hint",
        "op": "set",
        "value": "sk_live_***"
      }
    ],
    "dry_run": false
  },
  "encrypted": true,
  "ciphertext": "...",
  "nonce": "...",
  "tag": "..."
}
```

**Response**：

```jsonc
{
  "type": "resource_res",
  "req_id": "r12",
  "ok": true,
  "data": {
    "provider_id": "<uuid>",
    "applied_version": 13,
    "applied": [
      {
        "path": "provider.timeout",
        "status": "ok"
      }
    ],
    "skipped": [
      {
        "path": "provider.token_hint",
        "status": "forbidden"
      }
    ]
  }
}
```

**注意**：
- `expected_version` 缺失或与服务端版本不一致时返回 `VERSION_CONFLICT`（乐观锁防并发修改）。
- `op` 仅允许 `set` / `delete`，`op` 之外路径或类型更新由 `FORBIDDEN_FIELD` 拦截。
- `provider.config.update` 必须使用加密 envelope（即使 `include_sensitive=false`），以防回放与篡改。
- 对同一 `provider_id` 的高频更新返回 `CONFIG_CHANGE_TOO_FAST`。
- 所有更新必须写审计日志：`who / when / fields / old_version / new_version`。

**权限**：bot 归属校验 + `evaluate(bot_id, "provider.config", "update", "provider")`；`VERSION_CONFLICT` 与 `DECRYPT_FAILED` 会中断更新。

---

## 5. 错误码

| Code | 含义 | 典型触发场景 |
|------|------|------------|
| `NOT_MEMBER` | bot 不是该 channel 的成员 | 任何资源请求，bot 未加入该 channel |
| `NOT_FOUND` | 资源不存在 | file_id / msg_id / channel_id 无效 |
| `PERMISSION_DENIED` | **写操作无 Grant**（且未走/未通过审批），或尝试写只读资源 | `channel.memory.update` 等写类（见 §3.4） |
| `UNSUPPORTED_VERSION` | `v` 不被支持 | 协议版本不匹配 |
| `INVALID_PARAMS` | 参数校验失败 | 缺少必填字段、类型错误、超范围值 |
| `PAYLOAD_TOO_LARGE` | 数据过大 | 文件上传超限、content 超长 |
| `RATE_LIMITED` | 请求频率超限 | 短时间大量 resource_req |
| `INTERNAL_ERROR` | 服务端内部错误 | DB 查询失败、S3 不可达 |
| `CONFLICT` | 资源状态冲突 | 并发写入冲突 |
| `UPLOAD_INCOMPLETE` | 分块上传未完成 | 在 chunk_end 之前发了新的 resource_req |
| `E2EE_REQUIRED` | `provider.config` 敏感字段未加密 | 请求未满足加密要求 |
| `FORBIDDEN_FIELD` | 字段不在可见清单 | 请求读取或更新受保护字段 |
| `DECRYPT_FAILED` | envelope 解密失败 | tag/密钥错误或 payload 篡改 |
| `VERSION_CONFLICT` | 乐观锁版本冲突 | `expected_version` 与服务端不一致 |
| `CONFIG_CHANGE_TOO_FAST` | 配置更新过于频繁 | 同一 `provider_id` 高频变更被限流 |

---

## 6. 速率限制

| 维度 | 限制 | 粒度 |
|------|------|------|
| `resource_req` 总频率 | 30 req/s | per bot |
| `channel.messages` 单次 | limit ≤ 200 | per request |
| `channel.members` 单次 | limit ≤ 500 | per request |
| `channel.files.create` 单文件 | ≤ 50MB | per file |
| `channel.memory.update` 单次 | ≤ 50 entries | per request |
| `provider.config.get` | ≤ 60 次/分钟 | per bot |
| `provider.config.update` | ≤ 10 次/分钟 | per bot |

超出限制时返回 `RATE_LIMITED` 错误码。Backend 应在 `data` 中携带 `retry_after_seconds` 字段。

---

## 7. 与现有协议的关系

### 7.1 和 data channel 现有帧的共存

`resource_req` / `resource_res` / `resource_chunk` 是 data channel 的**新增帧类型**，与现有帧完全正交：

```
Data Channel 帧类型:
  ├─ 任务链路: reply, send, delta, done, error, trace
  ├─ 文件操作: file_upload, file_upload_ack
  ├─ 会话管理: session_update, permission_request
  ├─ 连接管理: ping, pong, subscribe, resume
  └─ 资源访问: resource_req, resource_res, resource_chunk  ← 新增
```

Bot 可以在等待 `delta` 流式输出的同时，并行发 `resource_req` 查询其他 channel 的资源。

### 7.2 和 HTTP 文件端点的关系

| 方式 | 端点 | 适用场景 |
|------|------|---------|
| HTTP | `/agent-bridge/files/{id}/content` | 简单读取，单文件，已有 HTTP 客户端 |
| HTTP | `/agent-bridge/files/upload` | 简单上传，单文件 |
| WS resource | `channel.files.read` | WS-only bot，需要保持单连接 |
| WS resource | `channel.files.create` | WS-only bot，大文件分块上传 |
| WS resource | `channel.files` | 批量查询文件列表（HTTP 无此端点） |
| WS resource | `provider.config.get` | 读取受控配置字段（支持白名单、脱敏、可选密钥加密） |
| WS resource | `provider.config.update` | 更新受控配置字段（推荐 E2EE + 版本与审计） |

两者并行，bot 自行选择。resource 协议的额外优势：批量查询、分块传输、与任务链路共享连接。

### 7.3 和 `send` 帧的关系

`channel.messages.create` 和 data channel 的 `send` 帧功能重叠。区别：

| 维度 | `send` 帧 | `channel.messages.create` |
|------|----------|--------------------------|
| 语义 | "发送一条消息" | "在频道里创建一条消息" |
| 走 resource 协议 | 否 | 是 |
| 统一错误处理 | 否（`send_ack` 独立格式） | 是（`resource_res` 统一格式） |
| 适用场景 | 直接回复、快速发送 | 与资源操作组合使用 |

建议：bot 新代码统一用 `channel.messages.create`，`send` 帧保留向后兼容。

---

## 8. 实现要点

### 8.1 Backend（Rust）

```
agent_bridge/
├── resource/
│   ├── mod.rs               ← resource_req 分发器
│   ├── channel_info.rs      ← channel.info
│   ├── members.rs           ← channel.members
│   ├── messages.rs          ← channel.messages, channel.messages.create
│   ├── files.rs             ← channel.files, channel.files.read, channel.files.create
│   ├── memory.rs            ← channel.memory, channel.memory.update
│   ├── provider_config.rs   ← provider.config.get / provider.config.update
│   └── context.rs           ← channel.context (聚合查询)
```

每个 handler 调用 `domain` 模块的现有逻辑，不引入新业务代码。

权限检查：
- **读类**（channel 作用域）：`check_bot_in_channel(session, bot_id, channel_id)`。
- **读类**（provider 配置）：`check_bot_owner(bot_id)` + `permission::evaluate(bot_id, "provider.config", "get", "provider")`。
- **写类**（channel 作用域）：`check_bot_in_channel(...)` **且** `permission::evaluate(bot_id, resource, action, channel_id)`（见 §3.4）；无 grant 时走审批流（[BOT_PERMISSION §9](./BOT_PERMISSION.md)）。
- **写类**（provider 配置）：`check_bot_owner(bot_id)` + `permission::evaluate(bot_id, "provider.config", "update", "provider")`。
- provider 配置类操作还需要：
  1. envelope 解密（若协商要求加密）；失败返回 `DECRYPT_FAILED`。
  2. 字段白名单与敏感字段过滤，不符返回 `FORBIDDEN_FIELD`。
  3. `expected_version` 一致性检查，不一致返回 `VERSION_CONFLICT`。
  4. 变更频率控制，不满足返回 `CONFIG_CHANGE_TOO_FAST`。
  5. 写审计日志（操作者、字段、old_version、new_version、ip、bot 连接 id）。

### 8.2 Agent Service（Python）

```python
# agent_service/resources.py
class ResourceClient:
    """通过 data channel WS 访问平台资源"""

    def __init__(self, data_ws):
        self._ws = data_ws
        self._pending: dict[str, asyncio.Future] = {}
        self._req_counter = 0

    async def request(self, resource: str, params: dict) -> dict:
        req_id = f"r{self._req_counter}"
        self._req_counter += 1
        future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = future
        await self._ws.send_json({
            "type": "resource_req",
            "req_id": req_id,
            "resource": resource,
            "params": params,
        })
        return await future

    def handle_resource_res(self, frame: dict):
        req_id = frame["req_id"]
        future = self._pending.pop(req_id, None)
        if future:
            future.set_result(frame)

    # 便捷方法
    async def get_channel_members(self, channel_id: str) -> list[dict]:
        res = await self.request("channel.members", {"channel_id": channel_id})
        return res["data"]["members"]

    async def get_messages(self, channel_id: str, limit: int = 50) -> list[dict]:
        res = await self.request("channel.messages", {"channel_id": channel_id, "limit": limit})
        return res["data"]["messages"]

    async def read_memory(self, channel_id: str, layer: str) -> dict:
        res = await self.request("channel.memory", {"channel_id": channel_id, "layer": layer})
        return res["data"]

    async def update_memory(self, channel_id: str, layer: str, entries: list, mode: str = "replace"):
        res = await self.request("channel.memory.update", {
            "channel_id": channel_id, "layer": layer, "entries": entries, "mode": mode
        })
        return res["data"]

    async def read_file(self, file_id: str, channel_id: str) -> dict:
        res = await self.request("channel.files.read", {"file_id": file_id, "channel_id": channel_id})
        return res["data"]

    async def upload_file(self, channel_id: str, filename: str, data: bytes, content_type: str | None = None) -> dict:
        import base64
        res = await self.request("channel.files.create", {
            "channel_id": channel_id,
            "filename": filename,
            "content_type": content_type,
            "data_b64": base64.b64encode(data).decode(),
        })
        return res["data"]

    async def get_context(self, channel_id: str) -> dict:
        res = await self.request("channel.context", {
            "channel_id": channel_id,
            "include": ["info", "members_summary", "recent_messages", "memory"],
        })
        return res["data"]
```

### 8.3 外置 ACP Bot（第三方）

第三方 bot 也可以使用 resource 协议。只需要：
1. 连接 data channel
2. 处理 `resource_res` 和 `resource_chunk` 帧
3. 发送 `resource_req` 帧

协议文档（本文档）即为完整规范，无需额外 SDK。

---

## 9. 迁移路径

| 阶段 | 动作 |
|------|------|
| Phase 0 | 协议定稿（本文档）；Python 侧 resource handler 原型实现 |
| Phase 1 | Rust Backend 实现 resource 协议（配合 agent_bridge 模块） |
| Phase 2 | Agent Service 改用 resource 协议访问平台资源（替代直接 DB 访问） |
| Phase 3 | HTTP 文件端点可选废弃（resource 协议完全替代） |

---

## 附录 A：一次完整的 bot 任务执行时序（含 resource 访问）

```
Client ──REST──▶ Backend : POST /channels/C/messages ("帮我总结这个频道的讨论")
Backend ──WS──▶ Bot : {type:"task", task_id:T, channel_id:C, msg_id:M}

Bot (Python Agent Service):
  │
  ├─ resource_req: channel.context (查询频道上下文)
  │   └─ resource_res: {info, members, recent_messages, memory}
  │
  ├─ resource_req: channel.files (查询频道文件)
  │   └─ resource_res: {files: [{file_id:F1, filename:"design.md", ...}]}
  │
  ├─ resource_req: channel.files.read (读取文件内容)
  │   └─ resource_res: {content: "# Design Doc\n..."}
  │
  ├─ delta(M, seq:0, "根据频道讨论和设计文档...")
  ├─ delta(M, seq:1, "主要结论如下...")
  ├─ ...
  │
  ├─ resource_req: channel.memory.update (写入总结到记忆)
  │   └─ resource_res: {entries: [...]}
  │
  └─ done(M, content="完整总结...")

Backend ──WS──▶ Client : message_done
```

Bot 全程通过 resource 协议访问平台资源，不直连数据库。
