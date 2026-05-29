# AgentNexus Agent 任务投递契约 (Task Delivery v2)

> 版本：v2
> 分支：`break/rust-gateway-arch`
> 适用范围：Rust Backend → Agent Bridge WS → Python Agent Service 的任务投递
> 配套：[AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md)（资源访问）· [BOT_PERMISSION](./BOT_PERMISSION.md)（权限）· [WIRE_PROTOCOL](./WIRE_PROTOCOL.md)（浏览器侧输出）

本契约定义「用户消息触发 Agent」这条链路在新架构下的投递语义。
**核心原则：Rust Backend 直接通过 Agent Bridge WS 派发任务，不需要消息总线。**

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 投递通道 | **Agent Bridge WS**（control channel） | bot 是 ACP Agent，通过标准协议接收任务 |
| Payload | **瘦指针**（bot 从 DB rehydrate） | 单一数据源、避免陈旧/巨大 payload |
| 幂等 | **PG 持久化 + 确定性占位 id** | 事务性最强；沿用现有模式 |
| 权限检查 | **ACP RBAC**：派发=`session`/`create` | 频道成员 bot 默认有此 channel 级 grant（[BOT_PERMISSION §5.1](./BOT_PERMISSION.md)） |
| 回流不另检查 | `delta`/`done` 续写占位由 R1–R4 裁决 | 不发 `channel:messages` grant；仅 `send`/新建消息才需（[BOT_PERMISSION §5.3](./BOT_PERMISSION.md)） |
| 重试 | Backend 管理重试（max 3） | 替代 JetStream 重投 |
| NATS | **不需要** | WS 直连，Backend 进程内派发 |

---

## 1. 旧架构（已被替换）

```
旧链路: REST → Redis Stream → Worker → NATS → Gateway → 浏览器
新链路: Backend → Agent Bridge WS → Agent Service → data WS delta/done → Backend → 浏览器
```

旧链路需要 NATS 的原因：Gateway、REST API、Worker 是三个独立进程。
新架构只有两个进程（Rust Backend + Agent Service），WS 就是通信通道。

---

## 2. Task Payload

通过 Agent Bridge control channel 派发：

```jsonc
// Backend → Bot: control WS task 帧
{
  "type": "task",
  "task_id": "<uuid>",              // 每次派发唯一
  "channel_id": "<uuid>",           // 目标频道
  "msg_id": "<uuid>",               // 触发消息（幂等键）
  "trigger": "user_message",        // 判别式
  "session_id": "<uuid>",           // AgentNexusSession id
  "enqueued_at": "<RFC3339>"
}
```

- **不带上下文**：消息内容、频道配置、bot 列表、历史，全部由 Agent Service 按 `msg_id`/`channel_id` 通过 resource 协议从 DB rehydrate。
- **权限已校验**：Backend 在派发前已完成 ACP 权限检查（bot 是否有权在该频道执行）。

---

## 3. 派发流程

### 3.1 完整链路

```
1. 用户 POST /channels/{id}/messages
   │
   ▼
2. Rust Backend:
   ├─ domain::messages::create_message() → 持久化
   ├─ realtime::fanout::broadcast(channel_id, message_created)
   ├─ domain::messages::resolve_bot_trigger() → 需要触发 bot?
   │   └─ yes → 继续
   │
   ├─ agent_bridge::permission::evaluate(bot_id, "session", "create", channel_id)
   │   （派发=在该频道开一个任务 session；这是频道成员 bot 默认就有的 channel 级 grant）
   │   └─ deny → 发 bot_pipeline_error 帧
   │   └─ requires_approval → 走审批流
   │   └─ allow → 继续
   │
   ├─ agent_bridge::dispatcher::dispatch(task)
   │   ├─ 创建占位 Message (sender=bot, is_partial=true)
   │   ├─ stream_registry.register(msg_id, bot_id, channel_id)
   │   └─ control WS 发 task 帧给 bot
   │
   └─ realtime::fanout::broadcast(user_ids, unread_notification)

3. Python Agent Service 收到 task:
   ├─ resource_req: channel.context (查频道上下文)
   ├─ 调 LLM API (流式)
   ├─ data WS: delta(msg_id, seq, content) × N
   │   └─ Backend → stream → realtime fanout → 浏览器
   ├─ resource_req: channel.memory.update (写记忆，可能触发审批)
   └─ data WS: done(msg_id, content)
       └─ Backend → DB 更新 → realtime fanout → 浏览器
```

### 3.2 占位 Message

```sql
-- 占位消息（bot 回复前先创建）
INSERT INTO messages (id, channel_id, sender_type, sender_id, content, is_partial)
VALUES (msg_id, channel_id, 'bot', bot_id, '', true);
```

- 占位 id 由 `(trigger_msg_id, bot_id)` **确定性派生**（[ACP_CONNECTION_MODEL §8 R3](./ACP_CONNECTION_MODEL.md)）。
- 重跑时 upsert 同一占位，不新建。

---

## 4. 幂等

### 4.1 现状

旧架构用 `bot_task_claims` 表 + NATS JetStream ack 保证幂等。
新架构不需要 claim 表 — Backend 是单一派发方，通过占位 Message 保证幂等。

### 4.2 新的幂等机制

```
派发前:
  ┌─ 检查是否已有该 (trigger_msg_id, bot_id) 的占位 Message
  │
  ├─ 不存在 → 创建占位 → 派发 task
  │
  └─ 已存在:
       ├─ is_partial=true → bot 正在处理，跳过
       └─ is_partial=false → 已完成，跳过
```

**不需要 claim 表**。占位 Message 本身就是幂等键，且已经是现有数据模型的一部分。

### 4.3 处理重投

如果 Backend 在派发 task 后、bot 回复前崩溃：
- 占位 Message 保持 `is_partial=true`
- 超时后 Backend 检测到陈旧占位（类似现有 `task_timeout.py` 的逻辑）
- 可选：重新派发或标记为失败

> **§4.2 跳过 与 §7.2 超时的闭环**（避免占位永久卡死）：占位带 `dispatched_at` / `lease_until`。`is_partial=true` 的占位**只在 lease 未过期时**才判定为「bot 正在处理，跳过」；**lease 过期**（默认 = §7.2 的 ack_wait 120s）后，同一 `(trigger_msg_id, bot_id)` 的重投**允许重新派发**（续租 + 重发 task），不再无脑跳过。这样 bot 中途死亡不会让占位停在 `is_partial=true` 永远被跳过。重投次数仍受 §7.1 的 max 3 约束。

---

## 5. Agent Service 执行

收到 task 后，等价于现有 `run_bot_pipeline_job(channel_id, msg_id)`：

1. 通过 resource_req 查 `channel.context`（消息、成员、记忆）
2. `run_bot_pipeline` 内部：选 adapter、建历史/上下文、调 LLM
3. 流式输出通过 data WS delta 帧回传
4. 完成后通过 data WS done 帧回传
5. 可选：通过 resource_req 写入频道记忆

**和旧 Worker 的区别**：
- 旧 Worker 直连 DB → 新 Agent Service 通过 resource 协议访问
- 旧 Worker 直接广播 WS → 新 Agent Service 通过 data WS 回传，Backend 负责 fan-out
- 旧 Worker 和 REST API 同代码库 → 新 Agent Service 独立部署

---

## 6. Trigger 判别式（可扩展）

| `trigger` | 含义 | rehydrate 依据 |
|-----------|------|---------------|
| `user_message` | 用户发消息 | `msg_id` |
| `scheduled`（预留） | 定时任务触发 | payload 附加 schedule_ref |
| `agent_bridge_resume`（预留） | 外部 Agent 恢复 | payload 附加 session_ref |
| `retry`（预留） | 显式重试 | `msg_id` |

---

## 7. 重试与错误处理

### 7.1 正常重试

```
bot 执行失败 → data WS error 帧
  │
  ▼ Backend 收到
  ├─ attempts < 3 → 重新派发 task（同 task_id, 同 msg_id）
  └─ attempts >= 3 → 标记失败，发 bot_pipeline_error 帧给频道
```

### 7.2 超时

```
task 派发后，bot 未在 ack_wait (120s) 内回复
  │
  ▼ Backend 检测超时
  ├─ 标记占位为 background_task（用户可见的任务卡）
  └─ bot 后续仍可回复（finalize 占位）
```

### 7.3 bot 离线

```
task 派发时 bot 未连接
  │
  ▼ Backend 检查 registry
  └─ bot 不在线 → 发 bot_pipeline_error 帧，不入队
```

**不需要 DLQ**。旧架构需要 DLQ 是因为 NATS JetStream 重投耗尽后需要死信。
新架构中 Backend 直接管理重试，失败后直接通知频道，不需要中间存储。

---

## 8. 和 WIRE_PROTOCOL 的衔接

```
用户 POST → Backend (REST) → 持久化 → fan-out(浏览器)
                                    → dispatch(task) via control WS
                                         ▼
                                    Agent Service
                                    → resource_req 查上下文
                                    → 调 LLM
                                    → delta via data WS → Backend → fan-out → 浏览器
                                    → done via data WS → Backend → DB 更新 → fan-out → 浏览器
```

浏览器侧的线协议完全不变。delta 带 seq、客户端去重排序、message_done 全量覆盖 — 这些都是 WIRE_PROTOCOL 已定稿的规范。

---

## 9. 和旧架构的对比

| 维度 | 旧 (NATS) | 新 (Agent Bridge WS) |
|------|----------|---------------------|
| 消息总线 | NATS JetStream | 不需要 |
| 投递通道 | NATS subject | control WS task 帧 |
| 幂等 | PG claim 表 | 占位 Message |
| 重试 | JetStream max_deliver + DLQ | Backend 直接管理 |
| 回传通道 | NATS rt.* → Gateway | data WS delta/done → Backend |
| 进程数 | 3 (Gateway + REST + Worker) | 2 (Backend + Agent Service) |
| 部署复杂度 | 高 (NATS + 3 服务) | 低 (2 服务) |

---

## 10. 迁移路径

| Phase | 动作 |
|-------|------|
| **0** | 内置 bot 改走 Agent Bridge 协议（Python 内部，不涉及 Rust） |
| **1** | Rust Backend 实现 agent_bridge::dispatcher（task 派发 + 占位管理） |
| **2** | Agent Service 接管所有内置 bot 执行 |
| **3** | 下线旧的 Redis Stream 队列 + bot_task_claims 表 |

---

## 附录：与相关文档的衔接

| 文档 | 关系 |
|------|------|
| [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) | Agent Service 通过 resource 协议访问平台资源（替代直连 DB） |
| [BOT_PERMISSION](./BOT_PERMISSION.md) | 派发前的权限检查（ACP RBAC） |
| [ACP_CONNECTION_MODEL](./ACP_CONNECTION_MODEL.md) | 连接模型（单连接多 session、重连重放、回流关联） |
| [WIRE_PROTOCOL](./WIRE_PROTOCOL.md) | 浏览器侧输出线协议（delta seq、message_done） |
