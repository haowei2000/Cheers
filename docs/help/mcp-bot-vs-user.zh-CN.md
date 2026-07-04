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

`cheers-mcp-server` 是一个本地的 **stdio MCP server**（单个 Rust 二进制）。它**不**与你 agent 的
模型对话，也**不**是 bot 通过网络连接的对象。真正的关系是：**ACP 连接器守护进程**
（`cce-acp-connector`）把它作为子进程拉起，并注入几个环境变量，让它知道自己在哪个频道里行动：

| 环境变量 | 含义 |
|---|---|
| `CHEERS_RESOURCE_URL` | 回到连接器的 loopback 端点 |
| `CHEERS_RESOURCE_TOKEN` | 该 loopback 的可选 bearer |
| `CHEERS_CHANNEL_ID` | 工具默认作用的频道 |
| `CHEERS_BOT_ID` | 当前以哪个 bot 身份行动 |
| `CHEERS_SESSION_ID` | 当前 bridge 会话 |
| `CHEERS_REQUEST_TIMEOUT_MS` | 单次调用超时 |

完整链路如下：

```
外部 ACP agent（Claude / Codex / OpenCode）
        ↕  ACP（stdio）
ACP 连接器守护进程（cce-acp-connector）
        ↕  Agent Bridge WebSocket（control + data）
Rust 网关（唯一后端）
        ↑
        └── 连接器同时拉起 cheers-mcp-server（stdio），
            它通过连接器的 loopback 把频道资源取回给 agent
```

一句话：MCP 是 agent「看到并操作频道」的**读/写工具面**；**Agent Bridge WebSocket** 才是传输通道，
也是 bot **真正完成鉴权**的地方。

---

## 2. MCP 工具面

每个工具都接受一个可选的 `channel_id`（缺省回退到 `CHEERS_CHANNEL_ID`）。每次调用**服务端的频道成员
角色校验依然生效**——MCP server 不会赋予 bot 任何它的频道角色本来就没有的权力。

> 包 README 里那份旧工具清单（`list_files` / `read_file` / `fs_*`）**已过时**。
> 权威清单以源码为准（`packages/cheers-mcp-server/src/main.rs`）。

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
| `inbox_list` / `inbox_open` | 按 `file_id` 列出 / 打开人类上传的聊天附件 |
| `desk_list` / `desk_read` | 按路径列出 / 读取 bot 自己的工作区（desk）文件 |

**写 / 角色受限类**

| 工具 | 用途 |
|---|---|
| `post_message` | 发消息；支持 `mention_ids` / `mention_names` 来 @ 提及成员 |
| `leave_channel` | 把自己移出频道（等同于人退出）；DM 不允许 |
| `inbox_deliver` | 以附件形式投递一个新文件（base64，≤ 8MB）到频道 |
| `inbox_stage` | 注册一个本地路径，作为延迟投递的暂存附件 |
| `desk_write` / `desk_edit` / `desk_append` | 创建 / 编辑 / 追加 desk 文件（用 `if_version` 做乐观锁） |
| `desk_rm` / `desk_mv` | 删除 / 移动 desk 文件或子树 |

要分清两个文件空间（已写进 MCP 的 initialize 提示里）：

- **INBOX**（`inbox_*`）——**只读**，人类上传的文件，用 `file_id` 寻址。
- **DESK**（`desk_*`）——bot **私有、可编辑**的工作区，用 `path` 寻址。

---

## 3. bot 如何鉴权

鉴权**不**发生在 MCP server，而是在 **Agent Bridge WebSocket** 上。token 模型：

1. **签发。** `generate_bot_token()` 生成 `agb_<hex>` token。明文**只返回一次**；库里只存它的
   **SHA-256**，落在 `bot_accounts.bot_token_hash`（外加一个仅用于展示的 `bot_token_prefix`）。
   再次签发即轮换，旧 token 立即失效。
2. **唯一签发路径。** `mint_bot_token()` 是唯一创建 token 的代码，有两个入口：
   - `POST /api/v1/bots/{bot_id}/token`——手动签发/轮换，仅 bot 的 **owner 或管理员**可调。
   - **enrollment 兑换**——`POST /api/v1/bots/{bot_id}/enrollment` 签发一个一次性、900 秒、单次
     使用的 **enrollment code**；`POST /api/v1/enrollment/redeem`（系统里**唯一**免鉴权的端点——它
     靠 code 本身鉴权）用这个 code 换回一个 bot token。这是连接器丝滑接入用的路径。
3. **握手。** 在 Bridge WS 上，control 通道优先读 `Authorization: Bearer <token>` 头；没有则接受
   第一帧携带 token 的 JSON `auth` 帧。
4. **校验。** `resolve_bot()` 把提交的 token 做哈希，反查 `bot_accounts WHERE bot_token_hash = $1`。
   被标记 `is_disabled`（管理员一键停用开关）的 bot 会以 `BotUnavailable` 拒绝。

因为 token 是高熵随机值，静态存储用**无盐 SHA-256** 是正确的（不需要 bcrypt）。

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
> 而 **MCP server** 只是那层工具面，让 owner 的外部 agent 得以在它的 bot 所属的频道里查看与操作。

---

## 相关文档

- [Agent Bridge 接入指南](AgentBridge接入指南.md)——注册 bridge bot
- [本地 Bot 配置指南](本地Bot配置指南.md)——连接器守护进程与每 bot 的 TOML
- [架构总览](../arch/ARCHITECTURE_OVERVIEW.md)——系统拓扑
- Bot 权限模型：[BOT_PERMISSION.md](../arch/BOT_PERMISSION.md)
