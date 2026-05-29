# AgentNexus Agent 任务投递契约 (Task Delivery v1)

> 版本：v1 草稿
> 分支：`break/rust-gateway-arch`
> 适用范围：Python REST API → NATS → Python Agent Worker 的任务投递（控制平面）
> 配套：[WIRE_PROTOCOL.md](./WIRE_PROTOCOL.md)（worker 产出的事件如何回到客户端）

本契约定义「用户消息触发 Agent」这条链路在新架构下的投递语义。
**核心原则沿用现有设计：任务是瘦指针，worker 自己从 PG rehydrate 全部上下文。**

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| Payload | **瘦指针**（不带上下文，worker 从 PG 拉） | 单一数据源、避免陈旧/巨大 payload；沿用现有模式 |
| 投递语义 | **JetStream work-queue** + explicit ack | 每消息只投一个消费者，ack 后移除 |
| 幂等 | **PG claim 表 + msg_id 唯一约束** | 事务性最强；兼做 streaming seq ownership |
| 频道顺序 | **保持并行**（无频道锁） | 与现状一致，吞吐高，低回归风险 |
| 重试 | max_deliver=3，耗尽进 **DLQ** + 错误帧 | 取代现有静默 drop，可观测 |

---

## 1. 现状（被替换的链路）

```
REST 持久化用户消息
  → asyncio.create_task(enqueue)        # 即发即忘
  → Redis Stream xadd                   # {job_id, channel_id, msg_id, attempts}
  → 消费者组 agentnexus-backend xreadgroup (block 5s, 批量)
  → run_bot_pipeline_job(channel_id, msg_id)   # 从 PG 拉消息, rehydrate, 跑 pipeline
  → xack
重试: attempts<3 重新 xadd, 耗尽静默 drop+log
```

**致命缺口**：无幂等。at-least-once + 多 worker 下同 msg_id 被处理两次 → 重复 bot 回复 + WIRE §5 的 seq 冲突。本契约修复之。

---

## 2. Task Payload

```jsonc
{
  "task_id": "<uuid>",          // 每次 enqueue 唯一,用于追踪
  "workspace_id": "<uuid>",
  "channel_id": "<uuid>",
  "msg_id": "<uuid>",           // 触发消息;同时是幂等键
  "trigger": "user_message",    // 判别式,可扩展(见 §6)
  "enqueued_at": "<RFC3339>"
}
```

- **不带上下文**：消息内容、频道配置、bot 列表、历史，全部由 worker 按 `msg_id`/`channel_id` 从 PostgreSQL rehydrate（沿用 `run_bot_pipeline_job` 现有逻辑）。
- **发布时带 NATS header** `Nats-Msg-Id: {msg_id}`：启用 JetStream **发布去重窗口**，防止同一 REST 处理重复发布。

---

## 3. NATS / JetStream 配置

### Subject

```
agentnexus.task.{workspace_id}.{channel_id}
```

`workspace_id` 进 subject 是为将来**按工作区隔离 worker 池 / 限流**预留。MVP 阶段单消费者通配即可。

### Stream

```
名称:     AGENT_TASKS
subjects: agentnexus.task.>
retention: WorkQueue           # 每消息投递给恰好一个消费者,ack 后删除
```

### Durable Consumer

```
名称:        agent-workers
ack_policy:  explicit
ack_wait:    120s              # > 单次 pipeline 最长耗时;超时才重投
max_deliver: 3                 # 与现有 _MAX_ATTEMPTS 对齐
```

worker 数 = 现有 `orchestrator_worker_concurrency`，绑定同一 durable consumer 形成竞争消费。

---

## 4. 幂等：PG claim 表

```sql
CREATE TABLE bot_task_claims (
    msg_id      TEXT PRIMARY KEY,        -- 幂等键
    task_id     TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    worker_id   TEXT NOT NULL,
    status      TEXT NOT NULL,           -- 'running' | 'done' | 'failed'
    attempts    INT  NOT NULL DEFAULT 1,
    claimed_at  TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL     -- 心跳续租,判断 claim 是否陈旧
);
```

### Worker 处理流程

```
收到 task:
  ┌─ INSERT INTO bot_task_claims (msg_id, status='running', ...)
  │    ON CONFLICT (msg_id) DO NOTHING RETURNING msg_id
  │
  ├─ 插入成功 → 我抢到所有权 → 跑 pipeline(§5)
  │
  └─ 冲突(已有 claim) → 读现有行:
       · status='done'                        → ack, 跳过(已完成的重投)
       · status='running' 且 updated_at 新鲜   → ack, 跳过(他人正在跑)
       · status='running' 且 updated_at 陈旧   → 接管(worker 疑似崩溃),
       ·                                          worker_id=我, attempts++, 跑
       · status='failed' 且 attempts<max      → 接管重试

跑完:
  · 成功 → UPDATE status='done'  → JetStream ack
  · 失败 → UPDATE status='failed', attempts++ → JetStream NAK
            (NAK 触发重投, 直到 max_deliver; 耗尽进 §7 DLQ)
```

### 关键点

- **claim 持有者拥有该 msg_id 的 streaming `seq`**（解决总览 #4：seq 冲突）。
- **租约/心跳**：长 pipeline 运行中周期性 `UPDATE updated_at`，使 claim 不被误判陈旧；陈旧阈值 = `ack_wait`。同时调用 JetStream `in_progress` ack 延长投递截止。
- **接管时机**：仅当 claim 陈旧（持有 worker 崩溃）才接管，避免与活跃 worker 双跑。

### 部分副作用（崩溃在中途）

worker 若在「已持久化部分 bot 消息」后、`status='done'` 前崩溃，接管重跑会产生重复回复。缓解：

> bot 回复持久化按 **`(trigger_msg_id, bot_id)` 确定性 id** upsert，重跑覆盖而非新增。
> —— 同 [ACP_CONNECTION_MODEL §8.3 R3](./ACP_CONNECTION_MODEL.md)（占位 id 确定性派生），
> 内部 bot 与外部 ACP bot 共用同一规则；Phase 2 随 pipeline 迁移落地。

---

## 5. Worker 执行（rehydrate，沿用现有）

抢到 claim 后，等价于现有 `run_bot_pipeline_job(channel_id, msg_id)`：

1. 独立 DB session 按 `msg_id` 读 `Message`（不存在 → ack 跳过）。
2. `run_bot_pipeline` 内部：选 bot、建历史/上下文、调 adapter（LLM）。
3. 产出经 EventBus → NATS（WIRE §8 的 `rt.channel.*` / `rt.stream.*`）→ Gateway → 客户端。
4. 持久化 bot 消息、`schedule_history_update`、commit。

> EventBus 的 sink 从「直接 WS 广播」改为「publish 到 NATS」，是 Phase 2 的改造点。

---

## 6. Trigger 判别式（可扩展）

| `trigger` | 含义 | rehydrate 依据 |
|-----------|------|---------------|
| `user_message` | 用户发消息（当前唯一） | `msg_id` |
| `scheduled`（预留） | 定时任务触发 | payload 附加 schedule_ref |
| `agent_bridge_resume`（预留） | 外部 Agent 恢复 | payload 附加 session_ref |
| `retry`（预留） | 显式重试 | `msg_id` |

worker 按 `trigger` 决定 rehydrate 哪些上下文，保持 payload 瘦身。

---

## 7. 重试与 DLQ

- **正常重试**：pipeline 失败 → NAK → JetStream 按 `max_deliver=3` 重投。
- **耗尽**：取代现有静默 drop，路由到死信：
  ```
  agentnexus.task.dlq
  ```
  + 发 WIRE §4.1 的 `bot_pipeline_error` 帧给频道（现有行为保留，用户可见失败）。
- DLQ 供运维排查/手动重放；不自动重投，避免毒消息循环。

---

## 8. REST 发布路径（改造点）

```python
# 现有: asyncio.create_task(enqueue_bot_pipeline_job(channel_id, msg_id))
# 改为(用户消息 commit 之后,确保 worker 能 rehydrate):
await js.publish(
    f"agentnexus.task.{workspace_id}.{channel_id}",
    TaskPayload(
        task_id=uuid4(), workspace_id=ws, channel_id=cid,
        msg_id=mid, trigger="user_message", enqueued_at=now(),
    ).json().encode(),
    headers={"Nats-Msg-Id": mid},      # 发布去重窗口
)
# 发布失败 → 发 bot_pipeline_error 帧(现有行为)
```

---

## 9. 迁移与兼容

| 阶段 | 动作 |
|------|------|
| Phase 0 | 加 `bot_task_claims` 表的 Alembic 迁移；REST 双写 Redis Stream(旧) + NATS(新) |
| Phase 2 | Worker 改订 NATS `AGENT_TASKS`；EventBus sink 改 publish NATS；REST 去掉 Redis Stream 写 |
| Phase 3 | 下线 `RedisBotPipelineQueue` 与 `agentnexus:bot_pipeline:jobs` stream |

> 现有 `BotPipelineJob{job_id,channel_id,msg_id,attempts}` 与新 `TaskPayload` 字段基本同构，迁移成本低。幂等是净新增（旧链路本就没有）。

---

## 附录：与 WIRE_PROTOCOL 的衔接

```
REST ──(本契约)──▶ NATS AGENT_TASKS ──▶ Worker
                                          │ 抢 claim(拥有 seq)
                                          │ rehydrate + run pipeline
                                          ▼
                            NATS rt.channel.* / rt.stream.*  (WIRE §8)
                                          ▼
                                   Rust Gateway (哑管道)
                                          ▼
                                       客户端
```
