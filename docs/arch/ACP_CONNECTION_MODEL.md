# AgentNexus ACP 连接模型（深挖）

> 版本：v0.2
> 分支：`break/rust-gateway-arch`
> 上层：[ACP_INTEGRATION.md](./ACP_INTEGRATION.md)（ACP 在架构中的定位）
> 配套：[AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md)（资源访问协议）
> 本文专注：bot ↔ Rust Backend 的**连接模型** —— 单连接多 session 复用、重连重放、并发控制、资源访问。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 连接粒度 | **每 bot 单连接**（control + data），新连接 supersede 旧 | 现状如此；session 是其下子维度 |
| session 复用 | 单条 data WS 上按 `channel_id`/scope 标签**多路复用** N 会话 | 会话隔离靠 PG 的 scope→session_key 绑定 |
| 连接管理 | **Rust Backend 统一管理**（单进程，无跨实例问题） | 合并 Gateway + REST，无 NATS |
| 重连重放 | event_log（PG，已有 seq + resume） | 已持久，重连即可重放 |
| HOL 阻塞 | **文件传输分独立 lane**（resource 分块） | 大文件不阻塞会话流式 |
| 并发控制 | **Backend 按 bot 限并发 + 排队** | 单连接吞吐有限，防一个重会话饿死其他 |
| 资源访问 | **`resource_req/res` 协议**（data channel） | bot 通过协议访问平台资源，不直连 DB |
| 可选 E2EE 协商 | **`binding_config.acp_security` 在 hello 携带**，默认 `enabled=false` | 控制面先行，当前不强制 payload 加密 |
| provider.config 协议 | `provider.config.get/update` 走 data channel | 统一接入 same socket；敏感变更建议 E2EE 与版本审计 |

---

## 1. 现状连接模型（不变）

### 两条 socket，职责分明

| socket | 职责 | 帧 |
|--------|------|----|
| `/ws/agent-bridge/control` | 生命周期、配置同步、健康 | `hello`(成员快照/connector_config)、ping、ready、config_* |
| `/ws/agent-bridge/data` | agent I/O + 文件 + 资源访问 | `hello`(last_event_seq)、send、reply、delta、done、file_upload、resume、**resource_req/res** |

- **鉴权**：bearer `botToken`（agb_）→ `resolve_bot_by_token` → 校验 `bot.status=="online"`。`resolve_bot_by_token` 同时解析 `binding_config.acp_security` 并在 `hello` 中回传给 connector。
- **单 bot 单活动连接**：新连接 supersede 旧连接（close code SUPERSEDED）。

### 可选 E2EE 能力下发

- Bot 创建时可携带 `acp_security`（`enabled`、`mode`、`algorithm`、`allow_plaintext_fallback`），网关会归一化后写入 `bot_accounts.binding_config.acp_security`。
- control/data `hello` 帧都可透出该字段，connector 以此决定是否尝试做端到端加密，当前实现只支持协商字段，不处理加密 payload。
- 连接安全约束建议：对 `provider.config.get/update`，除 `allow_plaintext_fallback=true` 且业务确认安全场景外，优先要求加密 envelope；
  由资源层落地 `E2EE_REQUIRED` 和 `DECRYPT_FAILED` 错误行为。
- 建议约定：
  - `mode`：`X25519-ECDH`（初始）
  - `algorithm`：`AES-256-GCM` 或 `ChaCha20-Poly1305`
  - `enabled=false` 时不进行加密；`allow_plaintext_fallback=true` 时可回退明文。

### session 多路复用（一个 bot 同时处理多会话）

```
路由层级：
  bot_id ──→ Rust Backend（唯一连接管理方）
    └─ scope (channel / DM / topic) ──→ provider_session_key   (PG: AgentNexusSessionBinding)
         └─ data WS 每帧带 channel_id ──→ demux 到对应会话
```

- `_primary_scope(trigger)` → `(scope_type, scope_id)`：DM→dm scope、topic→topic_id、否则→channel_id。
- `build_provider_session_key(provider_agent_id, provider_account_id, session_id)` → 稳定 key，本地 agent 据此隔离每会话上下文。
- 单条 data WS 是**多路复用隧道**；`channel_id` 是 demux 维度。**session 不是新的连接层，是 bot 之下的子维度。**

> **「session」二义辨析（两个不同概念，勿混）**：
> | 名称 | 是什么 | 用途 | 谁产生 id |
> |------|--------|------|----------|
> | `provider_session_key`（本文/`AgentNexusSessionBinding`） | 本地 ACP agent 的会话上下文句柄，scope→key 绑定 | **仅本地 agent 隔离上下文**；**不参与回流路由**（§7） | `build_provider_session_key(...)` 派生 |
> | `AgentNexusSession`（[BOT_PERMISSION](./BOT_PERMISSION.md)/[TASK_DELIVERY](./TASK_DELIVERY.md) 的 `session_id`） | 平台侧任务会话实体，带 `created_by` | 承载 `session` 级 **Grant** 与对象级权限 | 平台创建 |
> 二者**不是同一个 id**：前者是 demux/上下文维度，后者是权限/生命周期维度。task 帧里的 `session_id` 指**后者**（AgentNexusSession）。grant 的 `scope=session` 校验的也是后者。

---

## 2. 新架构下的连接拓扑

### 2.1 简化：无跨实例问题

旧架构（Rust Gateway + Python Worker + 独立 Agent Bridge 服务）存在"connector 连接黏性"问题：
connector 连到实例 A，但 task 可能被实例 B 的 worker 消费。

**新架构消除了这个问题**：

```
旧架构（3 个服务 + NATS）:
  Browser → Rust Gateway → NATS → Python Worker
                                        ↓ NATS request/reply
                                  Agent Bridge 服务 ← connector
                                  (需要 NATS KV 做存在性注册)

新架构（1 个 Rust Backend）:
  Browser → Rust Backend
               ↓ Agent Bridge WS (进程内)
          Agent Service ← connector
          (无跨实例，无 NATS)
```

Rust Backend 是**唯一**的 bot 连接管理方。task 派发、delta 转发、resource 处理都在同一个进程内完成。
**不需要 NATS KV 存在性注册、不需要一致性哈希、不需要跨实例 supersede。**

> ⚠️ **前提：单实例。** 上述「无跨实例问题」仅在 **Backend 跑单实例**时成立——这是本期的明确定调（见 [ARCHITECTURE_OVERVIEW §部署模型](./ARCHITECTURE_OVERVIEW.md)）。
> 一旦为 HA / 水平扩展跑 ≥2 实例，「连接黏性」会原样回来：bot 连在实例 A，用户消息落到实例 B，B 需把 task 派发到 A 上的 bot、A 的 delta 需 fan-out 到连在 B 的浏览器。
> 为不推倒重来，实现时把 `BotLocator`（找到 bot 连接）与 `Fanout`（广播）抽象为**可替换接口（trait）**：单实例=进程内实现；多实例=接 Redis/NATS（见 [WIRE_PROTOCOL §8.2](./WIRE_PROTOCOL.md)）。**本连接模型文档的协议语义在两种部署下都不变。**

### 2.2 连接管理方

| 角色 | 管理方 | 说明 |
|------|--------|------|
| 浏览器 WS 连接 | Rust Backend `realtime` 模块 | per-channel / per-user 连接池 |
| bot control WS | Rust Backend `agent_bridge` 模块 | per-bot 连接，supersede 旧连接 |
| bot data WS | Rust Backend `agent_bridge` 模块 | 多路复用隧道 |
| task 派发 | Rust Backend `agent_bridge::dispatcher` | 进程内直接派发，无需消息总线 |
| delta 转发 | Rust Backend `agent_bridge::stream` → `realtime::fanout` | 进程内直接转发 |
| resource 处理 | Rust Backend `agent_bridge::resource` | 调用 `domain` 模块 |

---

## 3. 资源访问（data channel 新增）

### 3.1 `resource_req/res` 帧

`resource_req` / `resource_res` 是 data channel 的新增帧类型，与现有帧正交：

```
Data Channel 帧类型:
  ├─ 任务链路: reply, send, delta, done, error, trace
  ├─ 文件操作: file_upload, file_upload_ack
  ├─ 会话管理: session_update, permission_request
  ├─ 连接管理: ping, pong, subscribe, resume
  └─ 资源访问: resource_req, resource_res, resource_chunk  ← 新增
```

Bot 可以在等待 `delta` 流式输出的同时，并行发 `resource_req` 查询其他 channel 的资源。

### 3.2 资源处理流程

```
Bot ──data WS──▶ Rust Backend: {type:"resource_req", req_id:"r1", resource:"channel.members", params:{...}}
  │
  ▼
agent_bridge::resource::dispatch(req)
  ├─ 权限检查: check_bot_in_channel(bot_id, channel_id)
  ├─ 调用 domain::channels::get_members(channel_id, params)
  └─ 返回
  │
  ▼
Rust Backend ──data WS──▶ Bot: {type:"resource_res", req_id:"r1", ok:true, data:{members:[...]}}
```

### 3.3 和现有 HTTP 文件端点的关系

| 方式 | 端点 | 适用场景 |
|------|------|---------|
| HTTP | `/agent-bridge/files/{id}/content` | 简单读取，已有 HTTP 客户端 |
| WS resource | `channel.files.read` | WS-only bot，保持单连接 |
| WS resource | `channel.files` | 批量查询文件列表（HTTP 无此端点） |
| WS resource | `channel.memory` | 读写记忆层（HTTP 无此端点） |
| WS resource | `provider.config.get` | 读取受控配置字段（白名单 + 脱敏） |
| WS resource | `provider.config.update` | 更新受控配置字段（加密 + 版本校验 + 审计） |

两者并行，bot 自行选择。resource 协议的额外优势：批量查询、分块传输、与任务链路共享连接。

---

## 4. 重连与重放（已有，简化后更可靠）

```
data hello → last_event_seq（来自 PG MAX(seq)）
bot 发 resume(last_seen_seq)
Backend events_since(bot_id,"data",last_seq) → 从 PG 重放遗漏事件
```

- 因 event_log 在 PG，重连即可重放。
- **多 session 一起恢复**：supersede/重连中断的是整条连接，N 个会话的流同时中断、同时靠重放对齐。
- **单进程优势**：旧架构需要跨实例重放（从 PG 读，发到另一个实例的 WS），新架构在同一进程内完成。

---

## 5. 并发控制（单连接多 session 的真问题）

### 5.1 HOL 阻塞 → 文件传输分独立 lane

- 小帧（delta / control / send / done / resource_req）走 data WS。
- 大文件通过 `resource_chunk` 分块传输：
  - `channel.files.read` 返回大文件时，Backend 分块发 `resource_chunk`。
  - `channel.files.create` 上传大文件时，Bot 分块发 `resource_chunk`。
- 避免一个会话的大文件阻塞其他会话的流式 token。

### 5.2 按 bot 限并发 + 排队

- Backend 对每个 bot 限制同时 in-flight 的会话数（`max_concurrent_sessions`，可配）。
- 超出则排队，FIFO 调度，防一个重会话饿死其他会话。
- resource 请求也纳入并发控制（防一个 bot 用大量 resource_req 占满连接）。

### 5.3 resource 请求的并发

- Bot 可以同时发出多个 `resource_req`，不需要等前一个返回。
- Backend 按完成顺序返回 `resource_res`（不保证与请求顺序一致）。
- 单个 `resource_req` 的处理是原子的：要么完整成功，要么返回错误。
- Backend 对单 bot 的 resource 请求频率做限流（见 [AGENT_BRIDGE_RESOURCE §6](./AGENT_BRIDGE_RESOURCE.md)）。

---

## 6. 连接生命周期状态机

```
bot 拨 control + data (botToken)
        │ resolve_bot_by_token + status==online
        ▼
   bind_control / bind_data
        │ 若有旧连接 → supersede（close SUPERSEDED）
        ▼
   control.hello（成员快照/config）
   data.hello（last_event_seq）
        │ bot 发 resume(last_seen_seq) → events_since 重放
        ▼
   ┌──────── ACTIVE ────────┐
   │ 多 session 复用:        │
   │  Backend → task 派发     │
   │   → 并发槽/队列 → send   │
   │   → 本地 agent → delta/done
   │   → record_event(seq) + fan-out → 浏览器
   │                         │
   │ 资源访问:                │
   │  bot → resource_req     │
   │   → domain 调用          │
   │   → resource_res        │
   │                         │
   │ 大文件 → resource_chunk  │
   └────────────────────────┘
        │ 断线 / supersede / bot offline
        ▼
   旧连接清理 → in-flight 会话留待重连重放
```

---

## 7. 回流关联：(bot+session) 的输出怎么回到正确频道

**关联键是 `msg_id`（占位消息 id），不是 channel_id、更不是 session_key。**

链路（`streams.py` 的 `StreamRegistry`：`msg_id → {bot_id, channel_id, task_id}`）：

```
1. Backend 收到用户消息 → 持久化 → 判断触发 bot
   → 在目标 channel 建【占位 Message】(msg_id, channel_id, sender=bot, is_partial=true)
   → stream_registry.register(msg_id, bot_id, channel_id)
   → 派发给 bot 时带 msg_id
2. bot 流式输出 → data WS delta{msg_id, seq, delta} / done{msg_id}
3. Backend 收到 delta → stream_registry.get(msg_id) → 取 channel_id → fan-out 到浏览器
```

- **`session_key` 不参与回流路由**：它只用于本地 agent 隔离上下文。回流完全靠 `msg_id`。
- **「哪个频道」的持久真相 = PG `Message.channel_id`**：registry 缺失时 `s.get(Message, msg_id)` 重建 stream。
- **单进程优势**：旧架构中占位由 Worker 创建、delta 回到 Bridge 实例（跨进程），需要额外关联。新架构在同一进程内，stream_registry 直接可用。

---

## 8. 回流的安全与正确性硬规则（实现必须遵守）

外部 ACP agent 的信任级别是 `untrusted` / `trusted`（trust_level 规范枚举 `system` > `trusted` > `standard` > `untrusted`，见 [BOT_PERMISSION §7](./BOT_PERMISSION.md)）。
connector 上报的任何字段（`msg_id` / `seq` / `channel_id`）都**不可盲信**。以下为强制规则：

| 规则 | 内容 | 防的问题 |
|------|------|---------|
| **R1 所有权校验** | 收到 `delta/done/trace{msg_id}` 时，必须校验该 msg_id 的占位 **owner == 当前 bot**（`Message.sender_id == bot_id`），且占位仍 active（`is_partial` 或空内容）。校验以 **PG 为准**。 | **跨频道注入**：被攻破/有 bug 的 connector 用别人的 msg_id 把内容打进别的频道 |
| **R2 seq 服务端盖戳** | client-facing `seq` 由 **Backend 盖戳**，**不透传** connector 自报的 seq。 | 外部 agent 乱报 seq → 击穿客户端去重/排序 |
| **R3 确定性占位 id** | 占位 id 由 `(trigger_msg_id, bot_id)` **确定性派生**；重跑时 **upsert 同一占位**，而非新建。 | **重复气泡**：重投导致重跑建出第二个占位 |
| **R4 finalize 守卫** | 占位 finalize 后（`is_partial=false` 且有内容）拒绝迟到 delta。 | 网络重排/重放产生的 finalize 后迟到 delta |

> R1/R2 的本质：**Backend 是该 bot 回流的权威**——所有权和 seq 都由 Backend 按服务端真相裁决，connector 只是内容来源。

---

## 9. delta / send 的有意非对称（保留，勿强求统一）

| 输出模式 | 关联键 | 语义 |
|---------|--------|------|
| `delta` / `done` | **msg_id**（流进预建占位） | 续写某个气泡；channel 由 R1 从占位裁决 |
| `send`（bot 主动发新消息） | **channel_id**（帧直接带，建全新 Message） | 新建消息；R1 退化为「校验 bot 是该 channel 成员」 |
| `resource_req: channel.messages.create` | **channel_id**（params 中带） | 走 resource 协议的新消息发送路径 |

三种模式用不同关联键是**有意的**：delta 必须打进特定气泡，send 和 resource 是新建。
**保留此非对称**，不强求统一。

---

## 10. 与既有契约的衔接

| 契约 | 关系 |
|------|------|
| [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) | 资源访问协议，bot 通过 data channel 访问平台资源 |
| [WIRE_PROTOCOL](./WIRE_PROTOCOL.md) | 浏览器 ↔ Rust Backend 的实时线协议（输出侧 fan-out） |
| [TASK_DELIVERY](./TASK_DELIVERY.md) | 任务投递（简化：Rust Backend 直接派发给 bot，无需 NATS WorkQueue） |
| [BOT_PERMISSION §7](./BOT_PERMISSION.md) | trust_level 规范枚举（影响 R1/R2 校验策略与资源写默认 grant） |
| [BOT_CONFIG_LAYERING](./BOT_CONFIG_LAYERING.md) | Bot 配置分级（effective_config 合并） |

---

## 11. 迁移要点

### Phase 1（Rust Backend + 新 Agent Service，同步启动）

> **Clean rebuild，无 Phase 0 渐进。** 旧 `bot_runtime/adapters/` 直接删除，新 Agent Service 从零写起，不经历"在旧 Python 单体内改走协议"的中间过渡。见 [BUILTIN_AGENT.md](./BUILTIN_AGENT.md)。

| 改动 | 说明 |
|------|------|
| agent_bridge 模块 | Rust 实现 control/data WS handler、bot 注册、task 派发 |
| resource 模块 | Rust 实现 resource_req 分发、权限检查、调用 domain |
| realtime 模块 | Rust 实现浏览器侧 WS fan-out |
| delta 转发 | stream → realtime fan-out（进程内直接转发） |

### Phase 2（Rust Backend 全量）

| 改动 | 说明 |
|------|------|
| botToken 验证 | 从 Python 移植到 Rust |
| event_log 重放 | Rust 实现 PG 查询 + WS 重放 |
| 并发控制 | 按 bot 限并发 + 排队 |
| resource 限流 | 按 bot 限 resource_req 频率 |
