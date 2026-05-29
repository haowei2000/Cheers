# AgentNexus 实时线协议规范 (Wire Protocol v1)

> 版本：v1 草稿
> 分支：`break/rust-gateway-arch`
> 状态：协议层决策已定稿，待实现
> 适用范围：客户端 ↔ Rust Gateway ↔ NATS ↔ Python Worker/REST API 之间的实时通道

本规范是实时通道的**唯一契约来源**。Rust Gateway、前端、Python Worker 都以此为准。
内层业务帧（`data`）的语义沿用现有 `app/features/bot_runtime/pipeline/events.py`，本规范不改其内容，只定义外层信封、连接生命周期和投递语义。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 传输 | **WS-only**，SSE 退场 | 连接模型单一，限流/心跳/状态只需一套 |
| 连接复用 | **单连接复用**，一个客户端一条持久 WS | auth 一次；切频道发 subscribe 帧，不重连 |
| 鉴权 | **首帧 auth 消息** | token 不进 URL/日志；支持续期 |
| JWT 验签 | **RS256/EdDSA 非对称**（见 §6.1） | Gateway 只持公钥，被攻破也无法伪造 token |
| 成员校验 | **Gateway 调 REST 授权端点 + 短 TTL 缓存**（见 §6.2） | 权威、不碰 DB schema、不增净新缓存基建 |
| 顺序 | **帧内 `seq` + 客户端去重排序** | 容忍 NATS at-least-once 的乱序与重复 |
| Gateway 角色 | **哑管道** | 不解析内层 `data`；加事件类型不需改/重启网关 |
| 可靠性分层 | delta 可丢（best-effort）；终态帧不可丢（durable） | `message_done` 带全量 content，可自愈对齐 |
| 重连追赶 | 客户端走 **REST 拉全量** | Gateway 不做历史重放，维持哑管道 |

---

## 1. 连接生命周期状态机

```
        ┌──────────┐
        │  CONNECTED │  WS 握手完成（尚未鉴权）
        └─────┬──────┘
              │ client → {type:"auth", token}
              ▼
   ┌──────────────────────┐
   │  Gateway 验 JWT 签名   │
   └───┬──────────────┬────┘
   验失败│           验成功│
       ▼               ▼
 {auth_err}      {auth_ok, user_id}
  关闭连接              │
              ┌─────────▼─────────┐
              │     AUTHED         │  可收发控制帧
              └─────────┬──────────┘
       client → {subscribe, channel_id}
                        │ Gateway 校验成员资格(可选,见 §6)
                        ▼
              ┌────────────────────┐
              │     ACTIVE          │  订阅了 ≥1 频道,接收事件流
              └────────────────────┘
       client → {unsubscribe} / 断线 / {auth} 续期
```

**鉴权超时**：进入 `CONNECTED` 后 N 秒（默认 10s）内未收到合法 `auth` 帧，Gateway 主动关闭（code 4401）。

**Token 续期**：`AUTHED`/`ACTIVE` 状态下客户端可再次发 `{type:"auth", token}` 刷新会话过期时间，不影响已订阅频道。

---

## 2. 客户端 → Gateway（控制帧）

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

## 3. Gateway → 客户端（控制回执）

```jsonc
{ "type": "auth_ok",  "user_id": "<uuid>" }
{ "type": "auth_err", "reason": "expired|invalid|..." }   // 随后关闭连接
{ "type": "subscribed",   "channel_id": "<uuid>" }
{ "type": "unsubscribed", "channel_id": "<uuid>" }
{ "type": "pong" }
{ "type": "error", "data": { "detail": "...", "code": "..." } }
```

---

## 4. Gateway → 客户端（事件帧）

事件帧承载现有业务事件。**因为单连接复用,信封必须带 `scope` 和 `channel_id`** 让客户端把帧路由到正确的频道视图。

```jsonc
{
  "v": 1,                       // 协议版本
  "scope": "channel",           // "channel" | "user"
  "channel_id": "<uuid>",       // scope=channel 时存在
  "type": "message_stream",     // 业务事件类型(见 §4.1)
  "seq": 42,                    // 仅流式分层帧存在(见 §5)
  "data": { ... }               // 对 Gateway 完全不透明,原样转发
}
```

**`data` 的内容与今天完全一致**——Gateway 不读、不改、不校验。前端解析 `data` 的逻辑零改动，只需先剥掉 `scope/channel_id/seq` 外层。

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

---

## 5. 流式顺序与去重

**问题**：NATS at-least-once + 多 worker 会导致 delta 帧乱序、重复。

**协议规则**：
1. **seq 由服务端权威方盖戳**，对每个新 `msg_id` 从 `0` 起单调递增：
   - 内部 bot：worker（持 claim 的 owner，[TASK_DELIVERY §4](./TASK_DELIVERY.md)）盖戳。
   - 外部 ACP bot：持 connector 的 **Bridge 实例盖戳，不透传 connector 自报的 seq**（[ACP_CONNECTION_MODEL §8.3 R2](./ACP_CONNECTION_MODEL.md)）——外部 agent 不可信，乱报 seq 会击穿客户端去重。
2. 仅**流式分层帧**（`message_stream`、可选 `bot_trace`）带 `seq`。终态帧不带。
3. 客户端对每个 `msg_id` 记录已见最大 `seq`，**丢弃 `seq ≤ 已见最大值** 的帧（去重），并按 seq 顺序应用 delta。
4. 若客户端检测到 seq 跳号（漏帧），**不阻塞**——因为 `message_done` 带全量 `content`，到达时直接覆盖对齐。

> 这让 delta 通道可以是 best-effort 的，简化网关与总线，同时保证最终一致。

---

## 6. 鉴权与授权边界

| 检查 | 由谁做 | 时机 |
|------|--------|------|
| JWT 签名/过期验证 | **Gateway**（验签，见 §6.1） | 首帧 auth |
| 频道成员资格（能否 subscribe 某频道） | **Gateway 调 REST 授权端点 + 短 TTL 缓存**（见 §6.2） | subscribe 帧 |
| 业务级权限（能否发消息等） | **Python REST API** | REST 调用时（不走 WS）|

> ⚠️ **现状缺口**：今天的 `/ws/channels/{id}` handler 完全无鉴权（直接 accept）。Gateway 接管后首帧 auth 强制验签，补上这个洞。

### 6.1 JWT：迁移到 RS256/EdDSA 非对称签名

**现状**：HS256 对称密钥（`JWT_SECRET_KEY`），payload `{sub:user_id, role, exp, iat}`。对称密钥意味着持有者既能验也能签——Gateway 作为最暴露的边缘服务若被攻破即可伪造任意 token。

**决策**：迁移到非对称签名（RS256 或 EdDSA/Ed25519）。
- **Python（签发方）**：持**私钥**，`create_access_token` / `create_service_token` 改用私钥签名。
- **Gateway（验证方）**：只持**公钥**，仅验签，无法签发。被攻破也无法伪造 token。
- **`kid` 头**：JWT header 带 `kid`（key id），支持密钥轮换——新旧公钥并存期间按 kid 选公钥。
- **token claims 不变**：仍是 `{sub, role, exp, iat}`，不新增 workspace_id（Gateway 只需 user_id 做身份；频道/工作区作用域在 §6.2 的成员校验里解决）。

**迁移窗口**（token 有效期 24h，故窗口 ≥24h）：
1. 生成密钥对，Python 同时部署私钥（签）+ 公钥；Gateway 部署公钥。
2. Python 改为 RS256 签发，但**验证端临时同时接受 HS256(旧) 和 RS256(新)**，让窗口内未过期的旧 token 仍可用。
3. 窗口结束（所有 HS256 token 自然过期）后，移除 HS256 接受逻辑。
4. 全程 Gateway 只认 RS256，不接受 HS256。

### 6.2 成员资格校验：REST 授权端点 + Gateway 短 TTL 缓存

**现状**：成员资格存 PostgreSQL `ChannelMembership` 表，`get_membership(channel_id, member_id)` 为 PG 直查，**无任何缓存**。

**决策**：subscribe 时由 Gateway 调用一个轻量内部授权端点，结果在 Gateway 内存做短 TTL LRU 缓存。

```
内部端点(仅 Gateway 可达,非公开):
  GET /internal/authz/membership?user_id=<uid>&channel_id=<cid>
  → 200 {"member": true,  "ttl": 60}
  → 200 {"member": false, "ttl": 30}
```

- **缓存**：Gateway 内置 LRU，key=`(user_id, channel_id)`，TTL 30–60s（端点可在响应里指定 ttl）。吸收频繁切频道/重订阅。
- **过期窗口**：用户被踢出频道后，最坏情况仍能收 ≤TTL 秒事件。可接受。
- **可选主动失效**：Python 在成员变更时往 NATS 发 `agentnexus.authz.evict.{user_id}.{channel_id}`，Gateway 订阅后立即清缓存，把过期窗口压到近实时。**Phase 4 增强项，非必须。**
- **Gateway↔内部端点鉴权**：Gateway 用 service token（同样 RS256 签发，§6.1）调内部端点；端点校验 service token 的特定 claim（如 `aud:"gateway"`）。
- **为何不违反「哑管道」**：该原则只约束**数据平面**（不解析事件 `data`）。成员校验是**控制平面**，独立于事件转发。

---

## 7. 背压策略

每条 WS 连接维护一个**有界发送队列**：

- **delta / trace（可丢层）**：队列接近满时，**丢弃中间 delta**（客户端靠 `message_done` 自愈）。
- **终态帧（不可丢层）**：队列满时**不丢帧**，改为**关闭连接**（code 1013 / 4408），客户端重连后走 REST 拉全量补齐。
- WS 层 ping/pong 检测僵死连接；应用层 `ping/pong` 作为补充保活。

---

## 8. NATS Subject 方案

```
# 终态帧(durable,JetStream)——发布者: Worker / REST API
agentnexus.rt.channel.{channel_id}

# user 级通知(best-effort)
agentnexus.rt.user.{user_id}

# 流式 delta(best-effort,core NATS,不持久化)
agentnexus.rt.stream.{channel_id}.{msg_id}

# 客户端消息触发 Agent 任务——发布者: REST API,消费者: Worker
agentnexus.task.{workspace_id}.{channel_id}
```

**NATS payload**：subject 已编码 `channel_id`，故 payload 只需内层 `{type, seq?, data}` 帧。Gateway 从 subject 取 `channel_id`，重建 §4 的外层信封后转发。**发布者无需关心信封。**

**Gateway 订阅模型（横向扩容关键）**：
- 动态订阅：某频道有 ≥1 本地客户端时才 `subscribe agentnexus.rt.channel.{id}`，降到 0 时退订。
- 避免 `agentnexus.rt.channel.>` 全量通配（否则每个 Gateway 实例都收全量，无法水平扩展）。

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
- **Phase 0 双写**：REST/Worker 同时往 Redis(旧) 和 NATS(新) publish，前端灰度切换连接目标。
- **SSE 退场**：`agent_bridge` 的 SSE 端点在前端切到 WS 流式后下线。

---

## 附录 A：一次完整的 bot 流式回复时序

```
Client ─WS─▶ Gateway : {auth, token}
Client ◀─WS─ Gateway : {auth_ok, user_id}            (自动订阅 user 流)
Client ─WS─▶ Gateway : {subscribe, channel_id:C}
Client ◀─WS─ Gateway : {subscribed, C}

Client ─REST─▶ API   : POST /channels/C/messages      (发消息,走 REST)
API ─NATS─▶ task.{ws}.C                               (触发 Agent)
API ─NATS─▶ rt.channel.C : {type:message, data:用户消息}
Gateway ◀── 收到, 加信封 ─▶ Client : {scope:channel, channel_id:C, type:message, data}

Worker 消费 task → 开始生成:
  ─NATS─▶ rt.channel.C : {type:message, data:bot占位}          (终态:占位气泡)
  ─NATS─▶ rt.stream.C.M : {type:message_stream, seq:0, data:{msg_id:M, delta:"你"}}
  ─NATS─▶ rt.stream.C.M : {type:message_stream, seq:1, data:{delta:"好"}}
  ...
  ─NATS─▶ rt.channel.C : {type:message_done, data:{msg_id:M, content:"你好…全量"}}  (终态)

Gateway 逐帧加信封转发; Client 按 seq 拼 delta, message_done 到达后覆盖对齐。
```
