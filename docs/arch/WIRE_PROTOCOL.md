# Cheers 实时线协议规范 (Wire Protocol v2)

> 版本：v2
> 分支：`break/rust-gateway-arch`
> 状态：协议层决策已定稿，待实现
> 适用范围：客户端 ↔ **Rust Backend** 之间的实时通道（单进程，无 NATS）

本规范是实时通道的**唯一契约来源**。Rust Backend 与前端都以此为准。
内层业务帧（`data`）的语义沿用现有 `app/features/bot_runtime/pipeline/events.py`，本规范不改其内容，只定义外层信封、连接生命周期和投递语义。

> **v2 变更摘要**（相对 v1）：
> - 删除 NATS。Rust Backend 是单进程，浏览器 WS 的 fan-out 在**进程内**完成（见 §8）。
> - 合并 Gateway 与 REST API 为同一个 Rust Backend，「Gateway」一词改称「Backend」。
> - 删除「内部授权端点 + service token」：Backend 直查 DB（+ 进程内缓存），无需自调 HTTP（见 §6.2）。
> - `seq` 一律由 **Backend 盖戳**（不再区分 worker / Bridge 实例，见 §5）。
> - 部署模型：**单实例**；fan-out 与连接定位抽象为可替换接口，多实例为未来计划（见 §8.2，配套 [ARCHITECTURE_OVERVIEW §部署模型](./ARCHITECTURE_OVERVIEW.md)）。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 传输 | **WS-only**，SSE 退场 | 连接模型单一，限流/心跳/状态只需一套 |
| 连接复用 | **单连接复用**，一个客户端一条持久 WS | auth 一次；切频道发 subscribe 帧，不重连 |
| 鉴权 | **首帧 auth 消息** | token 不进 URL/日志；支持续期 |
| JWT 验签 | **RS256/EdDSA 非对称**（见 §6.1） | Backend 只持公钥，被攻破也无法伪造 token |
| 成员校验 | **Backend 直查 DB + 进程内短 TTL 缓存**（见 §6.2） | 单进程，无需自调 HTTP；权威、低延迟 |
| 顺序 | **帧内 `seq` + 客户端去重排序** | 容忍乱序/重复（重连重放、网络重排） |
| Backend 实时层角色 | **哑管道**（不解析内层 `data`） | 加事件类型不需改实时层 |
| 可靠性分层 | delta 可丢（best-effort）；终态帧不可丢（durable） | `message_done` 带全量 content，可自愈对齐 |
| 重连追赶 | 客户端走 **REST 拉全量** | 实时层不做历史重放，维持哑管道 |
| fan-out | **进程内**（`realtime::fanout`），无消息总线 | 单进程；多实例为未来计划（§8.2） |

---

## 1. 连接生命周期状态机

```
        ┌──────────┐
        │  CONNECTED │  WS 握手完成（尚未鉴权）
        └─────┬──────┘
              │ client → {type:"auth", token}
              ▼
   ┌──────────────────────┐
   │  Backend 验 JWT 签名   │
   └───┬──────────────┬────┘
   验失败│           验成功│
       ▼               ▼
 {auth_err}      {auth_ok, user_id}
  关闭连接              │
              ┌─────────▼─────────┐
              │     AUTHED         │  可收发控制帧
              └─────────┬──────────┘
       client → {subscribe, channel_id}
                        │ Backend 校验成员资格（见 §6）
                        ▼
              ┌────────────────────┐
              │     ACTIVE          │  订阅了 ≥1 频道,接收事件流
              └────────────────────┘
       client → {unsubscribe} / 断线 / {auth} 续期
```

**鉴权超时**：进入 `CONNECTED` 后 N 秒（默认 10s）内未收到合法 `auth` 帧，Backend 主动关闭（code 4401）。

**Token 续期**：`AUTHED`/`ACTIVE` 状态下客户端可再次发 `{type:"auth", token}` 刷新会话过期时间，不影响已订阅频道。

---

## 2. 客户端 → Backend（控制帧）

所有控制帧为 JSON 文本帧，带 `type` 字段。

```jsonc
// 鉴权 / 续期
{ "type": "auth", "token": "<JWT>" }

// 订阅一个频道(切频道时发,不需重连)
{ "type": "subscribe", "channel_id": "<uuid>" }

// 退订
{ "type": "unsubscribe", "channel_id": "<uuid>" }

// 应用层心跳(可选,WS ping/pong 之外的保活)
{ "type": "ping" }
```

> user 级通知流（未读提醒等）在 `auth_ok` 后**自动订阅**当前 `user_id`，无需客户端显式 subscribe。

---

## 3. Backend → 客户端（控制回执）

```jsonc
{ "type": "auth_ok",  "user_id": "<uuid>" }
{ "type": "auth_err", "reason": "expired|invalid|..." }   // 随后关闭连接
{ "type": "subscribed",   "channel_id": "<uuid>" }
{ "type": "unsubscribed", "channel_id": "<uuid>" }
{ "type": "pong" }
{ "type": "error", "data": { "detail": "...", "code": "..." } }
```

---

## 4. Backend → 客户端（事件帧）

事件帧承载现有业务事件。**因为单连接复用,信封必须带 `scope` 和 `channel_id`** 让客户端把帧路由到正确的频道视图。

```jsonc
{
  "v": 1,                       // 协议版本
  "scope": "channel",           // "channel" | "user"
  "channel_id": "<uuid>",       // scope=channel 时存在
  "type": "message_stream",     // 业务事件类型(见 §4.1)
  "seq": 42,                    // 仅流式分层帧存在(见 §5)
  "data": { ... }               // 对实时层完全不透明,原样转发
}
```

**`data` 的内容与今天完全一致**——实时层不读、不改、不校验。前端解析 `data` 的逻辑零改动，只需先剥掉 `scope/channel_id/seq` 外层。

### 4.1 事件类型词表（沿用现有，不变更）

| `type` | 分层 | 持久化 | `data` 形状（现有） |
|--------|------|--------|---------------------|
| `message` | 终态 · 不可丢 | 是 | 完整 MessageDTO / bot 占位气泡 |
| `message_done` | 终态 · 不可丢 | 是 | `{msg_id, content, ...}` 全量 |
| `message_deleted` | 终态 · 不可丢 | 是 | MessageDTO 墓碑 |
| `message_stream` | 流式 · 可丢 | 否 | `{msg_id, delta}` + §5 的 `seq` |
| `bot_trace` | 流式 · 可丢 | 否 | 进度对象 |
| `bot_processing` | 流式 · 可丢 | 否 | `{bot_id, username}` |
| `bot_pipeline_error` / `error` | 控制 | 否 | `{detail, code?}` |
| `cancel` / `permission_resolution` | 控制 | 否 | 现有形状 |
| `channel_new_message` | user 流 · 可丢 | 否 | 跨频道未读提醒 |

### 4.2 写后投递原则（Write-Before-Deliver）

> **核心规则：终态帧必须先持久化到 PG，再 fan-out 给客户端。流式帧直接 fan-out，不落库。**

这是 Slack、Discord 等工业级消息系统的共识做法：

```
用户发消息（REST POST）
  ├─ domain 写 PG → 成功                  ← 先落库
  └─ realtime::fanout::broadcast()        ← 再投递

bot done 帧到达
  ├─ domain 更新 Message 记录（is_partial=false）← 先落库
  └─ realtime::fanout::broadcast()        ← 再投递

bot delta 帧到达（message_stream）
  └─ realtime::fanout::broadcast()        ← 直接投递，不写 PG
```

**为什么这样设计：**

| 问题 | 先投递后落库 | 先落库再投递 |
|------|------------|------------|
| 断线重连补齐 | ❌ 客户端丢失消息 | ✅ REST 拉全量从 PG 补 |
| 服务崩溃恢复 | ❌ 内存状态丢失 | ✅ PG 是真相来源 |
| 消息顺序保证 | ❌ 网络抖动导致乱序落库 | ✅ PG 写入顺序即权威顺序 |
| 投递失败处理 | 状态不一致 | PG 有记录，可重试投递 |

**流式帧为什么可以不落库：**

`message_stream`（delta）是中间过程，`message_done` 才是终态。终态帧带完整 `content`，客户端收到后直接覆盖对齐。因此 delta 丢失是**可自愈**的：

```
客户端收到: delta(seq0) delta(seq1) [seq2 丢失] message_done(全量)
结果: 显示正确的完整内容，seq2 的缺口被 message_done 覆盖
```

这让 delta 通道可以是 best-effort，降低了实时层的实现复杂度。

**两层分层表（实现时以此为准）：**

| 分层 | 帧类型 | 落库？ | 背压满时行为 | 断线恢复方式 |
|------|--------|--------|-------------|-------------|
| **终态层（不可丢）** | `message` `message_done` `message_deleted` | ✅ 先落库 | 关闭连接（4408），客户端重连 | REST 拉全量补齐 |
| **流式层（可丢）** | `message_stream` `bot_trace` `bot_processing` | ❌ 不落库 | 丢弃中间帧 | `message_done` 全量覆盖 |
| **控制层（ephemeral）** | `error` `cancel` `permission_resolution` | ❌ | 丢弃 | 重新触发操作 |

> 与 §7（背压）和 §8.1（实时层不持久化）是同一设计的不同切面：背压策略是这个原则在"队列满"场景下的体现；§8.1 的"不持久化在实时层"是这个原则的实现约束。

---

## 5. 流式顺序与去重

**问题**：重连重放、网络重排会导致 delta 帧乱序、重复。

**协议规则**：
1. **seq 由 Backend 权威盖戳**，对每个新 `msg_id` 从 `0` 起单调递增：
   - 无论 delta 来自**内置 Agent Service** 还是**外置 ACP bot**，client-facing `seq` 一律由 **Backend 盖戳，不透传 connector/agent 自报的 seq**（[ACP_CONNECTION_MODEL §8 R2](./ACP_CONNECTION_MODEL.md)）——外部 agent 不可信，乱报 seq 会击穿客户端去重。
2. 仅**流式分层帧**（`message_stream`、可选 `bot_trace`）带 `seq`。终态帧不带。
3. 客户端对每个 `msg_id` 记录已见最大 `seq`，**丢弃 `seq ≤ 已见最大值** 的帧（去重），并按 seq 顺序应用 delta。
4. 若客户端检测到 seq 跳号（漏帧），**不阻塞**——因为 `message_done` 带全量 `content`，到达时直接覆盖对齐。

> 这让 delta 通道可以是 best-effort 的，简化实时层，同时保证最终一致。

---

## 6. 鉴权与授权边界

| 检查 | 由谁做 | 时机 |
|------|--------|------|
| JWT 签名/过期验证 | **Backend**（验签，见 §6.1） | 首帧 auth |
| 频道成员资格（能否 subscribe 某频道） | **Backend 直查 DB + 进程内短 TTL 缓存**（见 §6.2） | subscribe 帧 |
| 业务级权限（能否发消息等） | **Backend domain 层** | REST/resource 调用时 |

> ⚠️ **现状缺口**：今天的 `/ws/channels/{id}` handler 完全无鉴权（直接 accept）。Backend 接管后首帧 auth 强制验签，补上这个洞。

### 6.1 JWT：迁移到 RS256/EdDSA 非对称签名

**现状**：HS256 对称密钥（`JWT_SECRET_KEY`），payload `{sub:user_id, role, exp, iat}`。对称密钥意味着持有者既能验也能签——Backend 作为最暴露的边缘服务若被攻破即可伪造任意 token。

**决策**：迁移到非对称签名（RS256 或 EdDSA/Ed25519）。
- **签发方**：持**私钥**，`create_access_token` / `create_service_token` 用私钥签名。
- **验证方（Backend）**：只持**公钥**，仅验签，无法签发。被攻破也无法伪造 token。
- **`kid` 头**：JWT header 带 `kid`（key id），支持密钥轮换——新旧公钥并存期间按 kid 选公钥。
- **token claims 不变**：仍是 `{sub, role, exp, iat}`，不新增 workspace_id（Backend 只需 user_id 做身份；频道/工作区作用域在 §6.2 的成员校验里解决）。

**迁移窗口**（token 有效期 24h，故窗口 ≥24h）：

> **关键**：迁移期内 Backend 既是签发方又是验证方（单进程）。验证逻辑在窗口内**同时接受 HS256(旧) 和 RS256(新)**，签发逻辑切到 RS256。这样窗口内未过期的旧 token 仍可用，且**不存在 v1 那种「Gateway 只认 RS256 而签发方还在发 HS256」的错配**。

1. 生成密钥对，Backend 同时持有私钥（签）+ 公钥（验）。
2. Backend 改为 RS256 签发；验证端**临时同时接受 HS256 和 RS256**。
3. 窗口结束（所有 HS256 token 自然过期）后，移除 HS256 接受逻辑。
4. 此后 Backend 只认 RS256。

### 6.2 成员资格校验：Backend 直查 + 进程内短 TTL 缓存

**现状**：成员资格存 PostgreSQL `ChannelMembership` 表，`get_membership(channel_id, member_id)` 为 PG 直查，**无任何缓存**。

**决策（v2 简化）**：subscribe 时 Backend **直接查 DB**（同进程，无需 v1 那种自调内部 HTTP 授权端点），结果在 Backend 内存做短 TTL LRU 缓存。

```
Backend 内部（同进程函数调用，非 HTTP）：
  realtime::subscribe(user_id, channel_id)
    → authz_cache.get_or_load((user_id, channel_id))
        命中 → 直接用
        未命中 → domain::channels::is_member(user_id, channel_id)  // PG 直查
```

- **缓存**：Backend 内置 LRU，key=`(user_id, channel_id)`，TTL 30–60s。吸收频繁切频道/重订阅。
- **过期窗口**：用户被踢出频道后，最坏情况仍能收 ≤TTL 秒事件。可接受。
- **主动失效**：成员变更（踢人/退群）发生在**同一进程**，domain 层直接调用 `authz_cache.evict((user_id, channel_id))` 即可把过期窗口压到近实时。**无需 NATS evict 订阅**（v1 的跨进程方案已不适用）。
- **为何不违反「哑管道」**：该原则只约束**数据平面**（不解析事件 `data`）。成员校验是**控制平面**，独立于事件转发。

---

## 7. 背压策略

每条 WS 连接维护一个**有界发送队列**：

- **delta / trace（可丢层）**：队列接近满时，**丢弃中间 delta**（客户端靠 `message_done` 自愈）。
- **终态帧（不可丢层）**：队列满时**不丢帧**，改为**关闭连接**（code 1013 / 4408），客户端重连后走 REST 拉全量补齐。
- WS 层 ping/pong 检测僵死连接；应用层 `ping/pong` 作为补充保活。

> Agent Bridge 侧（bot data WS）的背压与并发控制是另一套，见 [ACP_CONNECTION_MODEL §5](./ACP_CONNECTION_MODEL.md)。

---

## 8. 进程内 fan-out 模型

### 8.1 单进程 fan-out

Rust Backend 是单进程，事件 fan-out 全在进程内完成，**不需要消息总线**：

```
事件来源:
  ├─ REST 写消息 → domain::messages::create → realtime::fanout::broadcast(channel_id, frame)
  ├─ Agent Bridge delta/done → agent_bridge::stream → realtime::fanout::broadcast(channel_id, frame)
  └─ 系统事件（成员变更等）→ realtime::fanout::broadcast

realtime::fanout:
  ├─ ConnectionManager 维护 channel_id → {本进程内订阅该频道的连接}
  ├─ broadcast(channel_id, frame): 给每条订阅连接的有界发送队列入队（§7 背压）
  └─ broadcast(user_id, frame): user 级通知流同理
```

- **信封构造**：发布方传入 `(scope, channel_id, type, seq?, data)`，由 `realtime::frame` 组装 §4 的外层信封。
- **不持久化在实时层**：终态帧的持久化由 domain 层写 PG 完成；实时层只负责把已发生的事件推给在线连接。

### 8.2 横向扩容（未来计划，本期不做）

> **本期定调：单实例。** Backend 跑单实例，故 §8.1 的进程内 fan-out 与 [ACP_CONNECTION_MODEL](./ACP_CONNECTION_MODEL.md) 的进程内 bot 连接管理成立。
> 单实例的故障域与 SLA 上限见 [ARCHITECTURE_OVERVIEW §部署模型](./ARCHITECTURE_OVERVIEW.md)。

为不在未来推倒重来，实现时把两处抽象成**可替换接口（trait）**：

| 抽象 | 单实例实现（本期） | 多实例实现（未来） |
|------|------------------|------------------|
| `Fanout`（频道/用户广播） | 进程内 ConnectionManager | 跨实例总线（Redis pub/sub 或 NATS）+ 本地连接定位 |
| `BotLocator`（task 派发找到 bot 连接） | 进程内 registry | 一致性哈希 / 共享存在性注册（见 [ACP_CONNECTION_MODEL §2.1](./ACP_CONNECTION_MODEL.md)） |

多实例一旦引入，会重新出现「连接黏性 / 跨实例 fan-out」问题——届时通过上述 trait 接入总线解决，**协议层（本文）不变**。

---

## 9. 关闭码约定

| Code | 含义 |
|------|------|
| 4401 | 鉴权超时 / auth 失败 |
| 4403 | 无权订阅该频道 |
| 1013 / 4408 | 背压：终态帧队列满，请重连 + REST 补齐 |
| 1011 | 服务端内部错误 |

---

## 10. 兼容与迁移

- **前端改动**：(1) 从「每频道一条 WS」改为单连接 + subscribe 帧；(2) 收帧时先剥外层信封；(3) delta 按 seq 去重。`data` 解析逻辑不动。
- **后端切换**：前端 WS 连接目标从旧 Python WS 切到 Rust Backend WS（URL 不变，仍是 `/ws`）。Phase 1 可灰度（见 [ARCHITECTURE_OVERVIEW §部署模型](./ARCHITECTURE_OVERVIEW.md) 的灰度方案）。
- **SSE 退场**：`agent_bridge` 的 SSE 端点在前端切到 WS 流式后下线。

---

## 附录 A：一次完整的 bot 流式回复时序

```
Client ─WS─▶ Backend : {auth, token}
Client ◀─WS─ Backend : {auth_ok, user_id}            (自动订阅 user 流)
Client ─WS─▶ Backend : {subscribe, channel_id:C}
Client ◀─WS─ Backend : {subscribed, C}

Client ─REST─▶ Backend : POST /channels/C/messages    (发消息,走 REST)
Backend: domain::messages::create → 持久化
Backend: realtime::fanout::broadcast(C, {type:message, data:用户消息})
Backend ◀── 加信封 ─▶ Client : {scope:channel, channel_id:C, type:message, data}

Backend: resolve_bot_trigger → 需要触发 bot
Backend: agent_bridge::dispatcher::dispatch(task) → control WS task 帧 → bot
  （详见 TASK_DELIVERY）

Agent Service / 外置 bot 流式输出 → data WS:
  delta(msg_id:M, seq?) / done(msg_id:M, content)
Backend: agent_bridge::stream 收到 →
  ├─ 占位 fan-out: broadcast(C, {type:message, data:bot占位})          (终态:占位气泡)
  ├─ broadcast(C, {type:message_stream, seq:0, data:{msg_id:M, delta:"你"}})  (Backend 盖 seq)
  ├─ broadcast(C, {type:message_stream, seq:1, data:{delta:"好"}})
  ├─ ...
  └─ done: DB 更新 → broadcast(C, {type:message_done, data:{msg_id:M, content:"你好…全量"}})  (终态)

Client 按 seq 拼 delta, message_done 到达后覆盖对齐。
```
