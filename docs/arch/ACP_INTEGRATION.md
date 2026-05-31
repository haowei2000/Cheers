# AgentNexus ACP 接入设计（外部 Agent / Agent Bridge）

> 版本：v0.2
> 分支：`break/rust-gateway-arch`
> 配套：[ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) · [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) · [WIRE_PROTOCOL](./WIRE_PROTOCOL.md)

本文确定 **ACP 协议 / ACP connector**（外部 Agent，如 OpenCode 等本地 stdio agent）
以及**内置 Agent Service** 在 Rust Backend 架构下的位置。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| Rust Backend 职责 | **全量**：REST API + WS Gateway + Agent Bridge 协议 | 单一 Rust 进程，内部模块边界分明 |
| 内置 Agent 定位 | **独立 Python 服务，走 Agent Bridge 协议** | 和外置 ACP bot 零区别，零特权 |
| 资源访问 | **统一 `resource_req/res` 协议**（data channel） | bot 通过协议访问平台资源，不直连 DB |
| connector 鉴权 | **botToken（agb_）在 Rust Backend 验** | 统一鉴权入口 |
| 客户端线协议 | **不变** | Bot 输出经 Rust Backend realtime fan-out → 浏览器 |
| NATS | **不需要** | Rust Backend 单进程处理所有 WS/REST，无需消息总线 |

---

## 1. 现状（不变）

### 形态
ACP connector 跑在**开发者机器/私有环境**，拉起本地 ACP stdio agent（OpenCode、Claude 兼容），
**反向连接**到 AgentNexus 服务端，把用户消息/附件转发给本地 agent，再把回复+生成文件流式回传。

### 连接
三条服务端 WS 端点（`app/api/v1/agent_bridge/routes.py`）：

| 端点 | 用途 |
|------|------|
| `/ws/agent-bridge/control` | connector 生命周期、会话握手、心跳 |
| `/ws/agent-bridge/data` | 消息/文件分块/流式输出/资源访问 |
| `/ws/agent-bridge/dispatch` | 派发/调试流（legacy） |

### 关键内部结构
- **`BridgeDispatcher`**（`dispatcher.py`）：进程内 pub/sub。connector 按 `bot_id` 订阅。
- **`session_map.py`**：复用 provider session key，保持 ACP 会话上下文（有状态）。
- **`service.py`**：dispatch/event_log/pending/file 处理。
- **鉴权**：`botToken`（agb_xxx）→ `bot_accounts.bot_token_hash`（哈希存储）。

---

## 2. 目标架构

```
Browser / Mobile
  │ WS + REST（同一端口）
  ▼
┌──────────────────────────────────────────────────────────┐
│                    Rust Backend                           │
│                                                           │
│  ┌─ transport ──────────────────────────────────────────┐ │
│  │  /api/v1/*  → REST handlers                           │ │
│  │  /ws/*      → WS handlers                             │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ domain ─────────────────────────────────────────────┐ │
│  │  channels / messages / bots / files / memory / ...    │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ realtime ───────────────────────────────────────────┐ │
│  │  WS 连接管理 + fan-out（浏览器侧）                      │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ agent_bridge ───────────────────────────────────────┐ │
│  │  bot 注册 / 任务派发 / delta 转发                       │ │
│  │  resource API（bot 通过协议访问平台资源）                  │ │
│  └──────────────────────────────────────────────────────┘ │
└──────┬──────────────────────────────┬────────────────────┘
       │ Agent Bridge WS              │ Agent Bridge WS
       │ (control + data)             │ (control + data)
       ▼                              ▼
┌──────────────────┐    ┌──────────────────────────┐
│  外置 ACP Bot     │    │  内置 Agent Service       │
│  (第三方 connector)│    │  (Python)                 │
│                   │    │  · 一份通用 ACP runtime    │
│  同一套协议        │    │    (无 bot 类/无 per-bot 分支)│
│  同一套契约        │    │  · 身份=数据 (seed)        │
│  零特权           │    │  · 行为=Environment 模板   │
└──────────────────┘    │  · Memory / RAG           │
                         │  同一套协议，零特权          │
                         │  (详见 BUILTIN_AGENT.md)   │
                         └──────────────────────────┘
```

**关键变化**：
- 没有独立的 Agent Bridge 服务 — **Rust Backend 直接管理所有 bot 连接**
- 没有 Python Worker — **Agent Service 替代**，走 Agent Bridge 协议
- 没有 NATS — **WS 直连**，Rust Backend 进程内 fan-out

---

## 3. 内置 Agent = 普通 ACP Bot

这是架构的核心决策：**内置 bot 和外置 bot 走完全一样的协议，零特权**。

### 3.1 对比

| 维度 | 旧架构（内置 bot） | 新架构（内置 Agent Service） |
|------|-------------------|---------------------------|
| 接入方式 | 进程内直接调用 | Agent Bridge WS（control + data） |
| 数据库访问 | 直连 PostgreSQL | **通过 `resource_req` 协议访问** |
| 任务触发 | `asyncio.create_task(run_bot)` | Rust Backend 通过 control WS 派发 |
| 流式输出 | EventBus → WS 直接广播 | data WS `delta` → Rust Backend fan-out |
| 文件访问 | 直接读写 S3 | **通过 `channel.files` resource 协议** |
| 记忆访问 | 直接读写 DB | **通过 `channel.memory` resource 协议** |
| 部署 | 和 REST API 同进程 | 独立容器 |
| 扩容 | 和 REST API 绑定 | 独立扩容 |

### 3.2 Agent Service 内部结构

> 见 [BUILTIN_AGENT.md](./BUILTIN_AGENT.md)：**没有 `adapters/`，没有 per-bot 类**。
> 一份通用 runtime 服务所有内置身份;身份由数据 seed,行为由 Environment 模板决定。
> 旧的 `coordinator/helper/help_bot` 已删除(Coordinator 被网格的 `@mention` 路由替代)。

```python
agent_service/
├── main.py                     ← 入口: 为每个 seed 的身份各开一条 Agent Bridge 连接
├── runtime.py                  ← 唯一的通用 agent loop（task → 拉上下文 → LLM → delta/done，无 per-bot 分支）
├── resources.py                ← ResourceClient: 通过 resource_req 访问平台资源
├── identities.py               ← 从数据加载身份（bot_account: token / trust=system），非代码
├── memory/                     ← 记忆访问 (通过 resource API / fs.* 读写)
├── tools/                      ← 确定性动作 / 工具调用 (web search, fetch；非 bot)
└── config.py                   ← backend_ws_url 等
```

### 3.3 Agent Service 的任务执行流程

```
用户发消息 → Rust Backend 持久化 → 判断需要触发 bot
  │
  ▼
Rust Backend 通过 control WS 派发任务给 Agent Service:
  { type: "task", task_id, channel_id, msg_id, ... }
  │
  ▼
Agent Service 收到任务:
  ├─ resource_req: channel.context  (查频道上下文)
  │   └─ resource_res: {info, members, recent_messages, memory}
  │
  ├─ resource_req: channel.files    (查频道文件)
  │   └─ resource_res: {files: [...]}
  │
  ├─ 调 LLM API (流式)
  │   ├─ data WS: delta(msg_id, seq:0, "...")
  │   │   └─ Rust Backend → realtime fan-out → 浏览器
  │   ├─ data WS: delta(msg_id, seq:1, "...")
  │   └─ ...
  │
  ├─ resource_req: channel.memory.update (写入记忆)
  │   └─ resource_res: {entries: [...]}
  │
  └─ data WS: done(msg_id, content="完整内容")
      └─ Rust Backend → DB 更新 → realtime fan-out → 浏览器
```

---

## 4. 外置 ACP Bot 的处理

外置 ACP bot 和内置 Agent Service **共享同一个 Agent Bridge 入口**：

```
/ws/agent-bridge/control   ← 所有 bot 都连这里
/ws/agent-bridge/data      ← 所有 bot 都连这里
```

Rust Backend 的 `agent_bridge::registry` 按 `bot_id` 区分，协议完全一样。

### 4.1 外置 bot 现有能力（保持不变）

| 能力 | 帧类型 | 说明 |
|------|--------|------|
| 接收任务 | control WS `task` | 触发执行 |
| 流式回复 | data WS `delta` + `done` | 流式输出 |
| 直接发消息 | data WS `send` | 主动创建消息 |
| 上传文件 | data WS `file_upload` | 文件上传 |
| 权限请求 | data WS `permission_request` | 交互式权限卡 |
| 断线重放 | data WS `resume` | 遗漏事件重放 |

### 4.2 外置 bot 新增能力（resource 协议）

通过 [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md)，外置 bot 也能：

| 能力 | resource | 说明 |
|------|----------|------|
| 查询频道成员 | `channel.members` | 知道谁在频道里 |
| 查询历史消息 | `channel.messages` | 读取上下文 |
| 查询/上传文件 | `channel.files` / `channel.files.create` | 统一文件操作 |
| 读写记忆 | `channel.memory` / `channel.memory.update` | 访问频道记忆层 |
| 聚合上下文 | `channel.context` | 一次取多维信息 |

**这是统一契约的自然红利** — 内置 bot 能做的事，外置 bot 也能做（受权限约束）。

---

## 5. 鉴权

| 连接 | 鉴权 | 由谁 |
|------|------|------|
| bot → Rust Backend（control/data WS） | `botToken`（agb_）比对 `bot_token_hash` | **Rust Backend**（统一鉴权入口） |
| 浏览器 → Rust Backend（WS） | 首帧 auth + RS256 | **Rust Backend** |
| 浏览器 → Rust Backend（REST） | Bearer JWT RS256 | **Rust Backend** |

所有鉴权集中在 Rust Backend。botToken 验证逻辑从 Python 移植到 Rust。

---

## 6. 文件流（inbound / outbound）

### 现有路径（保持不变）
- **inbound**（用户附件 → bot）：经 data WS `file_upload` 帧传递。
- **outbound**（bot 生成文件 → 平台）：data WS `file_upload` 或 resource `channel.files.create`。

### 新增路径（resource 协议）
- **批量查询**：`channel.files` — 列出频道所有文件。
- **读取内容**：`channel.files.read` — 读取文件文本/二进制内容。
- **分块传输**：大文件通过 `resource_chunk` 帧分块传输，不阻塞其他会话。

---

## 7. 迁移与模块归属

| 现有模块 | 去向 | 改动 |
|---------|------|------|
| `app/features/agent_bridge/*` | **移植到 Rust Backend** (`agent_bridge/` 模块) | Rust 重写，协议不变 |
| `app/api/v1/agent_bridge/routes.py` | **移植到 Rust Backend** (`transport/ws/agent_bridge.rs`) | Rust 重写 |
| `app/features/bot_runtime/adapters/` | **删除,不搬** | 改写为一份通用 runtime;Coordinator→网格路由;确定性逻辑→tool。见 [BUILTIN_AGENT](./BUILTIN_AGENT.md) |
| `app/features/bot_runtime/pipeline/` | **删除,不搬** | per-adapter 脚手架废弃;通用 runtime 重写,sink 为 data WS 帧 |
| `app/features/memory/` | **搬到 Agent Service** | 改用 resource_req / `fs.*` 读写记忆 |
| `app/features/agent_bridge/registry.py` | **移植到 Rust** (`agent_bridge/registry.rs`) | 内存结构用 Rust |

### 阶段（接 REFACTOR_PLAN）

| Phase | 动作 |
|-------|------|
| **0** | 协议定稿（resource_req/res）；Python 侧内置 bot 改走 Agent Bridge 协议（在现有 Python 单体内做） |
| **1** | Rust Backend PoC：实现 auth + WS + agent_bridge（含 resource API）；Agent Service 独立部署 |
| **2** | Rust Backend 全量：迁移剩余 REST 端点；旧 Python REST API 下线 |
| **3** | 优化：Agent Service 独立扩容；resource API 限流/审计 |

**Phase 0 的关键**：不需要 Rust。在现有 Python 单体内，把内置 bot 从"进程内直接调用"改成"走 Agent Bridge WS 协议"。这一步验证了协议的完整性，也为后续 Rust 重写铺路。

---

## 8. 为什么是这个架构

| 决策 | 理由 |
|------|------|
| **Rust Backend 全量**（Gateway + REST 合一） | 消除 NATS 依赖；单一进程管理所有连接和数据；内部模块边界分明 |
| **内置 Agent 走 Agent Bridge 协议** | 内置/外置零区别；Agent Service 可独立部署/扩容/替换 |
| **bot 通过 resource 协议访问资源** | 不直连 DB；权限集中管控；可审计；外置 bot 也能用 |
| **不把 Agent 逻辑放 Rust** | LLM 生态（Python）+ 快速迭代 + 人才成本 |

---

## 9. 与既有文档的衔接

| 文档 | 关系 |
|------|------|
| [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) | 总览，本文件的上层 |
| [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) | 资源访问协议，bot 访问平台资源的契约 |
| [WIRE_PROTOCOL](./WIRE_PROTOCOL.md) | 浏览器 ↔ Rust Backend 的实时线协议（输出侧） |
| [TASK_DELIVERY](./TASK_DELIVERY.md) | 任务投递契约（简化：Rust Backend 直接派发，无需 NATS） |
| [ACP_CONNECTION_MODEL](./ACP_CONNECTION_MODEL.md) | 连接模型深挖（单连接多 session、重连重放） |
