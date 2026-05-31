# AgentNexus 架构重构规划

> 版本：v0.2
> 分支：`break/rust-gateway-arch`
> 决策背景：现有 Python 单体后端兼顾了实时连接网关和 Agent 编排两层职责。本文档记录从单体迁移到「Rust Backend + Python Agent Service」混合架构的完整规划。

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
| `app/api/v1/ws/` | WebSocket 接入、心跳、鉴权 | → Rust Backend |
| `app/services/realtime_broker.py` | 内存/Redis fan-out 广播 | → Rust Backend |
| `app/services/ws_service.py` | WebSocket 消息分发逻辑 | → Rust Backend |
| `app/api/v1/auth/` | JWT 签发/验证 | → Rust Backend（RS256 签发+验签）|
| `app/api/v1/channels/` | 频道 CRUD | → Rust Backend |
| `app/api/v1/messages/` | 消息 CRUD + 搜索 | → Rust Backend |
| `app/api/v1/dms/` | DM + 分组 | → Rust Backend |
| `app/features/agent_bridge/` | Agent Bridge 协议 | → Rust Backend |
| `app/features/bot_runtime/` | 内置 Bot 运行时、Pipeline | → Python Agent Service |
| `app/features/memory/` | 上下文记忆、RAG | → Python Agent Service |
| `app/services/file_processor/` | 文档解析、embedding | → Python Agent Service |
| `app/services/search_service.py` | 全文 + 向量搜索 | → Rust Backend（PG full-text）|
| `app/db/` | PostgreSQL 模型、Alembic | → 共用（两侧读写同一库）|

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
  │ WS + REST（同一端口 :8000）
  ▼
┌──────────────────────────────────────────────────────────┐
│                    Rust Backend                           │
│  ├─ REST API（全量 CRUD）                                  │
│  ├─ WS Gateway（浏览器侧连接管理 + fan-out）                 │
│  ├─ Agent Bridge（bot 连接管理 + 任务派发 + delta 转发）      │
│  ├─ Resource API（bot 通过协议访问平台资源）                  │
│  ├─ 权限引擎（ACP RBAC）                                   │
│  └─ DB / S3 / SMTP / JWT                                 │
└──────────┬───────────────────────────────────────────────┘
           │ Agent Bridge WS (control + data)
           ▼
┌──────────────────────────────────────────────────────────┐
│              Python Agent Service                          │
│  ├─ 一份通用 ACP Agent runtime（无 bot 类，身份由数据 seed）   │
│  ├─ 行为来自 Environment 模板（见 BUILTIN_AGENT.md）          │
│  ├─ Memory / RAG · LLM 调用（流式）                          │
│  └─ 走 Agent Bridge 协议，和外置 ACP bot 零区别              │
└──────────────────────────────────────────────────────────┘
```

**关键决策**：
- **没有独立的 Gateway**：Gateway + REST API 合并为一个 Rust Backend
- **没有 NATS**：Rust Backend 和 Agent Service 通过 Agent Bridge WS 直连（**单实例前提**）
- **没有 Python REST API**：所有 REST 端点迁移到 Rust
- **内置 bot = 外置 bot**：走同一套 Agent Bridge 协议 + resource 协议

> **部署模型（本期定调：单实例）**：删 NATS 是用 HA/水平扩展换来的。本期跑单实例；`Fanout` 与 `BotLocator` 抽象为可替换 trait，多实例为未来计划。完整取舍与灰度方案见 [ARCHITECTURE_OVERVIEW §部署模型](./ARCHITECTURE_OVERVIEW.md)。

### 2.2 为什么不需要 NATS

旧架构需要 NATS 的原因：Gateway 和 REST API 是两个进程，Worker 是第三个进程，三者之间需要消息总线。

新架构只有两个服务：
- Rust Backend（一个进程，处理所有 HTTP/WS）
- Agent Service（一个进程，通过 WS 连接 Backend）

WS 本身就是进程间通信通道。task 派发通过 control WS，delta 回传通过 data WS，资源访问通过 resource_req/res。**不需要额外的消息总线。**

---

## 三、Rust Backend 设计

### 3.1 技术选型

| 组件 | 选型 |
|------|------|
| 异步运行时 | Tokio |
| HTTP/WebSocket 框架 | axum |
| JWT | jsonwebtoken crate（RS256） |
| 数据库 | sqlx（async, compile-time checked queries） |
| S3 | aws-sdk-s3 |
| SMTP | lettre |
| 配置 | config + dotenvy |
| 可观测性 | tracing + tracing-subscriber + opentelemetry |

### 3.2 目录结构

```
gateway/
├── Cargo.toml
├── Dockerfile
├── src/
│   ├── main.rs                 ← 入口
│   ├── config.rs               ← 环境变量
│   │
│   ├── transport/              ← 入口层
│   │   ├── mod.rs
│   │   ├── router.rs           ← axum Router 组装
│   │   ├── middleware/
│   │   │   ├── auth.rs         ← JWT 验签（RS256）
│   │   │   ├── cors.rs
│   │   │   ├── request_id.rs
│   │   │   └── access_log.rs
│   │   ├── rest/               ← REST handlers（薄层，调 domain）
│   │   │   ├── mod.rs
│   │   │   ├── auth.rs
│   │   │   ├── channels.rs
│   │   │   ├── messages.rs
│   │   │   ├── bots.rs
│   │   │   ├── files.rs
│   │   │   ├── workspaces.rs
│   │   │   ├── memory.rs
│   │   │   ├── admin.rs
│   │   │   └── ...
│   │   └── ws/
│   │       ├── mod.rs
│   │       ├── channel.rs      ← /ws/channels/{id}
│   │       ├── user.rs         ← /ws/users/{id}
│   │       └── agent_bridge.rs ← /ws/agent-bridge/{control|data}
│   │
│   ├── domain/                 ← 业务逻辑（不依赖 transport）
│   │   ├── mod.rs
│   │   ├── auth/
│   │   ├── channels.rs
│   │   ├── messages.rs
│   │   ├── bots.rs
│   │   ├── files.rs
│   │   ├── memory.rs
│   │   ├── search.rs
│   │   └── ...
│   │
│   ├── realtime/               ← 浏览器侧 WS 连接管理
│   │   ├── mod.rs
│   │   ├── manager.rs          ← ConnectionManager
│   │   ├── connection.rs       ← 单连接读写、心跳、背压
│   │   ├── frame.rs            ← WIRE_PROTOCOL 信封
│   │   └── fanout.rs           ← 广播逻辑
│   │
│   ├── agent_bridge/           ← Agent Bridge 协议
│   │   ├── mod.rs
│   │   ├── session.rs          ← bot session 管理
│   │   ├── registry.rs         ← bot 注册表
│   │   ├── dispatcher.rs       ← 任务派发
│   │   ├── stream.rs           ← delta 转发 → realtime fanout
│   │   ├── resource.rs         ← resource_req/res 处理
│   │   ├── permission.rs       ← ACP 权限解析
│   │   └── protocol.rs         ← 帧类型定义
│   │
│   ├── infra/                  ← 基础设施
│   │   ├── mod.rs
│   │   ├── db/
│   │   │   ├── pool.rs
│   │   │   └── models.rs
│   │   ├── storage.rs          ← S3
│   │   ├── mail.rs             ← SMTP
│   │   └── crypto.rs           ← Fernet
│   │
│   └── app_state.rs            ← AppState
│
└── tests/
```

### 3.3 模块依赖

```
transport (入口层)
  │ 调用
  ▼
domain (业务逻辑)
  │ 调用
  ▼
infra (数据/外部服务)

realtime (独立子系统)
  ├─ 被 transport::ws 调用
  └─ 被 agent_bridge::stream 调用

agent_bridge (独立子系统)
  ├─ 被 transport::ws::agent_bridge 调用
  └─ 调用 domain (资源访问)
```

---

## 四、Python Agent Service 设计

### 4.1 定位

Agent Service 是一个**普通 ACP bot**，通过 Agent Bridge 协议接入 Rust Backend。
内置 bot 和外置 bot **零区别**。

### 4.2 目录结构

```
agent_service/
├── main.py                     ← 入口
├── provider.py                 ← ACP provider（连接 Agent Bridge）
├── resources.py                ← ResourceClient（通过 resource_req 访问平台资源）
├── adapters/
│   ├── http_bot.py             ← 调 LLM API
│   ├── coordinator.py          ← 多 bot 协调
│   ├── helper.py
│   └── help_bot.py
├── memory/                     ← 记忆管理（通过 resource API）
├── tools/                      ← 工具调用
└── config.py
```

### 4.3 与外部 ACP bot 的对比

| 维度 | 内置 Agent Service | 外置 ACP Bot |
|------|-------------------|-------------|
| 接入协议 | Agent Bridge WS | Agent Bridge WS |
| 认证 | botToken (agb_) | botToken (agb_) |
| 任务派发 | control WS task 帧 | control WS task 帧 |
| 流式输出 | data WS delta/done | data WS delta/done |
| 资源访问 | resource_req/res | resource_req/res |
| 权限模型 | ACP RBAC | ACP RBAC |
| trust_level 默认值 | system | standard |
| 部署 | 独立容器 | 第三方运行 |

---

## 五、基础设施变更

### 5.1 服务清单

| 服务 | 镜像/方式 | 说明 |
|------|----------|------|
| **Rust Backend** | `ghcr.io/…/backend-rs:latest` | 新建，替代原 Python backend |
| **Python Agent Service** | 从现有 backend 镜像分拆 | 独立扩容 |
| PostgreSQL | 不变 | 主库 + 记忆库 |
| Redis | 不变 | 仅保留 cache 用途（移除 realtime/queue 用途） |
| RustFS (S3) | 不变 | 文件存储 |
| kkfileview | 不变 | 文档预览 |

**移除的服务**：NATS（不需要了）。

### 5.2 docker-compose.yml 变更预览

```yaml
services:
  backend-rs:
    build: ./gateway
    environment:
      - DATABASE_URL=postgresql+pg://...
      - JWT_PRIVATE_KEY=${JWT_PRIVATE_KEY}
      - JWT_PUBLIC_KEY=${JWT_PUBLIC_KEY}
      - S3_ENDPOINT=...
      - SMTP_HOST=...
    ports: ["8000:8000"]
    depends_on: [postgres, rustfs]

  agent-service:
    build: ./agent_service
    environment:
      - BACKEND_WS_URL=ws://backend-rs:8000/ws/agent-bridge
      - BOT_TOKEN=${AGENT_BOT_TOKEN}
    deploy:
      replicas: 2
    depends_on: [backend-rs]

  postgres:
    image: postgres:16-alpine
    # 不变

  redis:
    image: redis:7-alpine
    # 仅 cache 用途

  rustfs:
    # 不变

  frontend:
    build: ./frontend
    # 不变（仍指向 backend:8000，但现在是 Rust Backend）
```

### 5.3 Frontend 变更

| 变更点 | 说明 |
|--------|------|
| REST API | 指向 Rust Backend（URL 不变，仍是 `/api/v1`） |
| WebSocket | 指向 Rust Backend（URL 不变，仍是 `/ws`） |
| 代码改动 | 几乎为零（接口不变，只是后端换了语言） |

---

## 六、迁移阶段规划

### Phase 0：准备（1-2 周）
- [ ] RS256 密钥对生成，JWT 迁移窗口
- [ ] 内置 bot 改走 Agent Bridge 协议（Python 内部改造）
- [ ] 定义 resource_req/res 协议（已定稿 → AGENT_BRIDGE_RESOURCE.md）
- [ ] 定义 ACP 权限模型（已定稿 → BOT_PERMISSION.md）
- [ ] DB migration：bot_accounts 加 `permissions`, `trust_level`, `approval_mode` 列
- [ ] 完善集成测试覆盖，作为回归基准

### Phase 1：Rust Backend PoC（3-4 周）
- [ ] 初始化 Cargo workspace
- [ ] 实现 auth（RS256 签发+验签）
- [ ] 实现 WS（浏览器侧 + Agent Bridge）
- [ ] 实现核心 REST 端点（auth + channels + messages）
- [ ] 实现 agent_bridge 模块（注册、派发、delta 转发）
- [ ] 实现 resource 模块（resource_req 分发）
- [ ] 实现权限引擎（ACP RBAC evaluate）
- [ ] Agent Service 独立部署
- [ ] 灰度：10% 流量走 Rust Backend

### Phase 2：Rust Backend 全量（3-4 周）
- [ ] 迁移剩余 REST 端点
- [ ] 旧 Python REST API 下线
- [ ] Redis 移除 realtime/queue 用途，仅保留 cache
- [ ] 集成测试全量通过

### Phase 3：优化（持续）
- [ ] Rust Backend 性能调优
- [ ] Agent Service 独立扩容（K8s HPA）
- [ ] OpenTelemetry 全链路追踪
- [ ] 权限审计日志
- [ ] Vector DB 评估（pgvector 或 Qdrant）

---

## 七、风险与缓解措施

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Rust 重写 REST API 工作量超预期 | 中 | 高 | Phase 1 先做核心端点，其他可 reverse proxy 到旧 Python |
| sqlx 编译时查询与 PG schema 不同步 | 中 | 中 | CI 加 alembic migration + sqlx compile 检查 |
| Agent Bridge WS 连接稳定性 | 低 | 高 | 心跳 + 自动重连 + event_log 重放 |
| 前端兼容性问题 | 低 | 低 | API 接口不变，前端改动为零 |
| Rust 团队学习成本 | 高 | 中 | Phase 1 限定范围；提供架构示例代码 |
| bot 权限模型复杂度 | 中 | 中 | 从 standard 预设开始，逐步放开 |
| **单实例 = 单点故障**（无 NATS 后无横向扩展） | 中 | 高 | 接受本期 SLA；`Fanout`/`BotLocator` 抽象为 trait，未来接 Redis/NATS 即可多实例，协议不变 |
| **新旧后端并存期双写 PG**（灰度） | 中 | 高 | 按端点切分而非流量百分比；bot 派发/占位 upsert 只允许一方负责 |
| **resource 写授权遗漏**（untrusted bot 改记忆） | 中 | 高 | 资源写走 Grant + trust_level 闸门（BOT_PERMISSION §5.3/§7）；memory.write 默认仅 trusted/system |

---

## 八、不在本次重构范围内

- 前端框架迁移（继续用 React + Vite）
- 数据库从 PostgreSQL 迁移（继续用 PostgreSQL + Alembic）
- 多租户隔离（现有 workspace 模型不变）
- Vector DB 选型（Phase 3 再评估）

---

## 九、参考资料

- [Rust axum](https://github.com/tokio-rs/axum)
- [sqlx](https://github.com/launchbadge/sqlx)
- [jsonwebtoken crate](https://docs.rs/jsonwebtoken)
- [OpenTelemetry Rust SDK](https://github.com/open-telemetry/opentelemetry-rust)
- [ACP 协议](https://acp.agentunion.cn/introduction/)
