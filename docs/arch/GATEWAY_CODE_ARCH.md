# Gateway 代码架构

> 语言：Rust · 框架：axum + tokio + sqlx
> 本文只讲结构，不讲实现细节。

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
│   └── 0002_permission.sql     ← bot_grants / trust_level 等新表
│
└── src/
    ├── main.rs                 ← 启动：读配置 → 建连接池 → 跑迁移 → 启动 axum
    ├── config.rs               ← 从环境变量读取所有配置
    ├── app_state.rs            ← 全局共享状态（所有 handler 都能拿到）
    ├── errors.rs               ← 统一错误类型，可直接转成 HTTP 响应
    │
    ├── transport/              ── 【入口层】只管收发，不含业务逻辑 ──
    │   ├── router.rs           ← 把所有路由组装成一个 axum Router
    │   ├── middleware/
    │   │   ├── auth.rs         ← JWT 验签（RS256），提取 user_id 注入请求
    │   │   ├── cors.rs
    │   │   └── request_id.rs   ← 给每个请求分配 trace ID
    │   ├── rest/               ← REST handler（薄层，调 domain，返回 JSON）
    │   │   ├── auth.rs         ← POST /api/v1/auth/*
    │   │   ├── channels.rs     ← GET/POST /api/v1/channels/*
    │   │   ├── messages.rs     ← GET/POST /api/v1/messages/*
    │   │   └── bots.rs         ← GET/POST /api/v1/bots/*
    │   └── ws/
    │       ├── browser.rs      ← /ws  （浏览器单连接，subscribe/unsubscribe）
    │       └── acp_bridge.rs ← /ws/acp-bridge/control|data  （bot 连接）
    │
    ├── domain/                 ── 【业务层】纯逻辑，不依赖 transport ──
    │   ├── auth.rs             ← 登录、注册、JWT 签发
    │   ├── channels.rs         ← 频道 CRUD、成员管理
    │   ├── messages.rs         ← 消息 CRUD、触发 bot 判断
    │   └── bots.rs             ← bot CRUD、token 验证
    │
    ├── realtime/               ── 【浏览器 WS 管理】fan-out 给在线用户 ──
    │   ├── fanout.rs           ← Fanout trait（可替换实现）
    │   │                          + InProcessFanout（DashMap，本期用这个）
    │   ├── connection.rs       ← 单条 WS 连接的读写循环、心跳、背压
    │   ├── manager.rs          ← 连接注册表：channel_id → 哪些连接订阅了
    │   └── frame.rs            ← 线协议帧的序列化（加外层信封、盖 seq）
    │
    ├── acp_bridge/           ── 【Bot 连接管理】ACP 协议 ──
    │   ├── registry.rs         ← BotLocator trait（可替换实现）
    │   │                          + InProcessBotLocator（DashMap<bot_id, Session>）
    │   ├── dispatcher.rs       ← 收到用户消息 → 建占位 → 派 task 给 bot
    │   ├── stream.rs           ← 收到 bot 的 delta/done → R1~R4 校验 → fanout 给浏览器
    │   ├── permission.rs       ← Grant 表查询 + evaluate()（deny-wins）
    │   └── resource/           ← resource_req 分发给各子 handler
    │       ├── mod.rs          ← 入口分发（match resource 字段）
    │       ├── channel_info.rs
    │       ├── members.rs
    │       ├── messages.rs
    │       ├── files.rs
    │       ├── memory.rs       ← 写操作调 permission::evaluate()
    │       └── context.rs      ← 聚合查询
    │
    └── infra/                  ── 【基础设施】外部依赖封装 ──
        ├── db/
        │   ├── pool.rs         ← sqlx PgPool 初始化
        │   └── models.rs       ← 与 DB 表对应的 Rust 结构体（纯数据）
        ├── storage.rs          ← S3 上传/下载（aws-sdk-s3）
        └── crypto.rs           ← botToken 哈希验证（sha2）
```

---

## 二、层与层之间的依赖方向

```
                 ┌─────────────────────────────────────────┐
                 │              transport/                   │
                 │   rest/*  ·  ws/browser  ·  ws/acp_bridge│
                 └──────────────────┬──────────────────────┘
                    调用                      调用
          ┌─────────────┘                      └──────────────┐
          ▼                                                    ▼
┌──────────────────┐                              ┌───────────────────┐
│    domain/        │                              │  acp_bridge/    │
│  auth · channels  │◀─────────────────────────────│  dispatcher       │
│  messages · bots  │        acp_bridge 调 domain │  stream           │
└────────┬─────────┘        查消息/成员/权限        │  resource/*       │
         │ 调用                                    └────────┬──────────┘
         ▼                                                  │ 广播
┌──────────────────┐                              ┌─────────▼──────────┐
│     infra/        │                              │    realtime/       │
│  db · storage     │                              │  fanout · manager  │
│  crypto           │                              │  connection · frame│
└──────────────────┘                              └────────────────────┘

规则：箭头只能向下或向右，不能反向。
domain 不知道 transport 存在；infra 不知道 domain 存在。
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
transport/middleware/auth.rs        ← 验 JWT，提取 user_id
  ▼
transport/rest/messages.rs          ← 解析请求体，调 domain
  ▼
domain/messages.rs
  ├── infra/db  写消息到 PG
  ├── state.fanout.broadcast()      ← 实时推给订阅该频道的浏览器
  └── 判断是否触发 bot
        └── acp_bridge/dispatcher.rs
              ├── infra/db  建占位消息（is_partial=true）
              └── state.bot_locator.dispatch_task()  ← 发 task 帧给 bot
```

### 4-B：Bot 流式回复（Agent Bridge data WS）

```
Bot（Python Agent Service）
  │  data WS 发 delta{msg_id, content}
  ▼
transport/ws/acp_bridge.rs        ← 收帧，识别 type="delta"
  ▼
acp_bridge/stream.rs
  ├── R1: 校验 msg_id 所有权（PG 查 Message.sender_id == bot_id）
  ├── R2: 忽略 bot 自报 seq，由 Backend 盖戳
  ├── R3: 确认是同一占位（不新建）
  └── R4: 占位未 finalize → 允许写入
        ├── infra/db  追加 delta 内容
        └── state.fanout.broadcast()  ← 推给订阅频道的所有浏览器
```

### 4-C：浏览器订阅频道（WS）

```
浏览器
  │  WS 连接 /ws，发 {type:"auth", token}
  ▼
transport/ws/browser.rs
  ├── 验 JWT → 拿到 user_id
  └── 注册到 realtime/manager.rs（user_id → 这条连接）

浏览器发 {type:"subscribe", channel_id}
  ├── realtime/manager.rs  查成员资格（DB + 进程内 LRU 缓存）
  └── 注册到 manager（channel_id → 这条连接加入订阅列表）

此后 fanout.broadcast(channel_id, frame)
  └── manager 找到所有订阅该频道的连接 → 各自的发送队列入队
```

### 4-D：Bot resource 请求（读记忆）

```
Bot
  │  data WS 发 resource_req{resource:"channel.memory", params:{...}}
  ▼
transport/ws/acp_bridge.rs
  ▼
acp_bridge/resource/mod.rs        ← match resource 字段，分发
  ▼
acp_bridge/resource/memory.rs     ← 读操作：只验频道成员
  ├── infra/db  查 MemoryEntry
  └── 返回 resource_res{ok:true, data:{entries:[...]}}

（若是写操作 channel.memory.update）
  ├── acp_bridge/permission.rs  evaluate("channel:memory","write")
  │     └── infra/db  查 bot_grants，deny-wins 逻辑
  ├── 无 grant → 发 permission_request 审批帧
  └── 有 grant → infra/db 写入，返回 resource_res
```

---

## 五、两个可替换接口（trait）

这是单实例→多实例的关键隔离点：

```rust
// realtime/fanout.rs
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
// acp_bridge/registry.rs
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

BotGrant            ← 对应 bot_grants 表
  code / bot_id / scope_type / scope_id
  resource / actions / effect
  expires_at / revoked

EvaluationResult    ← permission::evaluate() 的返回值
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
权限引擎（Grant evaluate）
DB / S3 / JWT / SMTP
          │                                │
          └──── Agent Bridge WS ───────────┘
               control: task 派发
               data:    delta/done/resource_req
```

Python Agent Service 对 Rust Backend 来说就是"一个普通的外置 ACP bot"，
用 botToken 鉴权，走 Agent Bridge 协议，没有任何特权。
