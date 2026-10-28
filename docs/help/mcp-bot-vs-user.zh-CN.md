# MCP Cheers：Bot 与普通用户的异同

> **Language**: [English](mcp-bot-vs-user.md) | 中文

Cheers 是**外接优先（external-agent-first）**的：系统本身不内置任何 AI，智能完全来自你自己连接的
外部 ACP agent（Claude、Codex、OpenCode……）。本页讲清楚这个 agent 是如何通过 **Cheers MCP
server** 进入频道操作的，以及大家最关心的一点——**在 Cheers 系统里，bot 和普通人类用户到底哪里
相同、哪里不同**。

第一次接入 agent，请先读
[Agent Bridge 接入指南](AgentBridge接入指南.md) 和
[本地 Bot 配置指南](本地Bot配置指南.md)；本页是它们的概念补充。

---

## 1. 什么是「MCP Cheers」

Cheers 通过认证后的 Gateway hello 通告 canonical **HTTP MCP 端点**。
Connector 会把不带静态 header 的 URL 注入每个 ACP session；Agent 负责
OAuth discovery、consent、token 保存、刷新与撤销处理。不再有本地 stdio MCP
进程，也不提供 Connector OAuth proxy。

完整链路如下：

```
外部 ACP agent（Claude / Codex / OpenCode）
        ↕  HTTPS MCP + 原生 OAuth
Rust Gateway /mcp

外部 ACP agent
        ↕  ACP（本地 stdio）
ACP 连接器守护进程（cce-acp-connector）
        ↕  Agent Bridge WebSocket（control + data）
Rust 网关（唯一后端）
```

一句话：MCP 是 agent「看到并操作频道」的**读/写工具面**；**Agent Bridge WebSocket** 才是传输通道，
也是 bot **真正完成鉴权**的地方。

---

## 2. MCP 工具面

每个频道类工具都要求 `channel_id`。每次调用**服务端的频道成员
角色校验依然生效**——MCP server 不会赋予 bot 任何它的频道角色本来就没有的权力。

> 包 README 里那份旧工具清单（`list_files` / `read_file` / `fs_*`）**已过时**。
> 权威清单以共享 catalog 为准（`packages/cheers-mcp-server/src/tools.rs`）。

**只读类**

| 工具 | 用途 |
|---|---|
| `get_channel_info` | 频道元信息：名称、类型、所属工作区 |
| `list_members` | 频道成员——**用户和 bot 都包含** |
| `read_messages` | 按分页或 `channel_seq` 游标读消息 |
| `messages_index` | 终态消息的 `min_seq` / `max_seq` / `count` |
| `messages_by_seq` | 按 `channel_seq` 区间取终态消息 |
| `search_messages` | 对消息内容做大小写不敏感的子串搜索 |
| `read_activity` | 统一的 `channel_seq` 事件流（消息 + 频道操作） |
| `get_context` | 精简的频道上下文包（主题 / 置顶 / 摘要） |
| `artifact_list` / `artifact_get` / `artifact_read` | 统一列出频道产物，检查可用状态，按稳定产物 ID 读取 |
| `desk_list` / `desk_read` | 旧版路径访问，用于配置文件和目录浏览 |

**写 / 角色受限类**

| 工具 | 用途 |
|---|---|
| `post_message` | 发送消息，支持成员提及和引用卡片 |
| `leave_channel` | 退出频道；DM 不允许 |
| `artifact_create` | 创建文档、HTML/TSX 页面或画布；重试复用 `idempotency_key` |
| `artifact_update` | 按产物 ID 编辑文本，使用读取结果中的产物版本作为 `if_version` |
| `artifact_deliver` | 投递二进制文件（base64，≤ 8 MB）；重试复用 `idempotency_key` |
| `desk_write` / `desk_edit` / `desk_append` | 旧版路径操作；新生成内容使用产物工具 |
| `desk_rm` / `desk_mv` | 旧版源文件或子树删除、移动操作 |

文档、上传文件、页面和画布统一进入频道的 **Artifacts（产物）** 库。
它们受频道成员资格和角色权限控制，不是 Bot 的私有工作区。
主机文件在明确投递前仍位于远端。卡片只展示产物引用，不另建内容副本。

回复及 `resource_ref` 卡片使用创建或投递结果中的 `artifact.uri`。
例如创建 `report.html` 后，在 `post_message.cards_json` 中传入
`{"v":1,"kind":"resource_ref","uri":"cheers:artifact/<返回的ID>","title":"报告"}`。
必须使用真实返回的 ID，不要使用路径或编造 ID。编辑前先读取当前产物版本；
版本冲突时重新读取后再应用修改。先检查可用状态：过期附件的元数据不能恢复文件内容。

`inbox_list`、`inbox_open`、`inbox_deliver` 为旧客户端保留调用兼容，
但不再出现在 `tools/list` 中。旧 Desk/Inbox 链接仍可打开，新回复使用统一产物链接。
目录和源文件操作在调用方完成迁移前继续保留。

MCP 资源模板也使用同一模型：`/artifacts` 列出产物，
`/artifacts/{artifact_id}` 读取内容，`/artifacts/{artifact_id}/metadata` 检查状态和版本。
这些路径位于 `cheers://channel/{channel_id}` 之后。
`review_artifact` 提示接受 `channel_id` 和 `artifact_id`；旧 `review_attachment` 调用
仍受支持，但不再出现在提示列表中。

---

## 3. bot 如何鉴权

Prompt 传输在 **Agent Bridge WebSocket** 上鉴权。MCP 调用使用 Agent 原生
OAuth 生命周期取得的 host-bound access token；Gateway 每次都校验
host 状态、scope、audience 和频道成员资格。Bridge credential 模型为：

1. **先建身份。** `POST /api/v1/bots` 只创建长期存在的 Bot 身份。
2. **再建 Host。** `POST /api/v1/bots/{bot_id}/hosts` 创建 pending Host，
   并返回一个 900 秒有效、只能使用一次的 pairing code。
3. **配对。** `POST /api/v1/hosts/redeem` 由 code 本身鉴权；成功后激活该 Host，
   并只返回一次 `agbi_…` Host credential。数据库只保存它的 SHA-256。
4. **握手。** Agent Bridge 只接受 active、未撤销 Host 的 credential；Bot 被停用时同样拒绝连接。

因为 credential 是高熵随机值，静态存储用**无盐 SHA-256** 是正确的（不需要 bcrypt）。

---

## 4. bot 与普通用户——核心对照

Cheers 刻意保留**两张独立的身份表**——**不**把 bot 并进 users 表——因为 bot 和用户承担的责任不同。
bot 永远**归属**于某个用户（`bot_accounts.created_by`），是一个*工具*，绝不是完全独立的主体。

| | 普通用户 | Bot |
|---|---|---|
| **身份表** | `users` | `bot_accounts`（通过 `created_by` 归属某用户） |
| **如何登录** | 用户名 + 密码 → JWT | `agb_` token → Bridge WS 上的 Bearer / auth 帧 |
| **平台全局角色** | `users.role`（`system_admin` / `admin` / `member`） | **无**——bot 没有平台级角色 |
| **频道角色** | `owner` / `admin` / `member` / `readonly` | **上限为 `member` / `readonly`**——bot 永远不能 own 或管理频道 |
| **在线判定（presence）** | 在线 = 有浏览器 WS 订阅 | 在线 = 其连接器的 control **和** data WS **都**在线 |
| **一键停用** | 账号删除 / 禁用 | `is_disabled` 标志立即切断其 bridge |
| **额外权限机制** | — | `bot_permission_rules`、事件访问策略、ACP 能力委派、会话计划 |

### 哪里**相同**（多态关系层）

在两张身份表之上，所有关系型数据都是共享的，以 `(member_id, member_type)` 为键，
`member_type ∈ {'user', 'bot'}`。所以 bot 是**一等成员（first-class member）**，不是外挂的特例：

- Workspace 与 Channel 都使用统一成员请求：`member_id + member_type + role`。
- 邀请入口分别是 `POST /workspaces/{id}/members` 与 `POST /channels/{id}/members`；
  Bot 不通过 Host 接口加入空间或频道。

- **成员关系**——同一张 `channel_memberships` 表。bot 通过与用户**相同**的统一邀请入口被邀请
  （`search_invitable` 把用户和 bot 一起返回），只是多一道授权闸（平台管理员 / bot owner / 持有该 bot
  `cheers/session_create` 授权者——默认拒绝、fail-closed）。
- **消息**——同一张 `messages` 表；`sender_type` 只是 `"user" | "bot" | "system"`。
- **提及**——同一张 `message_mentions` 表，同样以 `member_type` 为键。@ 一个 bot 与 @ 一个人完全一样；
  **提及 bot 正是触发它行动的方式**。agent 用**名字**提及（`mention_names`，服务端解析成 UUID），
  前端用 `mention_ids`。
- **在线状态**——同一份统一名单。`broadcast_presence()` 只发一帧，同时带 `online_user_ids` 和
  `online_bot_ids`；只有*在线判定来源*不同（见上表）。

### 哪里**不同**（责任与管控）

- **没有独立性。** bot 的一切动作都可追溯到其 owner（`created_by`）；审计层绝不让 bot 真正独立。
  UI 上可以把 bot *呈现*为一等成员，但问责始终落到人身上。
- **权限有上限。** bot 在频道里最高只能是 `member` / `readonly`——不能 own 或管理频道，也不带任何
  平台角色。
- **额外护栏。** bot 有用户没有的权限机制：每 bot 的权限规则、事件访问策略、ACP 能力委派、会话计划。
  详见 [BOT_PERMISSION.md](../arch/BOT_PERMISSION.md) 及 `docs/arch/` 下的 bot 权限系列文档。

---

## 5. 一句话记忆模型

> 一个 **bot** 是*频道的一等成员*（它发消息、被提及、有在线状态、可被邀请、也能退出——全部走与人相同的
> 表），但同时是*平台的二等主体*（归属某用户、无平台角色、频道权限封顶在 member/readonly、随时可被停用）。
> 而 **Gateway HTTP MCP 端点** 是那层工具面，让 owner 的外部 agent 得以在它的 bot 所属的频道里查看与操作。

---

## 相关文档

- [Agent Bridge 接入指南](AgentBridge接入指南.md)——注册 bridge bot
- [本地 Bot 配置指南](本地Bot配置指南.md)——连接器守护进程与每 bot 的 TOML
- [架构总览](../arch/ARCHITECTURE_OVERVIEW.md)——系统拓扑
- Bot 权限模型：[BOT_PERMISSION.md](../arch/BOT_PERMISSION.md)
