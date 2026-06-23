# MCP Agent 侧拓扑与权限边界

> 配套：[ACP_INTEGRATION](./ACP_INTEGRATION.md) · [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) · [BOT_PERMISSION](./BOT_PERMISSION.md)

本文描述 `cheers-mcp-server` 的运行拓扑，以及"权限边界在 connector 层"这一核心设计原则。

---

## 1. Agent 侧的进程拓扑

```
┌─ 用户本地 ─────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─ Agent 进程（LLM runtime）────────────────────────────────┐  │
│  │  只表达意图：调用 MCP 工具，不持有任何凭证                   │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │ stdio（MCP JSON-RPC）                  │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │  cheers-mcp-server（Rust stdio 子进程）                │  │
│  │  · 由 connector 启动，注入 env vars                        │  │
│  │  · 把 MCP tool call 翻译成 resource 请求                   │  │
│  │  · 转发给 connector（HTTP loopback）                       │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │ HTTP POST 127.0.0.1:PORT/resource      │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │  ACP Connector（如 opencode）                              │  │
│  │  · 持有 bot token（agb_...），agent 不可见                  │  │
│  │  · 维护到 gateway 的 control + data WebSocket              │  │
│  │  · 把 resource 请求包装成 resource_req 帧发给 gateway       │  │
│  │  · 托管 loopback HTTP endpoint                             │  │
│  └──────────────────────┬────────────────────────────────────┘  │
└────────────────────────┼───────────────────────────────────────┘
                         │ WebSocket（data channel）
                         ▼
              Cheers Gateway（Rust）
              · 用 WS 连接的 bot identity 检查 membership
              · 用 session_id 检查 Grant
              · 返回结果或 NOT_MEMBER / PERMISSION_DENIED
```

### 为什么 MCP server 不直接连 WebSocket？

一个 bot 只能有一对 (control, data) WebSocket 连接，已被 connector 占用。MCP server 如果额外开连接，gateway 会以 close code `SUPERSEDED（4402）` 踢掉 connector 的连接。因此 MCP server 通过 HTTP loopback 借用 connector 已有的 WebSocket，而不是自己新建连接。

---

## 2. Connector 注入的 env vars

| 变量 | 含义 |
|---|---|
| `CHEERS_RESOURCE_URL` | connector 监听的 loopback HTTP 地址，MCP server 转发目标 |
| `CHEERS_CHANNEL_ID` | 当前 session 绑定的频道，工具调用的默认 `channel_id` |
| `CHEERS_BOT_ID` | bot UUID，仅用于日志诊断 |
| `CHEERS_REQUEST_TIMEOUT_MS` | 单次 resource round-trip 超时（默认 30s） |

`CHEERS_CHANNEL_ID` 是其中最重要的：agent 调用工具时可以不传 `channel_id`，MCP server 自动填入当前 session 绑定的频道。

---

## 3. 权限边界原则：connector 持有身份，gateway 执行策略

### 核心原则

**agent 只表达意图（what），connector 持有身份（who），gateway 执行策略（allowed?）。**

权限检查对 agent 完全透明。agent 调用工具，要么成功，要么收到 `NOT_MEMBER` / `PERMISSION_DENIED` 错误——它不需要知道 bot token 是什么，也不需要申请权限。

### 每层的职责

| 层 | 持有的内容 | 负责的事 |
|---|---|---|
| **Agent（LLM）** | 无凭证 | 表达意图：调哪个工具、传什么参数 |
| **Connector** | bot token（`agb_...`）、session_id | 维护 WS 连接；把 resource 请求绑定到正确的 bot identity |
| **Gateway** | bot 的成员关系、Grant 记录 | 检查 membership（读操作）；检查 Grant（写操作）；返回结果或错误 |

### 为什么这样划分？

**安全性**：agent 是 LLM，其 context window 可能被 prompt injection 攻击读取。如果 bot token 或 session key 出现在工具参数里，攻击者可以通过构造特殊输入来提取凭证。把 token 封在 connector 进程中，agent 即使被攻击也无法拿到任何凭证。

**声明式授权**：管理员在 Cheers 后台为 bot 配置 Grant（能写哪些频道、能做哪些操作），这是离线配置，不依赖 agent 的运行时行为。agent 调工具时不需要"申请"权限，gateway 自动根据 Grant 决策。

**零差异**：这套机制对内置 bot 和外置 ACP bot 完全一样，没有任何特权通道。

### 已实现的边界检查

| 检查点 | 触发条件 | 执行者 |
|---|---|---|
| Bot membership | 所有 resource 调用 | gateway（`check_bot_in_channel`） |
| Grant（写操作）| `channel.messages.create`、`channel.memory.update`、`fs.write` 等 | gateway（`permission::evaluate`） |
| Session 绑定 | 写操作传入 `session_id` | gateway |
| Bot token 有效性 | WS 连接建立时 | gateway（`resolve_bot_by_token`） |

---

## 4. 跨频道调用策略（待定）

当前 MCP 工具的 `channel_id` 参数是可选的：agent 可以显式传入一个不同的 `channel_id` 来访问其他频道的资源。Gateway 仍然检查 bot 是否是目标频道的成员，不会绕过权限。

但是否应该在 MCP 层面允许跨频道调用，有两种选择：

**允许跨频道**：bot 可以聚合多个频道的上下文，适合需要跨频道协作的 agent。  
**锁定单频道**：MCP server 完全忽略 agent 传入的 `channel_id`，所有调用都绑定到 connector 注入的频道。agent 没有越界的可能，行为更可预测。

当前实现为**允许跨频道**，具体策略留待后续决策。

---

## 5. MCP package 文件职责

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口：读 config，创建 transport / client / MCP server，注册工具，连接 stdio |
| `config.ts` | 从 env vars 解析 `ServerConfig`，`CHEERS_RESOURCE_URL` 必填 |
| `transport.ts` | HTTP loopback 通信层（`HttpLoopbackTransport`），把 `ResourceRequest` POST 给 connector |
| `client.ts` | 类型化 API 包装，每个方法对应一个 gateway resource，处理 `channel_id` 默认值 |
| `tools.ts` | MCP 工具注册，参数 schema（zod）+ description，LLM 可调用的最终接口 |
