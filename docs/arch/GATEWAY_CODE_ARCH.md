# Gateway 代码架构

> 语言：Rust · 框架：axum + tokio + sqlx
> 本文只讲结构，不讲实现细节。
> 更新：2026-06-25（R13）—— 目录结构按实际代码树订正（`api/` + `gateway/` + `resource/`，
> 不再是 `transport/` / `acp_bridge/`）；§4-B delta「不落库」订正。

> ⚠️ **部分内容描述的是已废弃的旧模型** —— 本文出现的死概念包括：
> `memory_entries` / `MemoryEntry` 分层记忆表、`channel.memory` 与 `channel.memory.update`
> resource 动词、`Grant` / `trust_level` 细粒度授权（`bot_grants`、`permission::evaluate()`）。
> 这些在 external-agent-first 下已不再是现行行为。
> **现行模型一句话**：无独立 memory 概念；文件是唯一基质；Context = 插件策展的文件；
> agent 一律 pull；授权唯 channel-role。
> 详见 [context-and-environment.md](context-and-environment.md) 顶部的「⚠️ CURRENT MODEL (2026-06-23)」声明。

---

## 一、目录结构（带注释）

```
gateway/
│
├── Cargo.toml                  ← 依赖声明
├── Dockerfile
│
├── migrations/                 ← sqlx 迁移文件（纯 SQL）
│   ├── 0001_baseline.sql       ← 现有全量 schema（pg_dump 生成）
│   └── 0002_permission.sql     ← bot_grants / trust_level 等新表  ⚠️ 历史设计，已废弃（R13）— 见 CURRENT MODEL
│
└── src/
    ├── main.rs                 ← 启动：读配置 → 建连接池 → 跑迁移 → 启动 axum
    ├── lib.rs                  ← crate 根，声明各模块
    ├── config.rs               ← 从环境变量读取所有配置
    ├── app_state.rs            ← 全局共享状态（所有 handler 都能拿到）
    ├── errors.rs               ← 统一错误类型，可直接转成 HTTP 响应
    ├── router.rs               ← 把所有路由组装成一个 axum Router（顶层，非 transport/ 下）
    │
    ├── api/                    ── 【入口层 · REST】只管收发，不含业务逻辑 ──
    │   ├── mod.rs
    │   ├── middleware.rs       ← JWT 验签（RS256），提取 user_id 注入请求
    │   ├── auth.rs             ← POST /api/v1/auth/*
    │   ├── channels.rs         ← GET/POST /api/v1/channels/*
    │   ├── messages.rs         ← GET/POST /api/v1/messages/*
    │   ├── bots.rs             ← GET/POST /api/v1/bots/*
    │   ├── files.rs / friends.rs / mcp.rs
    │   └── workbench.rs / workspace.rs / workspaces.rs / acp_capability.rs
    │
    ├── domain/                 ── 【业务层】纯逻辑，不依赖入口层 ──
    │   ├── auth.rs             ← 登录、注册、JWT 签发
    │   ├── messages.rs         ← 消息 CRUD、触发 bot 判断
    │   ├── sessions.rs / chains.rs / channel_seq.rs / mentions.rs
    │   ├── dms.rs / workspaces.rs / acp_capability.rs
    │   └── workbench_plugins.rs / workbench_templates.rs / seed.rs
    │
    ├── gateway/                ── 【Bot 连接 + 浏览器 WS 管理】（旧文档称 acp_bridge/）──
    │   ├── mod.rs
    │   ├── registry.rs         ← BotRegistry/BotLocator trait + InProcessBotLocator（DashMap<bot_id, Session>）
    │   ├── redis_registry.rs   ← Redis 实现（parked，未装配，备 R1-B/M4）
    │   ├── dispatcher.rs       ← 收到用户消息 → 建占位 → 派 task 给 bot
    │   ├── stream.rs           ← 收到 bot 的 delta/done → R1~R4 校验 + seq 盖戳 → fanout 给浏览器
    │   ├── workspace_rpc.rs    ← 远程工作区浏览 RPC
    │   ├── ws/                 ← WS 服务端
    │   │   ├── browser.rs      ← /ws  （浏览器单连接，subscribe/unsubscribe）
    │   │   └── agent_bridge.rs ← /ws/agent-bridge/control|data  （bot 连接）
    │   └── realtime/           ── 浏览器 WS fan-out ──
    │       ├── fanout.rs       ← Fanout trait + InProcessFanout（DashMap，本期用这个）
    │       ├── redis_fanout.rs ← Redis 实现（parked）
    │       ├── manager.rs      ← ConnectionManager：channel_id → 哪些连接订阅了（成员资格 LRU 缓存）
    │       └── frame.rs        ← 线协议帧的序列化（加外层信封、盖 seq）
    │   （注：permission.rs 从未存在——写权限=channel role，见 CURRENT MODEL）
    │
    ├── resource/               ── 【resource_req 分发】（旧文档置于 acp_bridge/resource/）──
    │   ├── mod.rs              ← 入口分发（match resource 字段，鉴权=channel role）
    │   ├── channel_info.rs / members.rs / messages.rs
    │   ├── files.rs           ← channel.files* + stage/realize
    │   ├── fs.rs              ← fs.ls/read/write/edit/append/rm/mv（取代旧 memory.rs）
    │   ├── activity.rs        ← channel.activity.read / channel.messages.index
    │   └── context.rs         ← 聚合查询
    │   （注：memory.rs 不存在——memory_entries 表已 DROP，改用 fs.* / context_files，见 CURRENT MODEL）
    │
    └── infra/                  ── 【基础设施】外部依赖封装 ──
        ├── db/                ← sqlx PgPool 初始化 + models
        ├── s3.rs              ← S3 上传/下载（aws-sdk-s3）
        └── crypto.rs          ← botToken 哈希验证（sha2）
```

> 与旧版命名的对照（详见 DATA_FLOW_AND_REFACTOR_PLAN §1.1 映射表）：
> `transport/router.rs` → `src/router.rs`；`transport/rest/*` → `src/api/*`；
> `transport/ws/*` → `src/gateway/ws/*`；`acp_bridge/{registry,dispatcher,stream}` →
> `src/gateway/{registry,dispatcher,stream}.rs`；`realtime/*` → `src/gateway/realtime/*`；
> `acp_bridge/resource/*` → `src/resource/*`；WS 路径 `/ws/acp-bridge/*` 实际为 `/ws/agent-bridge/*`。

---

## 二、层与层之间的依赖方向

```
                 ┌─────────────────────────────────────────┐
                 │            api/  +  gateway/ws/            │
                 │   api/*  ·  ws/browser  ·  ws/agent_bridge│
                 └──────────────────┬──────────────────────┘
                    调用                      调用
          ┌─────────────┘                      └──────────────┐
          ▼                                                    ▼
┌──────────────────┐                              ┌───────────────────┐
│    domain/        │                              │  gateway/         │
│  auth · messages  │◀─────────────────────────────│  dispatcher       │
│  sessions · seq   │     gateway/resource 调 domain│  stream           │
└────────┬─────────┘     查消息/成员（鉴权=role）   │  resource/*       │
         │ 调用                                    └────────┬──────────┘
         ▼                                                  │ 广播
┌──────────────────┐                              ┌─────────▼──────────┐
│     infra/        │                              │  gateway/realtime/ │
│  db · s3          │                              │  fanout · manager  │
│  crypto           │                              │  frame             │
└──────────────────┘                              └────────────────────┘

规则：箭头只能向下或向右，不能反向。
domain 不知道入口层存在；infra 不知道 domain 存在。
```

---

## 三、全局共享状态（AppState）

所有 handler 都通过 axum 的 extractor 拿到这个结构体：

```
AppState
  ├── db_pool        PgPool           ← sqlx 连接池，所有 DB 操作用这个
  ├── config         Config           ← JWT 公私钥、S3 配置、端口等
  ├── fanout         Arc<dyn Fanout>  ← 广播给浏览器（可替换实现）
  └── bot_locator    Arc<dyn BotLocator> ← 派发给 bot（可替换实现）
```

`fanout` 和 `bot_locator` 用 trait object——本期填入进程内实现，
未来换成 Redis/NATS 实现时只改 `main.rs` 里的一行初始化代码，其余不变。

---

## 四、一次请求的完整路径

### 4-A：用户发消息（REST）

```
浏览器
  │  POST /api/v1/channels/{id}/messages
  ▼
api/middleware.rs                   ← 验 JWT，提取 user_id
  ▼
api/messages.rs                     ← 解析请求体，调 domain
  ▼
domain/messages.rs
  ├── infra/db  写消息到 PG
  ├── state.fanout.broadcast()      ← 实时推给订阅该频道的浏览器
  └── 判断是否触发 bot
        └── gateway/dispatcher.rs
              ├── infra/db  建占位消息（is_partial=true）
              └── state.bot_locator.dispatch_task()  ← 发 task 帧给 bot
```

### 4-B：Bot 流式回复（Agent Bridge data WS）

```
Bot（外置 ACP agent / connector）
  │  data WS 发 delta{msg_id, delta}
  ▼
gateway/ws/agent_bridge.rs        ← 收帧，识别 type="delta"
  ▼
gateway/stream.rs
  ├── R1: 校验 msg_id 所有权（PG 查 Message.sender_id == bot_id）
  ├── R2: 忽略 bot 自报 seq，由 Backend 盖戳
  ├── R3: 确认是同一占位（不新建）
  └── R4: 占位未 finalize → 允许下发
        └── state.fanout.broadcast()  ← 推给订阅频道的所有浏览器
              （⚠️ delta 不落库——只 fan-out，可丢；靠终态 done 全量自愈，见 WIRE §4.2。
                旧文档此处写「infra/db 追加 delta 内容」有误，已订正。）
```

### 4-C：浏览器订阅频道（WS）

```
浏览器
  │  WS 连接 /ws，发 {type:"auth", token}
  ▼
gateway/ws/browser.rs
  ├── 验 JWT → 拿到 user_id
  └── 注册到 gateway/realtime/manager.rs（user_id → 这条连接）

浏览器发 {type:"subscribe", channel_id}
  ├── gateway/realtime/manager.rs  查成员资格（DB + 进程内 LRU 缓存）
  └── 注册到 manager（channel_id → 这条连接加入订阅列表）

此后 fanout.broadcast(channel_id, frame)
  └── manager 找到所有订阅该频道的连接 → 各自的发送队列入队
```

### 4-D：Bot resource 请求（读记忆）

> ⚠️ 整节为历史设计，已废弃 — 见 CURRENT MODEL。`channel.memory` / `channel.memory.update`
> 动词指向已 DROP 的 `MemoryEntry`（`memory_entries`）表，现改用 `fs.*` 文件树；写操作不再经
> `bot_grants` 的 `permission::evaluate()`，授权唯 channel-role。

```
Bot
  │  data WS 发 resource_req{resource:"channel.memory", params:{...}}
  ▼
gateway/ws/agent_bridge.rs
  ▼
resource/mod.rs                   ← match resource 字段，分发（鉴权=channel role）
  ▼
resource/fs.rs                    ← 读操作：只验频道成员（旧 memory.rs 已不存在）
  ├── infra/db  查 MemoryEntry
  └── 返回 resource_res{ok:true, data:{entries:[...]}}

（旧设计中的写操作 channel.memory.update —— 以下 permission.rs / bot_grants 流程
  从未在现行代码落地，写权限实际只过 channel-role：）
  ├── permission.rs  evaluate("channel:memory","write")  ⚠️ 文件不存在
  │     └── infra/db  查 bot_grants，deny-wins 逻辑       ⚠️ 表无写入
  ├── 无 grant → 发 permission_request 审批帧
  └── 有 grant → infra/db 写入，返回 resource_res
```

---

## 五、两个可替换接口（trait）

这是单实例→多实例的关键隔离点：

```rust
// gateway/realtime/fanout.rs
trait Fanout {
    // 广播给订阅某频道的所有浏览器连接
    async fn broadcast_channel(&self, channel_id: Uuid, frame: WireFrame);
    // 广播给某用户的所有连接（未读通知等）
    async fn broadcast_user(&self, user_id: Uuid, frame: WireFrame);
}

// 本期实现：进程内 DashMap
struct InProcessFanout {
    channels: DashMap<Uuid, Vec<Sender<WireFrame>>>,
    users:    DashMap<Uuid, Vec<Sender<WireFrame>>>,
}

// 未来多实例：接 Redis pub/sub，只改这里
struct RedisFanout { redis: RedisClient }
```

```rust
// gateway/registry.rs
trait BotLocator {
    // 向某个 bot 发 task 帧（control WS）
    async fn dispatch_task(&self, bot_id: Uuid, task: TaskFrame) -> bool;
    // 向某个 bot 发 data 帧（data WS）
    async fn send_data(&self, bot_id: Uuid, frame: DataFrame) -> bool;
}

// 本期实现：进程内 DashMap<bot_id, BotSession>
// 未来：一致性哈希 + 跨实例路由
```

---

## 六、关键数据结构（只看形状，不看实现）

```
Config              ← 启动时从 env 读取，之后只读
  jwt_private_key / jwt_public_key
  database_url
  s3_endpoint / s3_bucket
  smtp_host

WireFrame           ← 发给浏览器的标准帧（WIRE_PROTOCOL §4）
  v: 1
  scope: "channel" | "user"
  channel_id?
  type: "message" | "message_stream" | "message_done" | ...
  seq?              ← 流式帧才有，由 Backend 盖戳
  data: serde_json::Value   ← 不解析内容，原样转发

BotGrant            ← 对应 bot_grants 表   ⚠️ 历史设计，已废弃（R13）— 见 CURRENT MODEL
  code / bot_id / scope_type / scope_id
  resource / actions / effect
  expires_at / revoked

EvaluationResult    ← permission::evaluate() 的返回值   ⚠️ 历史设计，已废弃 — 授权唯 channel-role，见 CURRENT MODEL
  effect: Allow | Deny
  grant?            ← 命中的是哪条 grant（用于审计）
  reason?           ← Deny 时的原因
```

---

## 七、与 Python 侧的边界

```
Rust Backend（本文范围）         Python Agent Service（独立容器）
─────────────────────────        ────────────────────────────────
所有 HTTP REST 端点               bot 逻辑、LLM 调用、Memory/RAG
所有浏览器 WS 连接管理            通过 resource_req 访问平台数据
Agent Bridge WS 服务端            不直连 DB
权限引擎（Grant evaluate）        ⚠️ 历史设计，已废弃 — 授权唯 channel-role，见 CURRENT MODEL
DB / S3 / JWT / SMTP
          │                                │
          └──── Agent Bridge WS ───────────┘
               control: task 派发
               data:    delta/done/resource_req
```

Python Agent Service 对 Rust Backend 来说就是"一个普通的外置 ACP bot"，
用 botToken 鉴权，走 Agent Bridge 协议，没有任何特权。
