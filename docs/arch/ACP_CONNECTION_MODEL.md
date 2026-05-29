# AgentNexus ACP 连接模型（深挖）

> 版本：v0.1 设计草稿
> 分支：`break/rust-gateway-arch`
> 上层：[ACP_INTEGRATION.md](./ACP_INTEGRATION.md)（ACP 在架构中的定位）
> 本文专注：connector ↔ Agent Bridge 的**连接模型** —— 单连接多 session 复用、
> 多实例化、重连重放、并发控制。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 连接粒度 | **每 bot 单连接**（control + data），新连接 supersede 旧 | 现状如此；session 是其下子维度 |
| session 复用 | 单条 data WS 上按 `channel_id`/scope 标签**多路复用** N 会话 | 会话隔离靠 PG 的 scope→session_key 绑定 |
| 实例亲和 | **按 `bot_id` 一致性哈希** | 一个 bot 全部 session 共置同一实例 |
| 存在性注册 | **NATS KV** `acp.presence.{bot_id}` | 多实例下唯一缺的状态；workers 路由 + 跨实例 supersede |
| 重连重放 | event_log（PG，已有 seq + resume） | 已持久，任意实例可服务 |
| HOL 阻塞 | **文件传输分独立 lane** | 大文件不阻塞会话流式 |
| 并发控制 | **服务端按 bot 限并发 + 排队** | 单连接吞吐有限，防一个重会话饿死其他 |

---

## 1. 现状连接模型

### 两条 socket，职责分明

| socket | 职责 | 帧 |
|--------|------|----|
| `/ws/agent-bridge/control` | 生命周期、配置同步、健康 | `hello`(成员快照/connector_config)、ping、ready、config_* |
| `/ws/agent-bridge/data` | 真正的 agent I/O + 文件 | `hello`(last_event_seq)、send、reply、delta、done、file_upload、resume |

- **鉴权**：bearer `botToken`（agb_）→ `resolve_bot_by_token` → 校验 `bot.status=="online"`。
- **单 bot 单活动连接**：`bot_session_registry.bind_control/bind_data` 返回 `old_ws`，新连接 supersede（close code SUPERSEDED）。

### session 多路复用（一个 bot 同时处理多会话）

```
路由层级：
  bot_id ──→ 哪个 Bridge 实例 + 哪条单连接
    └─ scope (channel / DM / topic) ──→ provider_session_key   (PG: AgentNexusSessionBinding)
         └─ data WS 每帧带 channel_id ──→ demux 到本地 agent 对应会话
```

- `_primary_scope(trigger)` → `(scope_type, scope_id)`：DM→dm scope、topic→topic_id、否则→channel_id。
- `build_provider_session_key(provider_agent_id, provider_account_id, session_id)` → 稳定 key，本地 ACP agent 据此隔离每会话上下文。
- 单条 data WS 是**多路复用隧道**；`channel_id` 是 demux 维度。**session 不是新的连接层，是 bot 之下的子维度。**

---

## 2. 状态存储盘点（决定多实例化工作量）

| 状态 | 现存储 | 多实例 |
|------|--------|--------|
| 活动 WS 对象（control/data） | 进程内（WS 不可序列化，**必然**） | 每实例进程内 |
| session 绑定（scope→session_key） | ✅ PG `AgentNexusSessionBinding` | 已共享，故障转移可重解析 |
| 事件日志（重放） | ✅ PG `AgentBridgeEvent`（bot_id, stream, seq, payload） | 已共享，任意实例 `events_since` |
| seq 计数器 | 进程内缓存，从 DB `MAX(seq)` bootstrap | 单活动实例避免冲突；failover 重 bootstrap |
| **bot_id → 哪个实例持有连接** | ❌ 仅进程内 registry | ← **唯一缺口，补 NATS KV** |

> **结论：多实例化只缺一个存在性注册表。** session 状态、事件重放都已 DB-backed。

---

## 3. 多实例连接设计

### 3.1 实例亲和：按 bot_id 一致性哈希

- 入口按 `bot_id` 一致性哈希 → 同一 bot 的 control + data + **全部 session** 确定性落到同一实例。
- connector 拨连时携带路由键（如 botToken 派生 hash），使两条 socket 同归一实例。
- 实例故障 → 重哈希到新 owner → connector 重连 → 新实例从 PG 重 bootstrap seq + 重解析 session 绑定 + event_log 重放。

### 3.2 存在性注册（NATS KV）

```
acp.presence.{bot_id} = { instance_id, connection_id, bound_at }
```

- bind 时写入；断开时注销（带 TTL 兜底僵尸）。
- workers 选中 ACP bot → 查 KV → 经 `acp.dispatch.{bot_id}` 定向到 owner 实例。
- KV 查不到（connector 离线）→ `bot_pipeline_error` 帧 / DLQ。

### 3.3 跨实例 supersede

connector 重连命中实例 B，而旧连接在实例 A：

```
B bind → 写 acp.presence.{bot_id}={B,...}（CAS 覆盖原 {A,...}）
       → publish acp.supersede.{bot_id}
A（订阅该 subject）→ 关闭本地 stale control/data（close SUPERSEDED）
```

KV 是「谁持有该 bot」的唯一真相。

---

## 4. 重连与重放（已有，跨实例可用）

```
data hello → last_event_seq（来自 PG MAX(seq)）
connector 发 resume(last_seen_seq)
Bridge events_since(bot_id,"data",last_seq) → 从 PG 重放遗漏事件
```

- 因 event_log 在 PG，重连命中任意实例都能重放。
- **多 session 一起恢复**：supersede/重连中断的是整条连接，N 个会话的流同时中断、同时靠重放对齐。

---

## 5. 并发控制（单连接多 session 的真问题）

### 5.1 HOL 阻塞 → 文件传输分独立 lane

- 小帧（delta / control / send / done）走 data WS。
- 大文件**不再走 data WS 的 `file_upload`**，改走独立传输通道：
  - outbound：connector 经 REST presigned 上传到 S3，data WS 只传文件引用。
  - inbound：同理用引用 + 独立拉取。
- 避免一个会话的大文件阻塞其他会话的流式 token。

### 5.2 按 bot 限并发 + 排队

- Bridge 对每个 bot 限制同时 in-flight 的会话数（`max_concurrent_sessions`，可配）。
- 超出则排队，FIFO 调度，防一个重会话饿死其他会话。
- dispatch 入口加调度器：`acp.dispatch.{bot_id}` 到达后进入该 bot 的并发槽 / 队列。

---

## 6. 连接生命周期状态机

```
connector 拨 control + data (botToken)
        │ resolve_bot_by_token + status==online
        ▼
   bind_control / bind_data
        │ 写 acp.presence.{bot_id}（CAS）
        │ 若原属他实例 → publish acp.supersede → 旧实例关旧连
        ▼
   control.hello（成员快照/config）
   data.hello（last_event_seq）
        │ connector 发 resume(last_seen_seq) → events_since 重放
        ▼
   ┌──────── ACTIVE ────────┐
   │ 多 session 复用:        │
   │  worker → acp.dispatch  │
   │   → 并发槽/队列 → send   │
   │   → 本地 agent → delta/done
   │   → record_event(seq) + rt.* 回浏览器
   │ 大文件 → 独立 lane       │
   └────────────────────────┘
        │ 断线 / supersede / bot offline
        ▼
   注销 presence（或 TTL 过期）→ in-flight 会话留待重连重放
```

---

## 7. 故障转移时序（实例 A 挂）

```
实例 A 崩溃
  → acp.presence.{bot_id} TTL 过期 / 健康检查剔除
  → connector 检测断线 → 重连
  → 一致性哈希 → 落到实例 B
  → B bind + 写 presence + bootstrap seq(MAX) + 重解析 session 绑定
  → connector resume(last_seen_seq) → B events_since 重放遗漏
  → N 个 session 全部恢复，dispatch 路由更新到 B
```

> 期间 worker 的 dispatch 若发往已死的 A：request 超时 → 查 KV 取新 owner 重试 / 落 DLQ。

---

## 8. 回流关联：(bot+session) 的输出怎么回到正确频道

**关联键是 `msg_id`（占位消息 id），不是 channel_id、更不是 session_key。**

现状链路（`streams.py` 的 `StreamRegistry`：`msg_id → {bot_id, channel_id, task_id}`）：

```
1. worker 跑 pipeline → 在目标 channel 建【占位 Message】
   (msg_id, channel_id, sender=bot, is_partial=true)
   → stream_registry.register(msg_id, bot_id, channel_id)
   → dispatch 给 connector 时带 msg_id
2. 远程 agent 流式输出 → connector 发 delta{msg_id, seq, delta} / done{msg_id}
3. bridge_apply_delta(msg_id) → registry.get(msg_id) → 取 channel_id → 广播
```

- **`session_key` 不参与回流路由**：它只用于本地 ACP agent 隔离上下文。回流完全靠 `msg_id`——端到端关联令牌。
- **「哪个频道」的持久真相 = PG `Message.channel_id`**：现有 delta handler 的恢复路径，registry 缺失时 `s.get(Message, msg_id)` 重建 stream。

### 8.1 新架构的跨进程问题（关键）

> 占位 Message 由 **worker** 创建，但 delta 回流到**持有 connector 的 Bridge 实例**——**不同进程**。
> Bridge 收到 delta 时，其进程内 `StreamRegistry` 没有该 msg_id。

**解法**：dispatch 时由 worker 把 `channel_id` 直接带给 Bridge（worker 刚建占位，channel_id 现成）：

```
dispatch payload (worker→Bridge):  { bot_id, channel_id, msg_id, scope, ... }
Bridge 收到 delta{msg_id, seq} →
  用 dispatch 带下来的 msg_id→channel_id 映射（进程内，同 bot 同实例够用）
  PG Message.channel_id 兜底（connector 重连重放时）
  → publish NATS rt.stream.{channel_id}.{msg_id}  → Gateway fan-out（WIRE §8）
```

- channel_id **不靠 Bridge 反查 session**，由 worker dispatch 时带下来；PG 仅作重连兜底。
- ACP 的 `delta` 帧**已自带 seq** → 与 [WIRE §5](./WIRE_PROTOCOL.md) 客户端去重天然对齐，无需额外改造。

### 8.2 cancel 也要跨进程

现状 cancel 靠进程内 `StreamState.cancel_event` / `producer_task.cancel()`。新架构中取消请求（来自 REST/用户）需经 NATS 发到**持有 connector 的 Bridge 实例**（dispatch 的反向）：

```
REST 取消 → NATS acp.cancel.{bot_id}（按 presence 路由到 owner 实例）
          → Bridge 在该 msg_id 的 StreamState 触发 cancel → 通知本地 agent
```

## 9. 与既有契约的衔接

- 输出仍经 EventBus → NATS `rt.stream.*` / `rt.channel.*`（[WIRE §8](./WIRE_PROTOCOL.md)）→ Gateway → 浏览器，客户端线协议零差异。
- worker↔Bridge 的 dispatch 用 RS256 service token（[WIRE §6.1](./WIRE_PROTOCOL.md)）。
- 任务投递与 ACP 分支选择见 [TASK_DELIVERY §5](./TASK_DELIVERY.md)。

---

## 10. 迁移要点（接 Phase 2）

| 改动 | 说明 |
|------|------|
| presence 注册表 | 新增 NATS KV 读写 + TTL；bind/unbind 处接入 |
| 跨实例 supersede | 订阅 `acp.supersede.{bot_id}`，关本地 stale 连接 |
| 一致性哈希入口 | Bridge 前置路由按 bot_id；connector 携带路由键 |
| dispatch 带 channel_id | worker→Bridge 的 dispatch payload 带 `{channel_id, msg_id}`，回流无需反查 |
| cancel 跨进程 | REST 取消经 `acp.cancel.{bot_id}` 路由到 owner 实例触发 StreamState cancel |
| 文件独立 lane | `file_upload` 帧改为引用 + REST/S3 旁路 |
| 并发调度器 | 每 bot `max_concurrent_sessions` + 队列 |
| seq 计数器 | 维持「进程内缓存 + DB bootstrap」，failover 自动重 bootstrap |
| StreamRegistry | 降级为单实例内 buffer/cancel 协调；跨进程真相是 PG `Message.channel_id` |
| event_log / session 绑定 | **不动**（已 DB-backed，天然支持多实例） |
