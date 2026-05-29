# AgentNexus ACP 接入设计（外部 Agent / Agent Bridge）

> 版本：v0.1 设计草稿
> 分支：`break/rust-gateway-arch`
> 配套：[ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) · [TASK_DELIVERY](./TASK_DELIVERY.md) · [WIRE_PROTOCOL](./WIRE_PROTOCOL.md)

本文确定 **ACP 协议 / ACP connector**（外部 Agent，如 OpenCode 等本地 stdio agent）
在 Rust Gateway + Python Worker 新架构下的位置。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| ACP 反向 WS 终结点 | **独立 Agent Bridge 服务（Python）** | 有状态、连接亲和，scaling 轴 = connector 数，独立于 LLM 吞吐 |
| 是否进 Rust Gateway | **否** | ACP 是快变 Agent 执行层（JSON-RPC/会话/文件分块），非哑数据平面 |
| Worker→Bridge 通信 | **NATS request/reply**，按 `bot_id` 路由到持有 connector 的实例 | 解决多副本下的连接黏性 |
| connector 鉴权 | **botToken（agb_）在 Bridge 验**，维持现状 | Rust Gateway 不参与 agent-bridge 连接 |
| 客户端侧线协议 | **不变** | ACP 输出经同一 EventBus → NATS → Gateway → 浏览器 |

---

## 1. 现状

### 形态
ACP connector 跑在**开发者机器/私有环境**，拉起本地 ACP stdio agent（OpenCode、Claude 兼容），
**反向连接**到 AgentNexus 服务端，把用户消息/附件转发给本地 agent，再把回复+生成文件流式回传。

### 连接
三条服务端 WS 端点（`app/api/v1/agent_bridge/routes.py`）：

| 端点 | 用途 |
|------|------|
| `/ws/agent-bridge/control` | connector 生命周期、会话握手、心跳 |
| `/ws/agent-bridge/data` | 消息/文件分块/流式输出 |
| `/ws/agent-bridge/dispatch` | 派发/调试流 |

### 关键内部结构
- **`BridgeDispatcher`**（`dispatcher.py`）：**进程内** pub/sub。connector 按 `bot_id` 订阅，事件经 `asyncio.Queue` 派发。对应客户端侧的 `ws_manager`，但面向 connector。
- **`session_map.py`（968 行）**：复用 provider session key，保持 ACP 会话上下文（**有状态**，最大的文件）。
- **`service.py`（632 行）**：dispatch/event_log/pending/file 处理。
- **鉴权**：`botToken`（agb_xxx）→ `bot_accounts.bot_token_hash`（哈希存储）。
- **内部触发侧**：`adapters/agent_bridge_bot.py`——pipeline 选中 agent_bridge 类型 bot 时，向 BridgeDispatcher 投递，connector 的 WS handler 取走 → 本地 agent → data WS 流式回传 → reply handler 落定消息。

### 单进程隐含假设
`BridgeDispatcher` 是进程内队列。单进程天然 work；**多副本后**：connector 反向连到某一个进程，而 task 可能被另一 worker 消费 → 出现「**connector 连接黏性**」问题。

---

## 2. 定位：ACP = 另一种 task executor，留在 Python

内部 bot 与外部 ACP bot 是镜像关系：

| | 内部 bot | 外部 ACP bot |
|--|---------|-------------|
| 执行 | worker 内调 LLM adapter | 路由到持有 connector 的 Bridge → 本地 agent |
| 状态 | 无（每次 rehydrate） | 有（ACP session 复用） |
| 输出 | EventBus → NATS | 同上（经 Bridge 转回 worker 的 EventBus） |

> **ACP 反向 WS 不进 Rust Gateway**：Gateway 只做浏览器侧哑 fan-out（[WIRE_PROTOCOL](./WIRE_PROTOCOL.md)）。
> ACP 的 JSON-RPC / 会话映射 / 文件分块是 ~2500 行快变 Python 逻辑，属于我们明确要留在 Python 的 Agent 层。
> 在 Rust 重写它 = 违背「Agent 层留 Python」原则。

---

## 3. 目标拓扑

```
                         Browser
                            │ WS (浏览器侧)
                            ▼
                   ┌─────────────────┐
                   │  Rust Gateway    │  (与 ACP 无关)
                   └────────┬─────────┘
                            │ NATS rt.* (输出回浏览器)
        ┌───────────────────┼───────────────────────┐
        ▼                   ▼                         │
┌──────────────┐   ┌──────────────────┐              │
│ Python REST  │   │ Python Agent      │              │
│ API          │   │ Workers (无状态)   │              │
│ 触发 task     │   │ run pipeline 选 bot│              │
└──────┬───────┘   │  ├ 内部 bot:调 LLM │              │
       │ NATS task │  └ ACP bot:NATS    │              │
       └──────────▶│     request/reply  │              │
                   └─────────┬──────────┘              │
                             │ agentnexus.acp.dispatch.{bot_id}
                             ▼                          │
                   ┌──────────────────────┐            │
                   │ Agent Bridge 服务      │────────────┘
                   │ (Python, 有状态)        │  输出 → NATS rt.*
                   │  · BridgeDispatcher    │
                   │  · session_map         │
                   │  · botToken 验证        │
                   │  · control/data/dispatch WS
                   └──────────┬─────────────┘
                              ↕ 反向 WS (control/data)
                   ┌──────────────────────┐
                   │  ACP Connector (开发机) │
                   └──────────┬─────────────┘
                              ↕ stdio
                   ┌──────────────────────┐
                   │  本地 ACP agent        │
                   └──────────────────────┘
```

---

## 4. connector 连接黏性解决方案

**问题**：bot 类型在 task publish 时未知（REST 触发时还没选 bot，`run_bot_pipeline` 内部才选）。
所以路由必然是「worker 跑 pipeline → 选中 bot → 若 agent_bridge 类型 → 找到持有该 connector 的 Bridge 实例」。

**方案**：

1. **连接注册**：Agent Bridge 实例在 connector 接入时，往 **NATS KV**（或 Redis）注册
   `bot_id → bridge_instance_id`，断开时注销。
2. **定向派发**：worker 选中 ACP bot 后，按 `bot_id` 查注册表，向持有实例的专属 subject
   发 NATS **request/reply**：
   ```
   agentnexus.acp.dispatch.{bot_id}      # 持有该 connector 的 Bridge 实例独占订阅
   ```
3. **流式回传**：Bridge 收到本地 agent 的流式输出，按 [WIRE_PROTOCOL §8](./WIRE_PROTOCOL.md) publish 到
   `rt.stream.{channel_id}.{msg_id}` / `rt.channel.{channel_id}`——与内部 bot 输出**走同一条路**，
   客户端线协议零差异。
4. **connector 不在线**：注册表查不到 → worker 发 `bot_pipeline_error` 帧（现有行为），
   或按策略落 DLQ（[TASK_DELIVERY §7](./TASK_DELIVERY.md)）。

> Agent Bridge 多副本时，每个 connector 仍只连一个实例；注册表保证 dispatch 精确到达。
> 这与客户端侧「Gateway 动态订阅」是镜像设计。

---

## 5. 鉴权

| 连接 | 鉴权 | 由谁 |
|------|------|------|
| connector → Bridge（control/data） | `botToken`（agb_）比对 `bot_token_hash` | **Agent Bridge 服务**（维持现状） |
| worker ↔ Bridge（NATS dispatch） | RS256 service token（[WIRE §6.1](./WIRE_PROTOCOL.md)） | 双方校验 `aud` |
| 浏览器 → Gateway | 首帧 auth + RS256（与 ACP 无关） | Rust Gateway |

Rust Gateway **完全不参与** agent-bridge 连接，botToken 验证逻辑不动。

---

## 6. 文件流（inbound / outbound）

- **inbound**（用户附件 → 本地 agent）：经 data WS 传递（现有路径保留）。
- **outbound**（agent 生成文件 → AgentNexus）：connector 上传 → Python file service → S3（现有路径）。
- 文件是数据平面到对象存储，**与 Rust Gateway 无关**，留在 Python。

---

## 7. 迁移与模块归属

| 现有模块 | 去向 |
|---------|------|
| `app/features/agent_bridge/*`（~2500 行） | **整体搬迁到 Agent Bridge 服务**，逻辑基本不改 |
| `app/api/v1/agent_bridge/routes.py`（3 个 WS 端点） | Agent Bridge 服务 |
| `adapters/agent_bridge_bot.py` | 改为「NATS request/reply 到 Bridge」替代进程内 BridgeDispatcher 调用 |
| `BridgeDispatcher`（进程内队列） | 保留在 Bridge 服务内（单实例内仍是进程内派发）；跨实例靠 §4 注册表 |

**阶段**（接 [REFACTOR_PLAN](./REFACTOR_PLAN.md)）：
- **Phase 2**：剥离 Agent Worker 时，同步把 agent_bridge 抽成独立 Agent Bridge 服务；
  `agent_bridge_bot` adapter 改 NATS 调用；建 connector 注册表（NATS KV）。
- **Phase 3**：旧的进程内直连 BridgeDispatcher 调用路径下线。

> SSE 退场（[WIRE §0](./WIRE_PROTOCOL.md)）对 ACP 的影响：agent_bridge 现有的**每请求 SSE** 输出，
> 切换为经 EventBus → NATS rt.* → Gateway 的 WS 流式（与内部 bot 统一）。

---

## 8. 为什么不是 Rust / 为什么独立服务

| 备选 | 否决理由 |
|------|---------|
| ACP WS 进 Rust Gateway | session_map/JSON-RPC/文件分块是快变 Python Agent 逻辑，Rust 重写违背分层原则 |
| ACP 折进 Agent Worker | 把有状态连接亲和与无状态 LLM 吞吐耦合，两者 scaling 轴冲突 |
| **独立 Agent Bridge 服务**（采纳） | scaling 轴 = connector 数；~2500 行整体搬迁、改动小；与无状态 worker 清晰隔离 |
