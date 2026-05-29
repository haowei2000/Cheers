# AgentNexus 架构重构总览

> 版本：v0.1
> 分支：`break/rust-gateway-arch`
> 本文是架构重构的**索引入口**。细则见：
> - [REFACTOR_PLAN.md](./REFACTOR_PLAN.md) —— 模块迁移、目录结构、阶段计划、风险
> - [WIRE_PROTOCOL.md](./WIRE_PROTOCOL.md) —— 实时线协议 v1（客户端 ↔ Gateway ↔ NATS ↔ Worker）
> - [TASK_DELIVERY.md](./TASK_DELIVERY.md) —— Agent 任务投递契约 v1（REST → NATS → Worker）

---

## 一、为什么要拆

现有 Python 单体把**两类性质完全不同的负载**塞进同一个 asyncio 事件循环：

| 负载 | 性质 | 诉求 |
|------|------|------|
| 实时连接层 | I/O bound | 高并发长连接、低延迟、稳定广播 |
| Agent 编排层 | CPU / LLM bound | AI 生态、快速迭代、独立扩容 |

两者争抢事件循环 → token 流式输出抖动；且无法按各自负载特性独立扩容。
**结论**：Rust 做实时网关（抗流量），Python 做 Agent 编排（生态强），中间用消息总线解耦。

---

## 二、目标拓扑

```
Browser
  │ WS (单连接复用)
  ▼
┌─────────────────────────┐
│  Rust Gateway (边缘)      │  Tokio + axum
│  · RS256 验签 (只持公钥)   │  哑管道:不解析 data
│  · 房间订阅 / 成员校验      │
│  · fan-out / 背压 / 限流   │
└──────────┬──────────────┘
           │ NATS JetStream
           ▼
┌─────────────────────────┐      ┌──────────────────────┐
│ Python Agent Workers     │      │ Python REST API        │
│ · Agent 编排 / 工具调用    │      │ · CRUD / 鉴权(RS256签) │
│ · RAG / LLM 流式          │      │ · 文件 / 触发 task      │
│ (独立进程,可水平扩容)      │      │ (FastAPI,职责收窄)     │
└──────────┬──────────────┘      └──────────┬────────────┘
           └────────────┬───────────────────┘
                        ▼
        PostgreSQL + Redis + S3 + (未来 Vector DB)
```

---

## 三、职责切分

| 层 | 语言 | 拿走的现有模块 |
|----|------|--------------|
| **Gateway** | Rust | `api/v1/ws/` + `services/realtime_broker.py` + `services/ws_service.py` |
| **Agent Worker** | Python | `features/agent_bridge/` + `features/bot_runtime/` + `features/memory/` + `tools/` |
| **REST API** | Python | `channels` / `messages` / `dms` / `bots` / `files` / `auth` / `admin` / `search`（保留，职责收窄） |
| **共用** | — | PostgreSQL + Alembic；JWT（Python 私钥签发 / Gateway 公钥验证） |

---

## 四、协议层硬契约（已锁定）

| 维度 | 决策 | 出处 |
|------|------|------|
| 传输 | WS-only，SSE 退场 | WIRE §0 |
| 连接 | 单连接复用，`subscribe/unsubscribe` 切频道 | WIRE §1 |
| 鉴权 | 首帧 `{type:auth,token}` + RS256 非对称（Gateway 只验签） | WIRE §6.1 |
| 成员校验 | Gateway 调 `/internal/authz/membership` + 短 TTL LRU | WIRE §6.2 |
| 顺序 | 流式帧带 `seq`，客户端 `(msg_id,seq)` 去重排序 | WIRE §5 |
| 可靠性 | delta 可丢（best-effort）/ 终态帧不可丢（durable） | WIRE §7 |
| Gateway 角色 | 哑管道，只读外层信封不碰 `data` | WIRE §0 |

**事件信封**（单连接复用的必然——一条 socket 服务多频道）：

```jsonc
{ "v":1, "scope":"channel", "channel_id":"...", "type":"message_stream", "seq":42, "data":{...} }
```

`data` 沿用现有 `pipeline/events.py` 事件词表，前端解析逻辑零改动，只需先剥外层信封。

**NATS subjects**：

```
agentnexus.rt.channel.{id}            终态帧 · durable (JetStream)
agentnexus.rt.user.{id}               用户通知 · best-effort
agentnexus.rt.stream.{id}.{msg_id}    流式 delta · best-effort
agentnexus.task.{ws}.{channel}        触发 Agent · WorkQueue (见 TASK_DELIVERY)
```

---

## 五、迁移阶段

| Phase | 目标 | 关键动作 |
|-------|------|---------|
| **0** | 准备 | 引入 NATS；REST/Worker 双写 Redis+NATS；补齐集成测试基线；生成 RS256 密钥对 |
| **1** | Gateway 搭建 | Rust WS 接入 + 房间管理 + NATS 订阅；灰度切 10% WS 流量 |
| **2** | Worker 剥离 | Agent Worker 独立容器化；REST 改 `nats.publish(task)` 触发；replicas≥2 |
| **3** | 切流下线 | Gateway 全量承接 WS；下线旧 Python ws/SSE；Redis 仅留 cache |
| **4** | 稳定优化 | 限流调优、OpenTelemetry 全链路追踪、JWT evict 主动失效、Vector DB 评估 |

---

## 六、当前未决 / 需留意

| # | 事项 | 状态 |
|---|------|------|
| 1 | **`task.{ws}.{channel}` 投递契约** —— worker 怎么拿上下文 / ack / 重试 / 单消息单 worker 幂等 | ✅ 已定稿 → TASK_DELIVERY.md |
| 2 | token 里**无 workspace_id** —— 工作区级限流/隔离若要在 Gateway 做需重新评估 | 🔶 留意 |
| 3 | **Phase 0 双写一致性** —— Redis(at-most-once) 与 NATS(at-least-once) 并行，前端去重需先于切流上线 | 🔶 留意 |
| 4 | **streaming `seq` 与 worker ownership** —— 同消息被多 worker 重投会 seq 冲突 | ✅ 由 TASK_DELIVERY §4 的 claim 持有者拥有 seq 解决 |
| 5 | **claim 部分副作用** —— worker 中途崩溃后接管重跑的 bot 回复去重，按 `(trigger_msg_id, bot_id)` 确定性 id upsert | 🔧 Phase 2 实现细节 |

---

## 七、明确不在本次范围

- 前端框架迁移（继续 React + Vite）
- 数据库迁移（继续 PostgreSQL + Alembic）
- 认证方案替换（继续 JWT，仅 HS256→RS256）
- 多租户隔离模型变更（现有 workspace 模型不变）
