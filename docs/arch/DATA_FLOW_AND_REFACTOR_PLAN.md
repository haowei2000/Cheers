# 数据流全景与改造计划

> 版本：v1.1（2026-06-18）—— R1 决策落地：方案 A（进程内）
> 性质：**代码现状快照 + 改造提案**。
> 与其他设计文档的区别：本文以**代码实际行为**为准绳（基于 `main` 分支 cc538b0 + 当前未提交改动），
> 凡与设计文档冲突之处都在 [§2.6 差异表](#26-协议文档-vs-代码差异表) 显式标注。
> 阅读顺序建议：先 [§3 数据流](#三端到端数据流)，再 [§5 改造项](#五改造项清单)。

---

## 〇、TL;DR

- 系统是**三面协议**结构：浏览器面（WIRE v1，单 WS 复用）、Bot 面（Agent Bridge，control + data 双 WS）、资源面（resource_req/res 子协议，挂在 data WS 上）。
- 状态真相只有 PG；fan-out / bot 路由 / 流注册表全部**进程内**（R1-A 已落地）；**写后投递**（终态先落库再广播）+ **channel_seq 事件时钟** + **REST 补齐** 共同构成自愈闭环。
- ~~当前最大问题：**多实例改造只做了一半**~~ **已解决（R1-A）**：`main.rs` 装配回退为 `InProcessFanout` + `InProcessBotLocator`，与全进程内的流注册表/取消令牌一致；Redis 不再是 fan-out 路径的启动依赖。`redis_fanout.rs` / `redis_registry.rs` 保留编译（`#[allow(dead_code)]`），作为未来多实例（R1-B / M4）的起点。
- 次大问题：**终态帧背压破约**（fanout 入队失败静默丢终态帧）、**流式热路径每帧 2 次 PG 查询**、**测试真空**。
- 改造项共 13 项（R1–R13），见 [§5](#五改造项清单)；建议顺序：R2 收尾 → R4 测试安全网 → R1 部署形态决策 → R3/R5/R6 修正 → 其余按需。

---

## 一、组件拓扑（代码现状）

```
┌─ 浏览器 ─────────────┐
│ React + Vite + zustand│
│ frontend/ (~1.8k 行)  │
└──────┬───────────────┘
       │ REST /api/v1/*  +  WS /ws        （同端口 :8000，JWT RS256/EdDSA）
       ▼
┌─ Rust Backend（server/，~11.5k 行）────────────────────────────────┐
│  api/        REST handler（薄层）→ 调 domain                        │
│  domain/     业务逻辑：messages / sessions / chains / channel_seq   │
│              / mentions / auth / acp_capability                     │
│  gateway/                                                           │
│    ws/browser.rs        浏览器 WS（auth → subscribe → fan-out 出口） │
│    ws/agent_bridge.rs   Bot control/data WS 服务端                  │
│    dispatcher.rs        task 派发（幂等占位 + task 帧）               │
│    stream.rs            delta/done 回流（R1–R4 + seq 盖戳）          │
│    registry.rs          BotRegistry/BotLocator trait + 进程内实现    │
│    redis_registry.rs    Redis 实现（当前 main.rs 装配的是这个）       │
│    realtime/            Fanout trait + InProcess/Redis 实现          │
│                         + ConnectionManager（成员资格 LRU 缓存）      │
│  resource/   resource_req 分发器 + 各资源 handler（鉴权=channel role）│
│  infra/      db 连接池 / models / crypto                            │
└──────┬──────────────────────────┬───────────────────────────────────┘
       │                          │ WS /ws/agent-bridge/{control,data}
       ▼                          ▼          （botToken 鉴权）
  PG（状态真相）          ┌───────┴────────────────────────┐
  Redis（路由/广播，易失） │ packages/agentnexus-mcp-server  │  stdio MCP ↔ resource_req 桥
  S3/rustfs（文件）       │ packages/agentnexus-acp-        │  本地 daemon/connector，
  SMTP（邮件码）          │   connector-rs（~8k 行）        │  ACP agent ↔ Agent Bridge
                          └────────────────────────────────┘
                                   ▲
                          Claude / Codex / OpenCode 等外部 agent
```

### 1.1 模块映射表（设计文档命名 vs 实际目录）

| GATEWAY_CODE_ARCH.md 写的 | 代码实际位置 |
|---|---|
| `transport/router.rs` | `src/router.rs` |
| `transport/rest/*` | `src/api/*` |
| `transport/ws/*` | `src/gateway/ws/*` |
| `acp_bridge/{registry,dispatcher,stream}` | `src/gateway/{registry,dispatcher,stream}.rs` |
| `acp_bridge/permission.rs` | **不存在**（写权限=channel role，见差异表 #2） |
| `acp_bridge/resource/memory.rs` | **不存在**（实际是 `resource/fs.rs` 等） |
| `realtime/*` | `src/gateway/realtime/*` |

---

## 二、协议栈

### 2.1 三个协议面

| 面 | 端点 | 鉴权 | 承载 |
|---|---|---|---|
| 浏览器面（WIRE v1） | `GET /ws` | 首帧 `{type:"auth",token}`（10s 超时，关闭码 4401） | 订阅管理 + 事件帧下行 |
| Bot control | `GET /ws/agent-bridge/control` | botToken（header 或首帧） | task 下发、ready、session 控制、config 上报 |
| Bot data | `GET /ws/agent-bridge/data` | botToken | delta/done 回流、resource_req/res、send/reply、resume |
| REST | `/api/v1/*` | JWT Bearer | 全量 CRUD + 断线补齐 |

### 2.2 浏览器面帧表（`gateway/ws/browser.rs`）

**客户端 → Backend（控制帧）**

| type | 字段 | 语义 |
|---|---|---|
| `auth` | `token` | 首帧鉴权；已鉴权后再发 = token 续期 |
| `subscribe` | `channel_id` | 订阅频道（查成员资格，幂等） |
| `unsubscribe` | `channel_id` | 退订 |
| `ping` | — | 应用层心跳 |

**Backend → 客户端（控制回执）**：`auth_ok{user_id}` / `auth_err{reason}` / `subscribed` / `unsubscribed` / `pong` / `error{detail}`

**Backend → 客户端（事件帧，WireFrame 信封，`realtime/frame.rs`）**

```jsonc
{
  "v": 1,
  "scope": "channel" | "user",
  "channel_id": "…",          // scope=channel 时存在
  "type": "message" | "message_stream" | "message_done" | "message_deleted",
  "seq": 42,                  // 仅流式帧（message_stream），Backend 盖戳
  "data": { … }               // 对实时层不透明，原样转发
}
```

- **终态帧**：`message` / `message_done` / `message_deleted` —— 必须先落 PG 再广播，承诺不丢（见不变量 I6 及其当前破约 R3）。
- **流式帧**：`message_stream` —— 不落库、可丢，靠 `message_done` 全量自愈。
- 关闭码：`4401` 鉴权失败 / `4403` 非频道成员 / `4408` 背压关闭。

### 2.3 Bot 面帧表（`gateway/ws/agent_bridge.rs`）

**control WS（bot → Backend）**：`ping` / `ready` / `runtime_session_control_ack` / `config_status` / `config_options` / `config_option_status`

**control WS（Backend → bot）**：`task` 帧（结构见 §3 流程 3）、`runtime_session_control`；关闭码 `CLOSE_SUPERSEDED`（新连接顶替旧连接）。

**data WS（bot → Backend）**

| type | 语义 | 处理入口 |
|---|---|---|
| `delta` | 流式增量 `{msg_id, delta}` | `stream::handle_delta`（R1–R4） |
| `done` | 终态 `{msg_id, content, file_ids?, mention_ids?, session_id?…}` | `stream::handle_done` |
| `error` | 任务失败上报 | finalize 占位为错误文案 |
| `send` / `reply` | bot 主动发消息（非 task 回流） | `handle_terminal_frame` → ack |
| `resource_req` | 资源访问 `{req_id, resource, params}` | `resource::dispatch` |
| `permission_request` | 发起审批消息 | 落库 + fan-out |
| `session_update` | 上报 provider_session_id/metadata | `stream::handle_session_update` |
| `resume` | 重连后续传声明 | 恢复流上下文 |
| `ping` | 心跳 | pong |

**data WS（Backend → bot）**：`resource_res{req_id, ok, data | code+error}`、`terminal_ack` / `send_ack`、转发帧。

### 2.4 resource 子协议词表（`resource/mod.rs`，代码为准）

| 读（频道成员即可） | 写（channel role ∈ owner/admin/member） |
|---|---|
| `channel.info` `channel.members` `channel.messages` `channel.files` `channel.files.read` `channel.context` `channel.activity.read` `channel.messages.index` `channel.messages.by-seq` `fs.ls` `fs.read` | `channel.messages.create` `channel.files.create` `fs.write` `fs.edit` `fs.append` `fs.rm` `fs.mv` |

错误码：`UNKNOWN_RESOURCE` / `NOT_MEMBER` / `PERMISSION_DENIED` / `NOT_FOUND` / `INTERNAL_ERROR`。

鉴权模型（代码现状）：`Principal{bot|user}` → `authorize_channel_read`（查 `channel_memberships.role`）→ 写操作再过 `role_can_write`。**没有 Grant/trust_level 引擎**（见差异表 #2）。

### 2.5 接入桥

- **agentnexus-mcp-server**（stdio）：把 MCP `tools/call` 一对一翻译成 `resource_req`（`build_resource_call`），让 Claude/Codex/Cursor 等 MCP 宿主无感接入。无独立状态。
- **agentnexus-acp-connector-rs**：本地 daemon。`bridge.rs` 管双 WS 连接/重连退避/能力协商，`bridge_runtime.rs`（2467 行，改造对象 R11）跑 task→ACP session 的运行时循环，`loopback.rs` 本地回环默认拒绝（commit 9312fdc）。

### 2.6 协议文档 vs 代码差异表

| # | 文档说 | 代码实际 | 处置建议 |
|---|---|---|---|
| 1 | ARCHITECTURE_OVERVIEW §二之二 / WIRE §8：**单实例、进程内 fan-out、无消息总线** | ~~`main.rs` 硬接 `RedisFanout` + `RedisBotRegistry`~~ **已对齐（R1-A）**：`main.rs` 装配 `InProcessFanout` + `InProcessBotLocator`，Redis 不再是 fan-out 路径启动依赖 | ✅ 已解决，代码与文档一致 |
| 2 | BOT_PERMISSION.md：Grant + 覆盖 + 审批 + trust_level 四级 | `bot_grants`/`trust_level` 在代码**零引用**；写权限 = channel role（commit 85290a7 有意统一） | R13：在 BOT_PERMISSION.md 顶部标注"现状=role 模型，Grant 体系未实现/已搁置" |
| 3 | GATEWAY_CODE_ARCH §一：`transport/`、`acp_bridge/` 目录 | 实际为 `api/`、`gateway/`（见 §1.1 映射表） | R13：按代码重写该文档 |
| 4 | GATEWAY_CODE_ARCH §4-B："infra/db 追加 delta 内容" | delta **不落库**（只 fan-out；WIRE §4.2 才是对的） | R13：订正 |
| 5 | GATEWAY_CODE_ARCH §五：`InProcessFanout` 为本期实现 | ~~装配的是 RedisFanout~~ **已对齐（R1-A）**：装配即 `InProcessFanout` | ✅ 已解决 |
| 6 | AGENT_BRIDGE_RESOURCE：资源词表早期版本 | 代码已扩充 mesh step 6 词表（`fs.*`、`activity`、`by-seq`） | R13：以 §2.4 为准刷新 |

---

## 三、端到端数据流

### 流程 1：浏览器连接与订阅

```
浏览器                     browser.rs                ConnectionManager
  │ WS 升级 /ws               │                           │
  │── {type:auth, token} ────▶│ verify_token (RS256)      │
  │◀─ {type:auth_ok} ─────────│ on_connect(user,conn,tx)──▶ 注册 user 级发送端
  │── {type:subscribe, ch} ──▶│ subscribe() ──────────────▶ 成员资格：LRU(4096,TTL) 命中?
  │                           │                           │   miss → 查 channel_memberships
  │◀─ {type:subscribed} ──────│                           │ 通过 → 注册 channel 级发送端
  │              （非成员 → 关闭码 4403）                   │
```

- 每连接一条 `mpsc::channel<WireFrame>(256)` 发送队列；WS 读循环与队列消费在同一 `tokio::select!`。
- 鉴权窗口 10s（`AUTH_TIMEOUT`），期间只接受 `auth` 帧。

### 流程 2：用户发消息（REST → 落库 → 广播 → 触发 bot）

入口：`POST /api/v1/channels/{id}/messages` → `domain/messages.rs::create_message`

```
 ① 校验文件归属（如有 file_ids）
 ② 校验发送者频道成员资格（channel_memberships）
 ③ 校验 mention_ids（必须是该频道成员）           domain/mentions.rs
 ④ ┌─ 事务 ─────────────────────────────────┐
   │ channel_seq::allocate(tx, channel)      │ ← UPDATE channels SET next_seq=next_seq+1
   │ INSERT messages (born final,            │   …RETURNING（行锁下分配，I2）
   │   is_partial=FALSE, channel_seq=seq)    │
   │ mentions::insert_batch                  │
   └─ COMMIT ───────────────────────────────┘
 ⑤ fanout.broadcast_channel("message" 终态帧)     ← 写后投递（I1）：④成功才到⑤
 ⑥ resolve_bot_triggers(mentions) → 命中 bot 列表
 ⑦ 对每个 bot：
      acquire_scope_session(workspace 作用域)      domain/sessions.rs
      dispatcher::dispatch(...)                    → 流程 3
```

### 流程 3：task 派发（幂等占位）

`gateway/dispatcher.rs::dispatch`：

```
 ① placeholder_id = UUIDv5(NAMESPACE_DNS, "{trigger_msg_id}:{bot_id}")   ← 确定性（I4）
 ② check_idempotency：占位已存在且 in-progress/done → 跳过        ⚠ 与③非原子，R5
 ③ INSERT 占位 (is_partial=TRUE, channel_seq=NULL) ON CONFLICT DO NOTHING
 ④ StreamRegistry.register(StreamEntry{msg_id,bot_id,channel,task_id,session_id})
                                                   ⚠ 进程内 DashMap，R1 关键点
 ⑤ fanout 占位气泡（"message" 终态帧，is_partial=true, channel_seq=null）
 ⑥ load_task_context（触发消息全文 + 发送者名 + 附件）
 ⑦ bot_locator.dispatch_task(bot_id, task帧)
      └ Redis 路线：check_online(SET …:online, TTL 30s) → PUBLISH …:control，
        以 PUBLISH 订阅者数 >0 判定 delivered
 ⑧ 未送达 → mark_placeholder_failed（finalize 为 "[bot offline]"，此时才耗 seq）
            → fanout message_done → 清理注册表 → finalize session
```

**task 帧结构**（`build_task_frame`）：

```jsonc
{
  "type": "task", "v": 1,
  "task_id": "…", "channel_id": "…",
  "trigger_msg_id": "…", "trigger_seq": 7, "depth": 0,
  "placeholder_msg_id": "…",                       // bot 必须回写这个占位（R3 规则）
  "provider_session_key": "agentnexus:workspace:{ws}:bot:{bot}",
  "session_id": "…", "trigger": "user_message" | "bot_message",
  "session_policy": { "on_missing":"create", "on_paused":"resume", "after_task":"keep_active" },
  "trigger_message": { "msg_id","user","sender_name","text","timestamp","msg_type","in_reply_to_msg_id" },
  "attachments": [{ "file_id": "…" }],
  "session": { "id","provider_session_key","task_scope_id" },
  "enqueued_at": "RFC3339"
}
```

### 流程 4：bot 流式回流（delta → done）

`gateway/stream.rs`。完整时序（含浏览器侧）：

```
Bot(connector)        agent_bridge.rs        stream.rs                  PG          浏览器
  │── delta{msg_id,δ} ──▶ handle_data ──▶ handle_delta
  │                                        ① 注册表查 StreamEntry（R3：不存在即拒）
  │                                        ② mark_session_alive ───────▶ UPDATE     ⚠ 每帧1次，R6
  │                                        ③ verify_ownership ─────────▶ SELECT     ⚠ 每帧1次，R6
  │                                        │   （R1：sender_id==bot? 未finalize?）
  │                                        ④ R4：entry.finalized? → 拒
  │                                        ⑤ seq = next_seq(msg_id)（R2：Backend盖戳）
  │                                        ⑥ fanout "message_stream"{seq,δ} ────────▶ 增量渲染
  │
  │── done{msg_id,content} ▶ handle_data ─▶ handle_done
  │                                        ① mark_session_alive / 解析 session 标识
  │                                        ② R1 所有权 + mention 校验
  │                                        ③ 内存先置 finalized=true（挡并发迟到 delta）
  │                                        ④ ┌─ 事务 ──────────────────────────┐
  │                                        │  │ channel_seq::allocate（此刻才耗seq）│
  │                                        │  │ UPDATE messages SET content,      │
  │                                        │  │   is_partial=FALSE, channel_seq   │
  │                                        │  │   WHERE is_partial=TRUE AND       │
  │                                        │  │   channel_seq IS NULL   ← 二次幂等 │
  │                                        │  │ mentions::replace_batch           │
  │                                        │  └─ COMMIT ─────────────────────────┘
  │                                        ⑤ fanout "message_done" 终态全量帧 ──────▶ 覆盖流式内容（自愈）
  │                                        ⑥ registry.remove(msg_id)
  │                                        ⑦ depth < MAX_BOT_REPLY_DEPTH
  │                                        │    → chains::trigger_bot_replies → 流程 5
  │                                        ⑧ finalize session（五分支阶梯 ⚠ R9）
```

R1–R4 硬规则（ACP_CONNECTION_MODEL §8，代码已实现）：

| 规则 | 含义 | 实现点 |
|---|---|---|
| R1 | msg_id 所有权以 PG 为准，不信内存 | `verify_ownership`：`sender_id == bot_id` |
| R2 | seq 由 Backend 盖戳，忽略 bot 自报 | `StreamRegistry::next_seq`（AtomicU64） |
| R3 | 只能回写已注册占位，不得新建 | 注册表查不到即拒 |
| R4 | finalize 后拒绝迟到 delta | 内存 `finalized` 标志 + DB `is_partial` 双保险 |

### 流程 5：bot 链式回复（bot@bot）

`domain/chains.rs::trigger_bot_replies`：done 落库后解析**已校验的 mentions** 中的 bot 成员 → 对每个被 @ 的 bot 以 `depth+1` 走流程 3。环路防护：`depth ≥ MAX_BOT_REPLY_DEPTH` 截断（I5）；占位幂等键含 trigger_msg_id，同一触发不会重复派发。

### 流程 6：bot 主动操作（resource / send / reply / 审批）

```
Bot ── resource_req{req_id, resource, params} ──▶ resource::dispatch
        ① match resource → 子 handler（§2.4 词表）
        ② authorize_channel_read / authorize_channel_write（role 模型）
        ③ 读：直查 PG；写：channel.messages.create 走与流程 2 相同的
           落库+seq+fanout 路径（写后投递不旁路）
Bot ◀─ resource_res{req_id, ok, data | code+error} ──┘

Bot ── send / reply ──▶ handle_terminal_frame → 落库+seq → fanout → terminal_ack/send_ack
Bot ── permission_request ──▶ 落库为审批消息 → fanout 给频道
```

### 流程 7：Redis 实际路径（当前装配下每一帧的真实旅程）⚠

```
广播侧（fanout）：
  stream.rs ─ broadcast_channel ─▶ serde 序列化 ─▶ PUBLISH agentnexus:rt:channel:{id}
     ─▶ Redis ─▶ 本进程 psubscribe("agentnexus:rt:channel:*") 收到
     ─▶ serde 反序列化 ─▶ InProcessFanout 本地查订阅 ─▶ try_send 入连接队列

bot 路由侧（registry）：
  dispatcher ─▶ PUBLISH agentnexus:bot:{id}:control ─▶ Redis
     ─▶ 持有该 bot control WS 的实例 SUBSCRIBE 收到 ─▶ forward_loop ─▶ WS 下发
  在线判定：SET agentnexus:bot:{id}:online EX 30（心跳续期）+ PUBLISH 订阅者数
```

两个结构性问题（改造项 R1/R7 的依据）：

1. **单实例下纯开销**：每帧多付「序列化→Redis 往返→反序列化」，最终还是回到本进程的 InProcessFanout。
2. **firehose 订阅不可扩展**：`psubscribe agentnexus:rt:channel:*` 让**每个实例接收全平台所有频道的流量**再本地过滤，多实例时每实例负载 = 全网流量，水平扩容失义。
3. **进程内残留状态**：`StreamRegistry`（msg_id→流元信息 + seq 计数器）、`RedisBotRegistry.cancel_map`、supersede 信号都是 DashMap/oneshot。**两实例即坏**：REST 实例 A 注册流 → bot data WS 连在实例 B → delta 到 B 查不到注册表 → `"stream not registered"`，整条流式链路断。

### 流程 8：断线与恢复

**浏览器**：重连 → 重新 auth + subscribe → REST 按 `channel_seq` 拉缺口（`list_channel_messages_since_seq`）。流式期断线丢失的 delta 不补——`message_done` 终态全量自愈。
**Bot**：新 control 连接 → `bind_control` 发 supersede 信号顶掉旧连接（旧 WS 收 `CLOSE_SUPERSEDED`）；重连后发 `resume` 声明续传。占位幂等（I4）保证任务重投不产生重复气泡。
**Backend 重启**：注册表内存态全失——孤儿占位（is_partial=TRUE 永不 finalize）依赖 bot 重连后 done 重投或人工清理；这是单实例 SLA 的已接受代价（ARCHITECTURE_OVERVIEW §二之二），但**缺一个孤儿占位回收器**（并入 R4 测试与 R6 后续）。

---

## 四、系统不变量（改造红线）

任何改造不得破坏以下不变量；R4 的测试即按此清单展开：

| # | 不变量 | 实现锚点 |
|---|---|---|
| I1 | **写后投递**：终态帧必须先 COMMIT 再 fan-out；流式帧不落库 | `create_message` ④→⑤；`handle_done` ④→⑤ |
| I2 | **channel_seq 每频道 gap-free 连续**，分配必须在提交事务内、频道行锁下（seq 序 == 提交序）；弃用占位不耗 seq | `channel_seq::allocate`；done/failed 时才分配 |
| I3 | **R1–R4 回流规则**（见流程 4 表） | `stream.rs` |
| I4 | **占位幂等**：placeholder_id = UUIDv5(trigger_msg_id:bot_id)，重投收敛同一占位 | `derive_placeholder_id` |
| I5 | **bot 链深度上限**防环 | `MAX_BOT_REPLY_DEPTH` |
| I6 | **背压**：流式帧可丢；终态帧不丢，宁可断连让客户端走 REST 补齐 | ⚠ 当前在 fanout 入队层**破约**（R3） |
| I7 | **seq 盖戳唯一来源是 Backend** | `StreamRegistry::next_seq` |
| I8 | **bot 资源访问一律过成员资格**，写操作再过 role；bot 不直连 DB | `resource::authorize_*` |

---

## 五、改造项清单

> 编号 R1–R13。每项给：现状 → 问题 → 方案 → 涉及文件 → 验收标准。
> 优先级：P0 = 方向性/阻塞提交；P1 = 正确性；P2 = 热路径性能；P3 = 可维护性。

### R1 [P0] 部署形态二选一：回退进程内（推荐）或走完 Redis — ✅ **已决策：方案 A（进程内）**

> **决策（2026-06-18）**：选方案 A。`main.rs` 装配已改为 `InProcessFanout` + 单个 `InProcessBotLocator`（同时充当 BotRegistry 与 BotLocator，共享 DashMap）。Redis 连接已从启动流程移除，不再是 fan-out 路径硬依赖。`redis_fanout.rs` / `redis_registry.rs` / `ConnectionManager::new_with_redis` 以 `#[allow(dead_code)]` 保留编译，作为 R1-B / M4 起点。剩余验收（集成冒烟流程 2→4）随 R4-2 完成。

- **现状**：见流程 7。Redis fan-out + Redis bot 路由已装配，但流注册表/取消令牌/supersede 在进程内；文档定调单实例。
- **问题**：当前状态 = 单实例能力 + 多实例成本，且制造了"已支持多实例"的错觉。
- **方案 A（推荐）——回退进程内**：
  1. `main.rs` 装配改回 `InProcessFanout` + `InProcessBotLocator`（代码都在，`ConnectionManager::new` 进程内构造函数已备）；
  2. Redis 仅保留 bot 在线标记（或一并改为进程内注册表查询）；
  3. `redis_fanout.rs` / `redis_registry.rs` 保留编译但不装配，作为未来多实例的起点；
  4. 更新 ARCHITECTURE_OVERVIEW 部署模型节，与文档原定调对齐。
  - 推荐理由：当前单实例定调（HA 非本期目标）、立省每帧 Redis 往返与双序列化、消除假象；trait 边界已留好，未来切换不动协议。
- **方案 B——走完多实例**（如果近期确要 ≥2 实例）：
  1. `StreamRegistry` 迁 Redis：`HSET agentnexus:stream:{msg_id}`（entry 字段）+ `INCR …:seq`，TTL 兜底孤儿；
  2. `cancel_map`/supersede 改为 per-bot Redis 通道上的控制消息（实例只管本地 WS）；
  3. fan-out 放弃 `psubscribe *` firehose，改**按需 SUBSCRIBE**（本实例有订阅者的频道才订阅，退订时 UNSUBSCRIBE）——即 R7；
  4. 补跨实例集成测试（两进程 + 共享 Redis/PG，bot 连 A、REST 打 B）。
- **涉及**：`server/src/main.rs`、`gateway/realtime/*`、`gateway/redis_registry.rs`、`gateway/stream.rs`、ARCHITECTURE_OVERVIEW.md
- **验收**：方案 A——集成冒烟（流程 2→4 全链路）通过且 Redis 不再是启动依赖（fan-out 路径）；方案 B——两实例交叉路由测试通过。

### R2 [P0] 未提交 WIP 收尾

- **现状**：工作区有 bind_control/bind_data 竞态修复（`pending_data` 暂存、`BotCancelTokens` 命名槽、supersede_rx 区分显式信号与 channel 关闭）——方向正确。
- **问题**：遗留 4 处 `tracing::error!("BIND_DATA CALLED")` 级调试日志（`registry.rs:108-133`）。
- **方案**：删除或降为 `debug!`；为该竞态补一个单测（先 bind_data 后 bind_control，断言 data_tx 不丢）；提交。
- **验收**：`cargo build && cargo test` 通过；`git status` 干净。

### R3 [P1] 终态帧背压破约修复

- **现状**：`InProcessFanout::broadcast_*` 对每个订阅者 `let _ = tx.try_send(frame)`（`fanout.rs:96-103`）——队列满时**任何帧静默丢弃，包括终态帧**。browser.rs 的 4408 背压关闭只覆盖 `socket.send` 失败，覆盖不到入队失败。
- **问题**：违反 I6。慢消费者会永久错过 `message`/`message_done`，且连接不断开，客户端无从知道需要 REST 补齐——在线用户看到消息缺失直到手动刷新。
- **方案**：`try_send` 失败且 `is_terminal_frame` 时，向该连接发关闭信号（可在 ConnSender 加一个 `close_tx`，或入队一个特殊 Close 帧由写循环处理 4408 关闭）；流式帧维持静默丢弃。
- **涉及**：`gateway/realtime/fanout.rs`、`gateway/ws/browser.rs`
- **验收**：单测——填满队列后广播终态帧，断言连接被关闭而非静默丢帧。

### R4 [P1] 测试安全网（后续所有改造的前置）

- **现状**：49 个 Rust 文件仅 `acp_capability.rs` 有测试；旧 pytest 集成套件随 Python 后端移除。
- **方案**（两层）：
  1. **纯逻辑单测**（无 DB，半天可成）：I4 幂等派生、R2 seq 单调、R4 finalize 守卫、`role_can_write`、`compute_backoff`、mention 解析、`is_terminal_frame`；
  2. **集成测试重建**（`sqlx::test` 或 Docker Compose 起栈，URL 读 `INTEGRATION_BASE_URL`，遵守 CLAUDE.md 不许硬编码端口）：流程 2→4 全链路（发消息→占位→delta→done→seq 连续性断言）、I1 写后投递（断库时不广播）、I2 gap-free（并发发消息 seq 无洞）、流程 8 重连补齐。
- **验收**：CI 跑 `cargo test` + 集成 job；不变量 I1/I2/I3/I4 各至少一条测试覆盖。

### R5 [P1] dispatcher 双派发竞态

- **现状**：`check_idempotency`（SELECT）与 `create_placeholder`（INSERT ON CONFLICT DO NOTHING）非原子（`dispatcher.rs:57-76`）。
- **问题**：并发双触发时两边都过检查，占位收敛（I4 保住），但 **task 帧会派发两次**，bot 重复跑同一任务（费 LLM token；占位回写有 R4 守卫所以 UI 收敛）。
- **方案**：删独立 SELECT，直接 INSERT 用 `rows_affected()==1` 判胜者；败者按 AlreadyInProgress 返回。
- **涉及**：`gateway/dispatcher.rs`
- **验收**：并发 dispatch 同一 (trigger,bot) 的测试，断言 `dispatch_task` 只被调用一次。

### R6 [P2] delta 热路径：消除每帧 2 次 PG 往返

- **现状**：`handle_delta` 每帧执行 `mark_session_alive`（UPDATE sessions）+ `verify_ownership`（SELECT messages）（`stream.rs:112-115`）。
- **问题**：LLM 流式 20–50 帧/秒/流，DB 负载随并发流数线性放大；这是全系统最热路径。
- **方案**：
  1. **所有权校验缓存**：占位 sender 不可变 → 首帧查 PG 通过后在 `StreamEntry` 记 `ownership_verified: bool`，后续帧走内存（R1"以 PG 为准"语义保留在首帧 + done 帧）；
  2. **session 心跳节流**：`StreamEntry` 记 `last_touch: Instant`，每流每 5s 最多 touch 一次；done 帧仍强制 touch。
- **涉及**：`gateway/stream.rs`
- **验收**：单测断言 N 帧 delta 只触发 1 次所有权查询、touch 频率受限；流式期 PG QPS 下降一个数量级（压测脚本可后补）。

### R7 [P2] Redis fan-out 按需订阅（仅当 R1 选方案 B）

- **现状**：`psubscribe agentnexus:rt:channel:*` 全量火喉（`redis_fanout.rs:125-126`）。
- **方案**：本实例首个订阅者 subscribe 该频道主题、最后一个退订时 unsubscribe；ConnectionManager 已维护本地订阅计数，挂钩即可。
- **验收**：两实例下，实例 B 无订阅者的频道流量不到达 B。

### R8 [P3] 错误吞没修复

- **现状**：`stream.rs` 18 处 `map_err(|_| "db error")`，`sessions.rs` 3 处——真实 sqlx 错误丢失。
- **方案**：统一为携带源错误的轻量错误枚举（`thiserror`），或至少 `map_err(|e| { tracing::warn!(%e, "…"); "db error" })`；data WS 回给 bot 的错误码保持稳定字符串不变。
- **验收**：人为断库后日志能看到根因（连接拒绝/超时/约束冲突）。

### R9 [P3] session 解析逻辑合并

- **现状**：`handle_done` 末尾 ~50 行五分支 if/else 阶梯（`stream.rs:272-321`）与 `mark_session_alive`（`stream.rs:548+`）结构重复——同样的「显式 session_id → entry → provider_session_key → provider_session_id」解析顺序写了两遍。
- **方案**：提取 `resolve_session_id(db, bot_id, provider_account_id, frame, entry_session_id) -> Option<Uuid>`，touch/finalize 各调一次；mismatch 告警逻辑随之合并。
- **验收**：两处调用点行为不变（单测覆盖四种来源的解析优先级）。

### R10 [P3] sqlx 样板削减

- **现状**：全仓裸 `sqlx::query` + 手工 `try_get` + `unwrap_or` 链（如 `handle_done` 取 7 列 ~20 行）。
- **方案**：DTO 取数路径改 `query_as::<_, T>` + `#[derive(FromRow)]`；列名/类型错误从运行时提前到（启用 `query!` 宏则到编译期，需 DATABASE_URL/offline 模式，可选）。
- **验收**：`domain/messages.rs`、`gateway/stream.rs`、`gateway/dispatcher.rs` 三个文件先行，行数净减。

### R11 [P3] 大文件拆分

- **现状**：`bridge_runtime.rs` 2467 行（全仓最大，本轮又改 443 行）、`agent_bridge.rs` 1114 行、`acp_capability.rs` 1279 行。
- **方案**：`bridge_runtime` 按「task 接收 / ACP session 驱动 / 回流发送 / 重连恢复」拆 module；`agent_bridge.rs` 拆 `control.rs` / `data.rs` / `auth.rs`。纯移动重构，不改行为，放在 R4 测试就位之后做。
- **验收**：`cargo build` 零警告，无逻辑 diff（git move-detection 可审）。

### R12 [P3] UUID 列类型迁移

- **现状**：全部 id 列 `VARCHAR(36)`（Python 时代 pg_dump 遗留），代码到处 `.to_string()` / `.parse()`。
- **方案**：分批迁移为原生 `uuid` 类型（先新表新列，messages 等大表用 `USING msg_id::uuid` 窗口迁移）；Rust 侧绑定直接传 `Uuid` 删去转换。索引体积约减半，免 parse 错误分支。
- **验收**：迁移可回滚脚本 + 全量集成测试通过。低优先级，可长期搁置。

### R13 [P3] 文档对齐

- **方案**：按 §2.6 差异表逐条处置——GATEWAY_CODE_ARCH 按实际目录重写；ARCHITECTURE_OVERVIEW 部署模型节随 R1 决策更新；BOT_PERMISSION 顶部加现状标注；AGENT_BRIDGE_RESOURCE 词表以 §2.4 刷新。本文档随每次架构变更同步修订版本号。

### 依赖与实施顺序

```
R2 收尾提交 ──▶ R4-1 纯逻辑单测 ──▶ R1 部署形态决策 ──▶ R4-2 集成测试
   (0.5h)         (0.5d)              (0.5d 决策+0.5~2d)      (1~2d)
                                  │
                                  ├─▶ R3 终态背压   ├─▶ R5 双派发竞态   ├─▶ R6 delta 热路径
                                  │     (0.5d)          (0.5d)             (0.5d)
                                  └─（若选方案 B）─▶ R7 按需订阅 (1d)
之后按需：R8 → R9 → R10 → R11 → R13；R12 长期。
```

---

## 附录 A：Redis 键空间（当前装配）

| 键/主题 | 用途 | 生命周期 |
|---|---|---|
| `agentnexus:rt:channel:{channel_id}` | 频道事件 pub/sub | 易失 |
| `agentnexus:rt:user:{user_id}` | 用户级通知 pub/sub | 易失 |
| `agentnexus:bot:{bot_id}:control` | task 帧路由 pub/sub | 易失 |
| `agentnexus:bot:{bot_id}:data` | data 帧路由 pub/sub | 易失 |
| `agentnexus:bot:{bot_id}:online` | 在线标记 | `SET … EX 30`，心跳续期 |

可靠性约定：Redis 全部按 at-most-once 使用；**任何需要持久的状态只在 PG**（I1 写后投递 + REST 补齐兜底）。

## 附录 B：关键代码锚点速查

| 主题 | 位置 |
|---|---|
| 装配（当前 Redis） | `server/src/main.rs:56-82` |
| 浏览器 WS 状态机 | `server/src/gateway/ws/browser.rs` |
| Bot 双 WS 服务端 | `server/src/gateway/ws/agent_bridge.rs` |
| 派发 + 幂等占位 | `server/src/gateway/dispatcher.rs:45-162` |
| 回流 R1–R4 | `server/src/gateway/stream.rs:94-324` |
| seq 分配 | `server/src/domain/channel_seq.rs` |
| 发消息全链路 | `server/src/domain/messages.rs:46-235` |
| bot 链触发 | `server/src/domain/chains.rs:29-110` |
| resource 分发 + 鉴权 | `server/src/resource/mod.rs:70-190` |
| Fanout trait + 进程内实现 | `server/src/gateway/realtime/fanout.rs` |
| Redis fan-out | `server/src/gateway/realtime/redis_fanout.rs` |
| Bot 注册表（进程内/Redis） | `server/src/gateway/{registry,redis_registry}.rs` |
