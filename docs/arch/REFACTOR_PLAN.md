# AgentNexus 架构重构规划

> 版本：v0.1 草稿  
> 分支：`break/rust-gateway-arch`  
> 决策背景：现有 Python 单体后端兼顾了实时连接网关和 Agent 编排两层职责，随着在线连接数和多 Agent 并发流式输出的增加，两层对技术栈的要求开始产生冲突。本文档记录从单体迁移到「Rust 实时网关 + Python Agent Worker」混合架构的完整规划。

---

## 一、现状分析

### 1.1 当前架构

```
Browser / Mobile
      ↓ HTTP REST + WebSocket
FastAPI (Python 单体)
  ├─ REST API          ← auth, channels, messages, bots, files …
  ├─ WebSocket 网关     ← app/api/v1/ws/routes.py
  ├─ Realtime Broker   ← app/services/realtime_broker.py (in-proc / Redis pub/sub)
  ├─ Agent Bridge      ← app/features/agent_bridge/
  ├─ Bot Runtime       ← app/features/bot_runtime/
  ├─ Memory / RAG      ← app/features/memory/
  └─ File Processor    ← app/services/file_processor/
        ↓
PostgreSQL + Redis (optional) + S3-compatible storage
```

### 1.2 现有代码模块清单

| 目录 | 职责 | 迁移目标 |
|------|------|---------|
| `app/api/v1/ws/` | WebSocket 接入、心跳、鉴权 | → Rust Gateway |
| `app/services/realtime_broker.py` | 内存/Redis fan-out 广播 | → Rust Gateway |
| `app/services/ws_service.py` | WebSocket 消息分发逻辑 | → Rust Gateway |
| `app/api/v1/auth/` | JWT 签发/验证 | → 共享（Rust 验证签名，Python 签发）|
| `app/api/v1/channels/` | 频道 CRUD | → Python REST API（保留）|
| `app/api/v1/messages/` | 消息 CRUD + 搜索 | → Python REST API（保留）|
| `app/api/v1/dms/` | DM + 分组 | → Python REST API（保留）|
| `app/features/agent_bridge/` | Agent 外部桥接、SSE 流 | → Python Agent Worker |
| `app/features/bot_runtime/` | 内置 Bot 运行时、Pipeline | → Python Agent Worker |
| `app/features/memory/` | 上下文记忆、RAG | → Python Agent Worker |
| `app/services/file_processor/` | 文档解析、embedding | → Python Agent Worker |
| `app/services/search_service.py` | 全文 + 向量搜索 | → Python Agent Worker |
| `app/db/` | PostgreSQL 模型、Alembic | → 共用（两侧只读/写同一库）|

### 1.3 当前痛点

1. **长连接与 Agent 流式输出争抢事件循环**：bot_runtime pipeline 中的 LLM streaming 和 WebSocket fan-out 在同一个 asyncio loop 里竞争，token 输出有抖动。
2. **横向扩容时 realtime_broker 退化**：单机用内存模式，多实例必须引入 Redis pub/sub，但 Redis pub/sub 是 at-most-once，不适合可靠消息投递。
3. **Agent 逻辑和网关协议耦合**：修改 prompt/工具调用逻辑需要重启整个后端，影响在线连接。
4. **资源利用率不均**：Agent 处理是 CPU/GPU bound，连接管理是 I/O bound，混在一个进程里无法独立扩容。

---

## 二、目标架构

### 2.1 整体拓扑

```
Browser / Mobile
      ↓ WebSocket / SSE
┌─────────────────────────────┐
│    Rust Realtime Gateway    │
│  ├─ JWT 验证 / 限流          │
│  ├─ 房间成员管理              │
│  ├─ 连接心跳 / 断线清理       │
│  ├─ Fan-out 广播             │
│  └─ Token streaming 透传     │
└──────────┬──────────────────┘
           ↓ NATS JetStream / Redis Streams
┌─────────────────────────────┐
│   Python Agent Workers      │
│  ├─ Agent 编排（多 bot 协作） │
│  ├─ 工具调用 / 外部 API       │
│  ├─ RAG / embedding / 搜索   │
│  ├─ 文件解析 / 向量索引       │
│  └─ LLM 流式调用 + 回传       │
└──────────┬──────────────────┘
           ↓
┌─────────────────────────────┐
│   Python REST API           │  ← 继续用 FastAPI，职责收窄
│  ├─ 用户/频道/消息 CRUD      │
│  ├─ 文件上传/下载            │
│  ├─ 鉴权（JWT 签发）         │
│  └─ Admin / 搜索 HTTP 接口   │
└──────────┬──────────────────┘
           ↓
PostgreSQL + Redis + S3 + Vector DB
```

### 2.2 消息总线选型

| 方案 | 语义 | 适合场景 |
|------|------|---------|
| Redis Pub/Sub | at-most-once | 快速广播、丢了也没关系的通知 |
| **NATS JetStream** | at-least-once + 持久化 | **推荐**：Agent 任务投递、流式 token 回传 |
| Redis Streams | at-least-once + 持久化 | 轻量替代，无需额外部署 |
| Kafka | exactly-once | 日志审计、大规模数据管道 |

**决策**：初期用 **NATS JetStream**（单二进制，易部署，支持 request/reply 和 JetStream 持久化），预留 Kafka 升级路径用于审计和数据分析。

---

## 三、Rust Realtime Gateway 设计

### 3.1 技术选型

| 组件 | 选型 |
|------|------|
| 异步运行时 | Tokio |
| HTTP/WebSocket 框架 | axum |
| JWT 验证 | jsonwebtoken crate |
| NATS 客户端 | async-nats |
| 配置 | config + serde |
| 可观测性 | tracing + tracing-subscriber + opentelemetry |

### 3.2 目录结构（新建 `gateway/` 目录）

```
gateway/                        ← 新 Rust crate
├── Cargo.toml
├── Dockerfile
├── src/
│   ├── main.rs
│   ├── config.rs               ← 环境变量/配置文件
│   ├── auth/
│   │   ├── mod.rs
│   │   └── jwt.rs              ← 验证 JWT，提取 user_id/workspace_id
│   ├── ws/
│   │   ├── mod.rs
│   │   ├── handler.rs          ← axum WebSocket upgrade handler
│   │   ├── connection.rs       ← 单连接读写任务、心跳
│   │   └── room.rs             ← 房间成员 Map（DashMap<channel_id, Set<conn_id>>）
│   ├── sse/
│   │   ├── mod.rs
│   │   └── handler.rs          ← Server-Sent Events 端点（token streaming）
│   ├── broker/
│   │   ├── mod.rs
│   │   ├── fanout.rs           ← 本地广播到房间内所有 WebSocket
│   │   └── nats_sub.rs         ← 订阅 NATS，收到事件后 fan-out
│   ├── rate_limit/
│   │   └── mod.rs              ← 基于 token bucket 的连接/消息限流
│   └── metrics/
│       └── mod.rs              ← Prometheus 指标暴露
└── tests/
    └── ws_integration.rs
```

### 3.3 核心流程

#### 连接建立
```
Client → GET /ws?token=JWT
  → auth::jwt::verify(token) → user_id
  → ws::room::join(channel_id, conn_id)
  → ws::connection::run(socket) → read_loop + write_loop
```

#### 消息广播（来自 Python API）
```
Python REST API → NATS publish("agentnexus.rt.channel.{id}", event_json)
  → broker::nats_sub 收到
  → broker::fanout::broadcast(channel_id, frame)
  → 所有在线 WebSocket 连接收到推送
```

#### Token Streaming（Agent 流式输出）
```
Python Agent Worker → NATS publish("agentnexus.rt.stream.{channel_id}.{msg_id}", token)
  → sse::handler 订阅对应 subject
  → SSE chunk → Client
```

### 3.4 与现有代码的对应关系

| 现有 Python 代码 | 对应 Rust 实现 |
|----------------|--------------|
| `app/api/v1/ws/routes.py` | `gateway/src/ws/handler.rs` |
| `app/services/realtime_broker.py` | `gateway/src/broker/` |
| `app/services/ws_service.py` | `gateway/src/broker/fanout.rs` |
| JWT 验证逻辑 | `gateway/src/auth/jwt.rs` |
| Redis pub/sub 广播 | NATS JetStream subject per channel |

---

## 四、Python Agent Worker 重构

### 4.1 从单体中剥离的模块

```
backend/app/workers/              ← 新目录（独立进程，可单独扩容）
├── __init__.py
├── main.py                       ← worker 入口，订阅 NATS 任务队列
├── agent_orchestrator/           ← 从 features/agent_bridge/ 迁移重构
│   ├── __init__.py
│   ├── dispatcher.py             ← 接收 NATS 消息，路由到对应 Agent
│   ├── session.py                ← 多 Agent 对话上下文管理
│   └── streaming.py              ← 流式 token → NATS 回传给 Gateway
├── bot_pipeline/                 ← 从 features/bot_runtime/ 迁移重构
│   ├── __init__.py
│   ├── pipeline.py               ← 现有 pipeline 逻辑保留
│   └── adapters/                 ← 各 LLM 适配器保留
├── memory/                       ← 从 features/memory/ 直接迁移
│   ├── channel_memory.py
│   ├── context_store.py
│   ├── files_index.py
│   └── manager.py
├── rag/                          ← 新模块
│   ├── embedder.py               ← 文档 embedding
│   ├── retriever.py              ← 向量检索
│   └── reranker.py               ← 重排序（可选）
└── tools/                        ← 从 app/tools/ 迁移
    ├── web.py
    └── registry.py
```

### 4.2 Worker 与 Gateway 通信协议（NATS subjects）

```
# Client → Gateway → NATS → Worker
agentnexus.task.{workspace_id}.{channel_id}   ← 新消息触发 Agent

# Worker → NATS → Gateway → Client
agentnexus.rt.channel.{channel_id}            ← 广播事件（消息、状态变更）
agentnexus.rt.stream.{channel_id}.{msg_id}    ← 流式 token

# Worker → NATS → REST API (可选 reply)
agentnexus.db.message.persist                 ← Worker 写消息持久化请求
```

### 4.3 Agent Worker 消息处理流程

```python
# workers/main.py 伪代码
async def handle_task(msg: nats.Msg):
    task = TaskPayload.parse(msg.data)
    async for token in agent_orchestrator.run(task):
        await nats.publish(
            f"agentnexus.rt.stream.{task.channel_id}.{task.msg_id}",
            token.encode()
        )
    await nats.publish(
        f"agentnexus.rt.channel.{task.channel_id}",
        MessageDoneEvent(task.msg_id).json().encode()
    )
```

---

## 五、Python REST API 职责收窄

保留现有 FastAPI 结构，但把实时/Agent 相关路由下线：

### 5.1 保留的路由

| 路由前缀 | 职责 |
|---------|------|
| `/api/v1/auth` | JWT 签发、注册/登录 |
| `/api/v1/workspaces` | 工作区 CRUD |
| `/api/v1/channels` | 频道 CRUD、成员管理 |
| `/api/v1/messages` | 消息 CRUD、分页、搜索 |
| `/api/v1/dms` | DM + 分组管理 |
| `/api/v1/bots` | Bot 配置 CRUD |
| `/api/v1/files` | 文件上传/下载/元信息 |
| `/api/v1/memory` | 记忆读写 HTTP 接口 |
| `/api/v1/admin` | 系统管理 |
| `/api/v1/search` | 搜索 HTTP 接口 |

### 5.2 下线/迁移的路由

| 路由 | 迁移去向 |
|------|---------|
| `GET /ws` WebSocket 端点 | → Rust Gateway |
| `/api/v1/agent_bridge/*` SSE 端点 | → Rust Gateway SSE |
| 内部 realtime publish | → NATS publish call |

### 5.3 REST API 触发 Agent 任务的方式

```python
# 现有：直接在 HTTP handler 里 asyncio.create_task(run_bot(...))
# 重构后：
await nats.publish(
    f"agentnexus.task.{workspace_id}.{channel_id}",
    TaskPayload(message_id=msg_id, ...).json().encode()
)
```

---

## 六、基础设施变更

### 6.1 新增服务

| 服务 | 镜像/方式 | 说明 |
|------|----------|------|
| NATS Server | `nats:latest` (JetStream enabled) | 消息总线 |
| Rust Gateway | `ghcr.io/…/gateway:latest` | 新建 |
| Python Agent Worker | 从现有 backend 镜像分拆 | 独立扩容 |

### 6.2 docker-compose.yml 变更预览

```yaml
services:
  nats:
    image: nats:latest
    command: ["-js"]           # 启用 JetStream
    ports: ["4222:4222"]

  gateway:
    build: ./gateway
    environment:
      - JWT_SECRET=${JWT_SECRET}
      - NATS_URL=nats://nats:4222
      - LISTEN_ADDR=0.0.0.0:8001
    ports: ["8001:8001"]
    depends_on: [nats]

  backend:                     # 原有，职责收窄为 REST API
    build: ./backend
    environment:
      - NATS_URL=nats://nats:4222
      # 去掉 REDIS_URL 用于 realtime（仅保留 cache 用途）
    depends_on: [db, nats]

  agent-worker:
    build: ./backend
    command: ["python", "-m", "app.workers.main"]
    environment:
      - NATS_URL=nats://nats:4222
    deploy:
      replicas: 2              # 独立水平扩容
    depends_on: [db, nats]
```

### 6.3 Frontend 变更

| 变更点 | 说明 |
|--------|------|
| WebSocket URL | 从 `backend:8000/ws` 改为 `gateway:8001/ws` |
| SSE 端点 | 从 `backend:8000/api/v1/agent_bridge/…` 改为 `gateway:8001/sse/…` |
| REST API | 保持不变，仍指向 `backend:8000` |

前端改动量极小，主要是环境变量中 `VITE_WS_URL` 和 `VITE_GATEWAY_URL` 指向新 gateway。

---

## 七、迁移阶段规划

### Phase 0：准备（1-2 周）
- [ ] 引入 NATS（docker-compose 加 nats 服务）
- [ ] Python REST API 中 realtime publish 改为同时写 Redis + NATS（双写兼容）
- [ ] 完善 WebSocket 和 SSE 的集成测试覆盖，作为回归基准
- [ ] 确定 JWT secret 共享方案（Rust Gateway 需要验证 Python 签发的 JWT）

### Phase 1：Rust Gateway 搭建（3-4 周）
- [ ] 初始化 `gateway/` Cargo workspace
- [ ] 实现 `auth::jwt`：验证现有 JWT 格式
- [ ] 实现 `ws::handler` + `ws::room`：WebSocket 接入、房间管理
- [ ] 实现 `broker::nats_sub` + `broker::fanout`：订阅 NATS 并广播
- [ ] 集成测试：Gateway + NATS + Python REST API 联调
- [ ] 灰度：新连接 10% 走 Gateway，其余走原 Python ws

### Phase 2：Agent Worker 剥离（3-4 周）
- [ ] 新建 `backend/app/workers/` 目录
- [ ] 将 `agent_bridge/dispatcher.py` 重构为 NATS subscriber
- [ ] `bot_runtime/pipeline.py` 适配 NATS 消息入口和 token 回传
- [ ] REST API handler 中 `create_task(run_bot)` 改为 `nats.publish(task)`
- [ ] 集成测试：Worker + NATS + Gateway 全链路 token streaming
- [ ] 部署 agent-worker 为独立容器，replicas=2

### Phase 3：切流与下线旧路由（1-2 周）
- [ ] Gateway 全量承接 WebSocket（Python ws 路由下线）
- [ ] Python SSE agent_bridge 路由下线
- [ ] 移除 `realtime_broker.py` 中的本地 asyncio 模式，保留 NATS 模式
- [ ] Redis pub/sub 仅保留 cache 用途

### Phase 4：生产稳定与优化（持续）
- [ ] Gateway 限流策略调优（token bucket per user）
- [ ] NATS JetStream 消息持久化和重放测试
- [ ] Worker 自动扩容（K8s HPA based on NATS consumer lag）
- [ ] 分布式追踪打通（OpenTelemetry：Gateway → NATS → Worker → DB）
- [ ] 考虑引入 Vector DB（pgvector 或 Qdrant）替代现有 files_index

---

## 八、风险与缓解措施

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Rust Gateway JWT 格式不兼容 | 中 | 高 | Phase 0 先写 JWT 解析单元测试，对比 Python jwt |
| NATS 单点故障 | 中 | 高 | NATS clustering（3 节点），或 Phase 1 用 Redis Streams 做降级 |
| Agent Worker 失联时消息丢失 | 中 | 中 | NATS JetStream durable consumer + ack 机制，失败重投 |
| 前端 WS URL 切换期间用户断连 | 低 | 低 | 灰度切流，客户端自动重连（已有） |
| Rust 团队学习成本 | 高 | 中 | Phase 1 限定范围（只做网关，不碰 Agent 逻辑）；提供架构示例代码 |

---

## 九、不在本次重构范围内

- 前端框架迁移（继续用 React + Vite）
- 数据库从 PostgreSQL 迁移（继续用 PostgreSQL + Alembic）
- 认证方案替换（继续用 JWT，Rust 侧只验签）
- Vector DB 选型（pgvector 暂时够用，Phase 4 再评估 Qdrant）
- 多租户隔离（现有 workspace 模型不变）

---

## 十、参考资料

- [Rust axum WebSocket 示例](https://github.com/tokio-rs/axum/tree/main/examples/websockets)
- [async-nats crate](https://docs.rs/async-nats)
- [NATS JetStream 文档](https://docs.nats.io/nats-concepts/jetstream)
- [PyO3：Rust ↔ Python 互调](https://pyo3.rs)（备选，目前不需要）
- [OpenTelemetry Rust SDK](https://github.com/open-telemetry/opentelemetry-rust)
