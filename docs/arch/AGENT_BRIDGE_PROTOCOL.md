# AgentNexus Agent Bridge Protocol v1

> 状态：架构层规范草案
> 日期：2026-06-01
> 适用范围：AgentNexus Rust Backend ↔ AgentNexus Connector
> 配套：[CLIENT_DAEMON_ARCHITECTURE](./CLIENT_DAEMON_ARCHITECTURE.md) · [AGENT_BRIDGE_ACP_COMPATIBILITY](./AGENT_BRIDGE_ACP_COMPATIBILITY.md) · [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) · [WIRE_PROTOCOL](./WIRE_PROTOCOL.md) · [ACP_CONNECTION_MODEL](./ACP_CONNECTION_MODEL.md)

本文定义 **AgentNexus Agent Bridge Protocol** 到底实现什么、如何握手、支持哪些请求和事件、
以及在整体架构中位于哪一层。

核心结论：

**Agent Bridge Protocol 是 AgentNexus 平台协议，不是 ACP JSON-RPC。**

它连接的是：

```
Rust Backend ↔ Connector
```

ACP、custom HTTP、custom stdio、vendor WebSocket 等 agent runtime 协议，都应该收敛到
connector 内部 adapter。Backend 只实现本文定义的平台协议。

---

## 1. 协议边界

### 1.1 Agent Bridge Protocol 负责什么

Agent Bridge Protocol 负责平台事实：

- bot 身份、bot token、在线状态。
- control/data 两条 WebSocket 的连接生命周期。
- 新连接 supersede 旧连接。
- task 派发、cancel、配置推送、审批结果回推。
- Backend → Connector 的命令投递模型与 ack/response 语义。
- 远端 runtime session 的 create/pause/terminate/resume 控制。
- bot 流式输出、最终完成、主动发消息、上传文件。
- bot 访问平台资源：channel、message、file、memory、fs、activity。
- bot 申请用户审批。
- capability delegation 鉴权、拒绝日志和错误返回。
- 服务端写后投递：终态先写 PG，再 fanout 给浏览器。
- 断线恢复的协议占位和未来 replay 入口。

### 1.2 Agent Bridge Protocol 不负责什么

以下内容不属于 Backend ↔ Connector 协议：

- ACP stdio JSON-RPC 细节。
- 本地 LLM / agent prompt 编排。
- OpenCode、Codex、Claude 或其它 vendor agent 的私有字段。
- 本地文件系统权限判定。
- 模型选择和 session config option 如何应用到具体 agent。
- prompt timeout、tool retry、agent restart 等 runtime 内部策略。
- ACP session/new、session/load、session/prompt、session/cancel 等方法的逐字段实现细节。

这些都属于 connector runtime adapter。

### 1.3 架构层位置

```
Browser / Mobile
  │ AgentNexus REST + Browser WS
  ▼
Rust Backend
  ├─ API/domain: workspace/channel/message/file/memory/session
  ├─ realtime: browser fanout
  ├─ gateway/dispatcher: 创建 bot 占位消息并派发 task
  ├─ gateway/stream: 接收 delta/done/send 并写库/fanout
  ├─ resource: 处理 resource_req/resource_res
  └─ ws/agent_bridge: Agent Bridge Protocol transport
       │
       │ Agent Bridge Protocol v1
       ▼
Connector
  ├─ Bridge session client
  ├─ Runtime adapter: ACP / custom-http / custom-stdio / vendor-ws
  └─ Local agent process or remote agent endpoint
```

实现上，Backend 可以继续使用 `BotLocator` / `BotRegistry` trait 抽象连接定位：

- 单实例：进程内 registry。
- 多实例：Redis/NATS/pubsub registry。

协议语义不依赖具体 registry 实现。

---

## 2. Transport

### 2.1 端点

正式端点为：

| Endpoint | 用途 |
|----------|------|
| `/ws/agent-bridge/control` | 生命周期、runtime session 控制、task、cancel、配置、审批结果 |
| `/ws/agent-bridge/data` | delta/done/send/file/resource/permission/session_update |

不保留 `/ws/acp-bridge/*` WS alias。命名上统一使用 `agent_bridge`，
因为这条 WS 不说 ACP JSON-RPC。

### 2.2 帧格式

每个 WS message 是一个 UTF-8 JSON text frame。基础 envelope：

```jsonc
{
  "type": "<frame_type>",
  "v": 1
}
```

约定：

- `type` 必填。
- `v` 缺省视为 `1`。
- UUID 均为字符串。
- 平台时间字段使用 UTC RFC3339，例如 `2026-06-01T10:15:30Z`。
- 低层 trace 可使用 epoch milliseconds 的 `ts`，但平台终态字段仍使用 RFC3339。
- Backend → Connector 的错误统一使用 `error` 帧。
- connector 发起的可确认操作使用 `client_msg_id` 或 `req_id` 关联 ack。

### 2.3 两条 WS 的职责

| Stream | 特征 | 放什么 | 不放什么 |
|--------|------|--------|----------|
| control | 低频、控制面、生命周期 | `hello`、`ready`、`runtime_session_control`、`task`、`cancel`、配置、审批结果、membership 变化 | token delta、大文件、resource response |
| data | 高频、数据面、agent I/O | `delta`、`done`、`send`、`file_upload`、`resource_req/res`、`permission_request`、`trace` | task 派发、配置主控制流 |

**决策：`task` 属于 control stream。**

原因：

- task 是一次 agent run 的启动命令，不是高频数据流。
- task 需要和 bot lifecycle、cancel、配置状态在同一控制面内排序。
- data stream 留给高频输出和 request/response，避免 task 与资源响应互相阻塞。

### 2.4 Backend → Connector 发送模型

Backend 向 connector 发消息不是直接调用 ACP，也不是直接访问本地 agent。Backend 只向
Agent Bridge 的 control/data WS 写 AgentNexus 协议帧。

实现层可以是：

```
Backend domain/API
  │
  ├─ BotLocator.dispatch_task(bot_id, control_frame)
  │    └─ control WS → connector
  │
  └─ BotLocator.send_data(bot_id, data_frame)
       └─ data WS → connector
```

在单实例部署下，`BotLocator` 是进程内 channel；多实例部署下可以换成 Redis/NATS/pubsub。
这只是连接定位方式，不改变协议帧。

Backend → Connector 帧分三类：

| 类别 | Stream | 例子 | 是否需要业务 ack |
|------|--------|------|------------------|
| Command | control | `runtime_session_control`、`task`、`cancel`、`config_update`、`config_option_set` | 需要时由专门 ack/status 帧确认 |
| Event snapshot | control | `hello`、`channel_joined`、`channel_left`、`permission_resolution` | 通常不 ack；状态由 Backend 持久化 |
| Response / ack | data | `resource_res`、`send_ack`、`terminal_ack`、`file_upload_ack` | 回应 connector 发起的请求 |

投递语义：

- 写入 WS 发送队列成功，只表示 Backend 已将帧交给连接层，不表示 connector/runtime 已处理。
- 需要知道处理结果的命令必须有 ack/status，例如 `runtime_session_control_ack`、
  `config_status`、`config_option_status`。
- 如果 bot 不在线，Backend 不应把命令丢在内存里假装成功。可持久化的命令先写 DB，
  下次 `hello` 通过 snapshot 对齐；不可持久化的命令应返回调用方失败。
- `task` 属于不可静默丢弃命令。若 control WS 不在线，Backend 应将占位消息标记失败或排队，
  不能让前端永久停在 partial 状态。

---

## 3. 连接生命周期与握手

### 3.1 状态机

```
DISCONNECTED
  │ connector opens control + data WS
  ▼
SOCKET_OPEN
  │ connector sends auth within 10s
  ▼
AUTHENTICATING
  │ Backend resolves botToken and bot status
  ▼
BOUND
  │ Backend binds control/data, supersedes old connection if needed
  ▼
HELLO_SENT
  │ Backend sends control hello and data hello
  ▼
CONNECTOR_READY
  │ connector sends ready on control
  ▼
ACTIVE
  │ task / delta / resource / config / permission traffic
  ▼
DRAINING
  │ close, supersede, fatal auth failure, operator stop
  ▼
DISCONNECTED
```

`ACTIVE` 的最低条件：

- control WS 已鉴权并收到 control `hello`。
- data WS 已鉴权并收到 data `hello`。
- connector 已在 control WS 发送 `ready`。

Backend **SHOULD NOT** 派发新 `task` 给未 ready 的 connector。

### 3.2 Auth frame

Connector 在 control 和 data 两条 WS 上都必须先发：

```jsonc
{
  "type": "auth",
  "v": 1,
  "token": "agb_xxx",
  "bridge_protocol_version": 1,
  "connector": {
    "name": "cce-acp-connector",
    "version": "0.2.0"
  }
}
```

规则：

- auth 必须在 WS open 后 10 秒内完成。
- token 不放 URL，避免进入访问日志。
- Backend 对 token 做 hash 后匹配 `bot_accounts.bot_token_hash`。
- bot `status` 必须是 `online`。
- auth 失败关闭 WS。

当前代码宽松地接受“第一帧里有 token”的形状；v1 应收敛为显式 `type:"auth"`。

### 3.3 Control hello

Backend 鉴权 control WS 后发送：

```jsonc
{
  "type": "hello",
  "v": 1,
  "bridge_protocol_version": 1,
  "bot_id": "<uuid>",
  "bot_username": "helper",
  "bot_display_name": "Helper",
  "connection_id": "<uuid>",
  "session_id": "<connection_uuid>",
  "memberships": [
    {
      "channel_id": "<uuid>",
      "channel_name": "general",
      "channel_type": "public",
      "workspace_id": "<uuid>",
      "joined_at": "2026-06-01T10:15:30Z"
    }
  ],
  "connector_config": {
    "revision": 12,
    "settings": {
      "requestTimeoutMs": 120000,
      "promptTimeoutMs": 900000,
      "cwd": "/repo",
      "model": "gpt-5"
    },
    "updated_at": "2026-06-01T10:15:30Z",
    "last_status": null,
    "options": null
  },
  "acp_security": {
    "enabled": false,
    "mode": "X25519-ECDH",
    "algorithm": "ChaCha20-Poly1305",
    "allow_plaintext_fallback": true,
    "require_capability": false
  },
  "server_capabilities": {
    "runtime_session_control": true,
    "task": true,
    "cancel": true,
    "permission_resolution": true,
    "connector_config": true,
    "config_option_set": true,
    "membership_events": true
  }
}
```

`memberships` 是权威快照。connector 收到后应替换本地 membership cache。

### 3.4 Data hello

Backend 鉴权 data WS 后发送：

```jsonc
{
  "type": "hello",
  "v": 1,
  "stream": "data",
  "bridge_protocol_version": 1,
  "bot_id": "<uuid>",
  "connection_id": "<uuid>",
  "session_id": "<connection_uuid>",
  "last_event_seq": 0,
  "acp_security": {
    "enabled": false,
    "mode": "X25519-ECDH",
    "algorithm": "ChaCha20-Poly1305",
    "allow_plaintext_fallback": true,
    "require_capability": false
  },
  "server_capabilities": {
    "resource_req": true,
    "file_upload": true,
    "send": true,
    "trace": true,
    "session_update": true,
    "resume": false
  }
}
```

`last_event_seq` 是为未来 replay 保留的 data event 序号。当前实现返回 `0` 且 `resume`
未真正重放，见 §10.4。

### 3.5 Ready frame

Connector 完成本地 runtime 初始化后，在 control WS 发送：

```jsonc
{
  "type": "ready",
  "v": 1,
  "connector_version": "0.2.0",
  "runtime": {
    "protocol": "acp",
    "name": "opencode",
    "version": "..."
  },
  "connector_capabilities": {
    "runtime_protocols": ["acp"],
    "runtime_session_control": true,
    "streaming": true,
    "files": true,
    "resource_req": true,
    "permission_request": true,
    "config_options": true,
    "trace": true
  }
}
```

Backend 可以记录 `ready` 信息用于运维状态展示，但不应把 runtime protocol 用作权限判断。

---

## 4. Session 与 Task 的概念边界

这里必须拆开四个容易混淆的概念：

| 概念 | 生命周期 | 谁创建/控制 | 用途 |
|------|----------|-------------|------|
| Bridge connection session | 一次 control/data WS 连接 | Backend 握手时创建 `connection_id` | 连接管理、supersede、日志追踪 |
| AgentNexus runtime session | 可跨多个 task 复用 | Backend 创建并持久化 `session_id` / `provider_session_key` | 平台侧 agent 上下文、权限 grant、审计 |
| Provider/ACP session | 本地或远端 agent runtime 内部会话 | Connector runtime adapter 创建/恢复 | 映射到 ACP `session/new` / `session/load` 等 |
| Task / turn | 一次用户触发的 agent run | Backend dispatcher 创建 `task_id` | 让 agent 在某个 session 上处理一次输入 |

因此：

**Task 不是 session。Task 是一次运行；session 是承载多次运行的上下文容器。**

一个 session 可以有多个 task：

```
runtime_session S
  ├─ task T1: 用户问问题
  ├─ task T2: 用户追问
  └─ task T3: bot@bot 触发
```

一个 task 必须引用一个 session，或带上足够信息让 connector 创建/恢复对应 session。

### 4.1 Task 是否可以隐式创建 session

可以，但这只是便捷语义，不代表 task 和 session 是同一个概念。

默认规则：

- `task` 携带 `session_id` 和 `provider_session_key`。
- connector 收到 `task` 后必须确保对应 runtime session 处于 active 状态。
- 如果本地/远端 ACP session 不存在，connector 可以按 `provider_session_key` lazy create/load。
- 如果 Backend 想显式管理 session 生命周期，应先发 `runtime_session_control`。

推荐将 `task.session_policy` 加入 rich task：

```jsonc
{
  "session_policy": {
    "on_missing": "create",
    "on_paused": "resume",
    "after_task": "keep_active"
  }
}
```

含义：

| Field | 值 | 说明 |
|-------|----|------|
| `on_missing` | `create` / `fail` | runtime session 不存在时是否允许 connector 创建 |
| `on_paused` | `resume` / `fail` | runtime session 已 pause 时是否允许恢复 |
| `after_task` | `keep_active` / `pause` | task 完成后是否保持 runtime session active |

---

## 5. Control Stream

### 5.1 Connector → Backend

| Frame | 是否必需 | 语义 | Backend 行为 |
|-------|----------|------|--------------|
| `auth` | 必需 | 鉴权 control WS | 验 token，绑定 bot |
| `ready` | 必需 | connector runtime 已可接 task | 标记 ready，记录能力 |
| `ping` | 建议 | 应用层心跳 | 回 `pong` |
| `runtime_session_control_ack` | 必需 | session lifecycle 命令处理结果 | 更新 session 状态和 provider 映射 |
| `config_status` | 可选 | 上次 `config_update` 应用结果 | 写入 `binding_config.connector_control.last_status` |
| `config_options` | 可选 | connector/ACP 发现的动态选项 | 写入 `binding_config.connector_control.options` |
| `config_option_status` | 可选 | `config_option_set` 应用结果 | 写入 `binding_config.connector_control.last_option_status` |

### 5.2 Backend → Connector

| Frame | 是否必需 | 语义 | Connector 行为 |
|-------|----------|------|----------------|
| `hello` | 必需 | control 握手成功、membership/config 快照 | 初始化 membership 和配置 |
| `runtime_session_control` | 必需 | 显式控制远端 runtime session | create/pause/terminate/resume runtime session，并回 ack |
| `task` | 必需 | 启动一次 agent run | 调 runtime adapter |
| `cancel` | 必需 | 用户取消 bot 输出 | best-effort abort runtime turn |
| `config_update` | 必需 | 平台 connector 设置变化 | 应用或拒绝，并回 `config_status` |
| `config_option_set` | 可选 | 设置 ACP/custom session config option | 应用到 runtime session，并回 `config_option_status` |
| `permission_resolution` | 必需 | 用户审批结果 | 唤醒等待中的 permission request |
| `channel_joined` | 可选 | bot 加入频道 | 更新 membership cache |
| `channel_left` | 可选 | bot 离开频道 | 更新 membership cache |
| `pong` | 建议 | 心跳响应 | 更新健康状态 |
| `error` | 必需 | 控制面错误 | 记录并按 code 处理 |

---

## 6. Data Stream

### 6.1 Connector → Backend

| Frame | 确认方式 | 语义 | Backend 行为 |
|-------|----------|------|--------------|
| `auth` | `hello` / close | 鉴权 data WS | 验 token，绑定 data_tx |
| `ping` | `pong` | 应用层心跳 | 回 `pong` |
| `resume` | `resume_ack` | 请求 replay data events | 当前 no-op；未来重放 |
| `delta` | 无 ack | 流式 token | 校验 owner，Backend 盖 seq，fanout `message_stream` |
| `done` | `terminal_ack` | 完成占位消息 | 先写 PG，再 fanout `message_done` |
| `error` | `terminal_ack` | 终止占位消息并标错误 | finalize partial，fanout |
| `send` | `send_ack` | bot 主动发新消息 | 校验成员，写 PG，fanout |
| `file_upload` | `file_upload_ack` | 上传文件并拿 file_id | 写对象存储/DB，返回 file_id |
| `resource_req` | `resource_res` | 访问平台资源 | 调 resource dispatcher |
| `permission_request` | `send_ack` + later `permission_resolution` | 请求用户审批 | 校验成员，发布审批卡 |
| `session_update` | error only | 上报 provider session 信息 | 写 session binding/metadata |
| `trace` | 无 ack | best-effort 运行轨迹 | 校验 owner，fanout `bot_trace` |

### 6.2 Backend → Connector

| Frame | 语义 |
|-------|------|
| `hello` | data 握手成功 |
| `pong` | 心跳响应 |
| `resume_ack` | replay 结束 |
| `terminal_ack` | `done` / `error` 处理结果 |
| `send_ack` | `send` / `permission_request` 处理结果 |
| `file_upload_ack` | `file_upload` 处理结果 |
| `resource_res` | `resource_req` 处理结果 |
| `error` | data 面错误 |

### 6.3 Legacy / compatibility frames

| Frame | 方向 | v1 决策 |
|-------|------|---------|
| `reply` | Connector → Backend | 兼容别名。新 connector 应使用 `done` 完成 task 占位，使用 `send` 主动发新消息。 |
| `typing` | Connector → Backend | 不进入 v1 必需集合。需要时用 `trace` 表达。 |
| data `message` | Backend → Connector | 不作为 v1 canonical task frame。SDK 中的旧 `MessageEvent` 应改为 control `task`。 |

---

## 7. 核心帧定义

### 7.1 `runtime_session_control`（Backend → Connector / control）

Backend 用这个帧显式控制 connector 内部的 runtime session。它控制的是
AgentNexus runtime session 与 provider/ACP session 的映射，不是一次 task。

```jsonc
{
  "type": "runtime_session_control",
  "v": 1,
  "request_id": "<uuid>",
  "action": "create",
  "session": {
    "id": "<agentnexus_session_uuid>",
    "provider_session_key": "agentnexus:workspace:<workspace_id>:bot:<bot_id>",
    "primary_scope_type": "workspace",
    "primary_scope_id": "<workspace_id>",
    "task_scope_id": "<channel_or_thread_uuid>"
  },
  "runtime": {
    "protocol": "acp",
    "provider_session_id": null,
    "config": {
      "cwd": "/repo",
      "model": "gpt-5",
      "configOptions": {}
    }
  },
  "reason": "user_opened_channel",
  "deadline_ms": 30000
}
```

`action` 取值：

| Action | 语义 | ACP adapter 典型映射 |
|--------|------|----------------------|
| `create` | 创建或打开一个新的 runtime session，并绑定 `provider_session_key` | `session/new` |
| `pause` | 暂停 session，释放运行资源，但保留平台映射和可恢复状态 | adapter 本地 park；ACP 没有强制等价方法时由 connector 实现 |
| `terminate` | 终止 session；若有 active task，先取消或终止该 run | `session/cancel` active turn + adapter dispose |
| `resume` | 恢复已暂停或已持久化的 runtime session，使其可接收后续 task | `session/load` 或 connector 本地 session cache restore |

Connector 必须回：

```jsonc
{
  "type": "runtime_session_control_ack",
  "v": 1,
  "request_id": "<uuid>",
  "action": "create",
  "ok": true,
  "session": {
    "id": "<agentnexus_session_uuid>",
    "provider_session_key": "agentnexus:workspace:<workspace_id>:bot:<bot_id>",
    "provider_session_id": "acp-session-id",
    "status": "active"
  },
  "applied_at": "2026-06-01T10:15:30Z"
}
```

失败：

```jsonc
{
  "type": "runtime_session_control_ack",
  "v": 1,
  "request_id": "<uuid>",
  "action": "resume",
  "ok": false,
  "code": "SESSION_NOT_FOUND",
  "error": "provider session could not be loaded",
  "retryable": false
}
```

规则：

- `runtime_session_control` 是控制 session 生命周期的命令。
- `task` 是在 session 上执行一次 run 的命令。
- `create/pause/terminate/resume` 是显式 session lifecycle command，不应通过伪造空 task 表达。
- `pause` 不能丢失平台 session；它只是让 runtime 暂停或释放资源。
- `terminate` 表示 Backend 不再希望 connector 继续保留该 runtime session；是否删除 provider
  侧持久历史由 adapter/config 决定。
- 如果 `terminate` 发生在 active task 中，connector 应先停止该 task，再回 ack。
- `runtime_session_control_ack.session.status` 应为 `active`、`paused`、`terminated` 或
  `error` 中的一个。

### 7.2 `task`（Backend → Connector / control）

`task` 是 v1 的核心启动命令。它必须足够自包含，使 connector 不必额外查一次消息才能开始运行。

```jsonc
{
  "type": "task",
  "v": 1,
  "task_id": "<uuid>",
  "channel_id": "<uuid>",
  "trigger_msg_id": "<uuid>",
  "trigger_seq": 42,
  "depth": 0,
  "trigger": "user_message",
  "placeholder_msg_id": "<uuid>",
  "provider_session_key": "agentnexus:workspace:<workspace_id>:bot:<bot_id>",
  "session_id": "<agentnexus_session_uuid>",
  "session_policy": {
    "on_missing": "create",
    "on_paused": "resume",
    "after_task": "keep_active"
  },
  "trigger_message": {
    "msg_id": "<uuid>",
    "user": "<user_uuid>",
    "sender_name": "Alice",
    "text": "@helper summarize this",
    "timestamp": "2026-06-01T10:15:30Z",
    "msg_type": "text",
    "in_reply_to_msg_id": null
  },
  "attachments": [
    {
      "file_id": "<uuid>",
      "filename": "report.pdf",
      "content_type": "application/pdf",
      "size_bytes": 12345,
      "summary": null,
      "is_image": false
    }
  ],
  "binding_config": {
    "connector_control": {}
  },
  "session": {
    "id": "<agentnexus_session_uuid>",
    "provider_session_key": "agentnexus:workspace:<workspace_id>:bot:<bot_id>",
    "primary_scope_type": "workspace",
    "primary_scope_id": "<workspace_id>"
  },
  "enqueued_at": "2026-06-01T10:15:30Z"
}
```

字段规则：

- `trigger_msg_id` 是触发消息。
- `placeholder_msg_id` 是 bot 需要用 `delta` / `done` 完成的占位消息。
- `session_id` 是 AgentNexus 平台 session，不是 ACP session id。
- `provider_session_key` 是 connector/runtime 侧上下文复用 key。
- `session_policy` 定义 task 对 runtime session 的隐式 create/resume 行为。
- `trigger_message` 和 `attachments` 是 task 启动所需的最小上下文。
- 更多历史上下文通过 `resource_req: channel.context` 获取。

当前实现仍发送最小 `task`，且字段名是 `msg_id`。v1 方向是改成上面的 rich `task`，
不要再让 SDK 等待 data stream 的 `message` 帧。

### 7.3 `delta`（Connector → Backend / data）

```jsonc
{
  "type": "delta",
  "v": 1,
  "msg_id": "<placeholder_msg_id>",
  "seq": 7,
  "delta": "partial text",
  "session_id": "<agentnexus_session_uuid>",
  "provider_session_key": "...",
  "provider_session_id": "runtime-session-id",
  "acp_capability": {}
}
```

规则：

- Backend 校验 `msg_id` 属于当前 bot。
- Connector 的 `seq` 只用于诊断；浏览器流式 `seq` 由 Backend 重新盖戳。
- `delta` best-effort，不落库。

### 7.4 `done`（Connector → Backend / data）

```jsonc
{
  "type": "done",
  "v": 1,
  "client_msg_id": "<uuid>",
  "msg_id": "<placeholder_msg_id>",
  "content": "final answer",
  "file_ids": ["<file_id>"],
  "mention_ids": ["<member_id>"],
  "session_id": "<agentnexus_session_uuid>",
  "provider_session_key": "...",
  "provider_session_id": "runtime-session-id",
  "acp_capability": {}
}
```

成功 ack：

```jsonc
{
  "type": "terminal_ack",
  "v": 1,
  "client_msg_id": "<uuid>",
  "ok": true,
  "msg_id": "<placeholder_msg_id>"
}
```

规则：

- Backend 必须先 finalize PG message，再 fanout `message_done` 给浏览器。
- `done` 幂等：已 finalize 的 `msg_id` 再次到达应返回明确错误或幂等成功，不能重复写 channel_seq。
- 当前实现处理 `done`，但尚未回 `terminal_ack`。

### 7.5 `error` as terminal frame（Connector → Backend / data）

```jsonc
{
  "type": "error",
  "v": 1,
  "client_msg_id": "<uuid>",
  "msg_id": "<placeholder_msg_id>",
  "message": "ACP provider error: rate limit",
  "session_id": "<agentnexus_session_uuid>",
  "provider_session_key": "...",
  "provider_session_id": "runtime-session-id",
  "acp_capability": {}
}
```

这类 `error` 是 connector 报告 runtime 失败，用于结束占位消息。它不同于 Backend →
Connector 的协议错误帧。Backend 应返回 `terminal_ack`。

### 7.6 `send`（Connector → Backend / data）

```jsonc
{
  "type": "send",
  "v": 1,
  "client_msg_id": "<uuid>",
  "channel_id": "<uuid>",
  "text": "proactive message",
  "in_reply_to_msg_id": null,
  "file_ids": [],
  "mention_ids": [],
  "session_id": "<agentnexus_session_uuid>",
  "acp_capability": {}
}
```

成功 ack：

```jsonc
{
  "type": "send_ack",
  "v": 1,
  "client_msg_id": "<uuid>",
  "ok": true,
  "message_id": "<new_msg_id>"
}
```

规则：

- Backend 校验 bot 是 `channel_id` 成员。
- 成功时先写 PG，再 fanout `message`。
- 当前实现处理 `send`，但尚未回 `send_ack`。

### 7.7 `resource_req` / `resource_res`

资源协议独立定义在 [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md)。Agent Bridge v1
只规定它走 data stream：

```jsonc
{
  "type": "resource_req",
  "v": 1,
  "req_id": "r1",
  "resource": "channel.context",
  "params": {
    "channel_id": "<uuid>"
  },
  "acp_capability": {}
}
```

```jsonc
{
  "type": "resource_res",
  "v": 1,
  "req_id": "r1",
  "ok": true,
  "data": {}
}
```

`resource_res` 可以乱序返回，connector 必须按 `req_id` 关联。

### 7.8 `permission_request`

```jsonc
{
  "type": "permission_request",
  "v": 1,
  "client_msg_id": "<uuid>",
  "channel_id": "<uuid>",
  "request_id": "perm_123",
  "task_id": "<uuid>",
  "msg_id": "<placeholder_msg_id>",
  "session_id": "<agentnexus_session_uuid>",
  "provider_session_key": "...",
  "provider_session_id": "runtime-session-id",
  "title": "Allow file edit?",
  "body": "The agent wants to edit /repo/src/main.rs",
  "tool": "fs.edit",
  "options": [
    { "option_id": "allow", "name": "Allow" },
    { "option_id": "deny", "name": "Deny" }
  ],
  "acp_capability": {}
}
```

Backend 先确认审批卡已发布：

```jsonc
{
  "type": "send_ack",
  "v": 1,
  "client_msg_id": "<uuid>",
  "ok": true,
  "message_id": "<approval_message_id>"
}
```

用户审批后，Backend 在 control stream 推：

```jsonc
{
  "type": "permission_resolution",
  "v": 1,
  "request_id": "perm_123",
  "message_id": "<approval_message_id>",
  "resolution": "allow",
  "option_id": "allow",
  "resolved_by": "<user_id>",
  "resolved_at": "2026-06-01T10:16:00Z"
}
```

规则：

- Backend 校验 bot 是目标 channel 成员。
- Backend 校验审批用户有权操作该 channel/message。
- Connector 不得本地伪造审批结果。
- Rust daemon 侧必须等待 `send_ack`，并用 `permission_resolution` 闭环返回 ACP outcome；超时按本地 policy 取消。

### 7.9 Config frames

#### Backend → Connector `config_update`

```jsonc
{
  "type": "config_update",
  "v": 1,
  "revision": 13,
  "settings": {
    "agentNativePermissionMode": "ask",
    "requestTimeoutMs": 120000,
    "promptTimeoutMs": 900000,
    "cwd": "/repo",
    "model": "gpt-5",
    "configOptions": {
      "model": "gpt-5"
    }
  },
  "updated_at": "2026-06-01T10:15:30Z"
}
```

#### Connector → Backend `config_status`

```jsonc
{
  "type": "config_status",
  "v": 1,
  "revision": 13,
  "ok": true,
  "applied": ["promptTimeoutMs", "model"],
  "rejected": []
}
```

#### Connector → Backend `config_options`

```jsonc
{
  "type": "config_options",
  "v": 1,
  "options": {
    "sessionId": "acp-session-id",
    "providerSessionKey": "...",
    "configOptions": []
  }
}
```

#### Backend → Connector `config_option_set`

```jsonc
{
  "type": "config_option_set",
  "v": 1,
  "request_id": "<uuid>",
  "session_id": "acp-session-id",
  "provider_session_key": "...",
  "config_id": "model",
  "value": "gpt-5",
  "updated_at": "2026-06-01T10:15:30Z"
}
```

#### Connector → Backend `config_option_status`

```jsonc
{
  "type": "config_option_status",
  "v": 1,
  "request_id": "<uuid>",
  "ok": true,
  "session_id": "acp-session-id",
  "provider_session_key": "...",
  "config_id": "model",
  "value": "gpt-5",
  "options": {}
}
```

规则：

- Backend 是配置期望的权威存储。
- Connector 是配置应用结果的权威执行方。
- 配置状态应写入 `binding_config.connector_control.*`，不应散落到顶层临时字段。

---

## 8. 错误与关闭码

### 8.1 Backend → Connector error frame

所有 Backend → Connector 的协议错误统一：

```jsonc
{
  "type": "error",
  "v": 1,
  "code": "CAPABILITY_DENIED",
  "detail": "signature expired",
  "request_id": "optional",
  "client_msg_id": "optional",
  "retryable": false
}
```

建议错误码：

| Code | 场景 |
|------|------|
| `PROTOCOL_ERROR` | JSON 形状错误、缺少必填字段 |
| `AUTH_REQUIRED` | 未 auth 就发业务帧 |
| `CAPABILITY_DENIED` | capability delegation 鉴权失败 |
| `NOT_MEMBER` | bot 不在目标 channel |
| `PERMISSION_DENIED` | 平台权限拒绝 |
| `UNKNOWN_RESOURCE` | resource 不存在 |
| `UNSUPPORTED_VERSION` | 协议版本不支持 |
| `E2EE_REQUIRED` | 资源或配置要求 encrypted envelope，但收到明文 |
| `DECRYPT_FAILED` | encrypted envelope 无法解密或认证失败 |
| `BACKPRESSURE` | 队列满或限流 |
| `INTERNAL_ERROR` | 服务端内部错误 |

当前实现中 `delta` / `session_update` 的 error 缺少 `code`，应统一。

### 8.2 Close codes

| Code | 名称 | 是否 fatal | 场景 |
|------|------|------------|------|
| `4401` | `AUTH_FAIL` | 是 | token 无效、过期、auth timeout |
| `4402` | `SUPERSEDED` | 是 | 同一 bot_id 新连接取代旧连接 |
| `4403` | `BOT_UNAVAILABLE` | 是 | bot 状态不是 online 或被禁用 |
| `4408` | `BACKPRESSURE` | 否/可重连 | 服务端队列过载 |
| `4410` | `PROTOCOL_ERROR` | 否/可修复后重连 | 非法帧或版本不兼容 |

当前代码定义了 `4403`，但 `status != online` 仍会走 auth failure 路径；v1 应区分。

---

## 9. 加密与能力签名

Agent Bridge Protocol 采用分层安全策略：

- **默认层级 A**：TLS + 静态加密 + bot token / 设备认证。Backend 可见平台明文，用于路由、
  权限、resource 处理、写库和 fanout。
- **能力签名**：`acp_capability` 解决“谁能对什么资源做什么动作”，与内容加密解耦。
- **bot 级 ACP 端点 E2EE**：通过 `binding_config.acp_security` 作为可选能力下发。
  当前阶段先定义配置、hello 协商和 encrypted envelope；payload 加解密不是 v1 默认要求。
- **群聊全量 E2EE**：未来计划。它会让服务端搜索、RAG、摘要、文件转换等明文能力失效。

这与 [E2EE_NOTES](./E2EE_NOTES.md) 的层级 A/B/C 保持一致：本期默认层级 A，
ACP 端点 E2EE 是 bot 级可选分支，不是平台全局默认。

### 9.1 `acp_security` 协商字段

`acp_security` 由 `bot_accounts.binding_config.acp_security` 归一化后放入 control/data
`hello`。建议字段：

```jsonc
{
  "acp_security": {
    "enabled": true,
    "mode": "X25519-ECDH",
    "algorithm": "ChaCha20-Poly1305",
    "allow_plaintext_fallback": false,
    "require_capability": true,
    "phase": "optional"
  }
}
```

字段含义：

| Field | 说明 |
|-------|------|
| `enabled` | 是否启用 bot 级 ACP 端点加密协商。 |
| `mode` | 密钥协商模式，初始建议 `X25519-ECDH`。 |
| `algorithm` | 对称加密算法，建议 `AES-256-GCM` 或 `ChaCha20-Poly1305`。 |
| `allow_plaintext_fallback` | 加密失败或 connector 不支持时是否允许明文。 |
| `require_capability` | 是否强制 data frame 带 `acp_capability` 签名 envelope。 |
| `phase` | 渐进阶段标记，例如 `off` / `optional` / `required`。 |

### 9.2 明文元数据 + 加密 payload

Agent Bridge 不能把所有字段都加密。Backend 必须看到路由和权限元数据：

- `type`
- `bot_id`
- `channel_id`
- `msg_id`
- `task_id`
- `session_id`
- `provider_session_key`
- `resource`
- `req_id` / `client_msg_id`
- `acp_capability`

敏感业务内容可放入 encrypted envelope：

```jsonc
{
  "type": "resource_req",
  "v": 1,
  "req_id": "r1",
  "resource": "provider.config.update",
  "session_id": "<agentnexus_session_uuid>",
  "provider_session_key": "...",
  "encrypted": true,
  "encrypted_payload": {
    "kid": "bot-key-1",
    "alg": "ChaCha20-Poly1305",
    "nonce": "base64...",
    "aad": {
      "type": "resource_req",
      "req_id": "r1",
      "resource": "provider.config.update",
      "session_id": "<agentnexus_session_uuid>"
    },
    "ciphertext": "base64...",
    "tag": "base64..."
  },
  "acp_capability": {}
}
```

规则：

- AAD 必须覆盖明文路由/权限字段，防止密文被剪贴到另一个 resource/session。
- Backend 可以在不解密 payload 的情况下做 bot、session、resource、capability 校验。
- 需要 Backend 写入消息库并展示给浏览器的最终消息内容，默认仍是明文平台内容。
- 若某个 resource 声明必须加密，但收到明文，返回 `E2EE_REQUIRED`。
- 若密文无法解析或认证失败，返回 `DECRYPT_FAILED`。

### 9.3 哪些内容适合加密

适合加密：

- `provider.config.get/update` 中的 API key、secret、环境变量。
- connector-local runtime config。
- 本地文件系统路径、命令参数中不需要 Backend 理解的敏感部分。
- 将来 ACP 端点 E2EE 模式下的 prompt text、tool payload、delta content。

不适合在 v1 默认加密：

- 路由、权限、审计元数据。
- `permission_request` 的用户可见摘要。
- 需要服务端全文搜索/RAG/摘要/文件转换的 message/file 明文。
- Backend 必须写库并 fanout 给浏览器的普通消息内容。

### 9.4 与 `acp_capability` 的关系

能力签名先于加密层使用：

1. Backend 从明文字段解析 frame type、resource、session context。
2. Backend 校验 `acp_capability` 的签名、scope、action、resource allowlist、nonce。
3. 对声明需要加密的 resource，再检查 encrypted envelope。
4. 对 Backend 不需要读明文的资源，可只存转密文或转交 connector 端处理。

因此 `acp_security.require_capability=true` 不等于 E2EE；它只强制动作授权签名。

### 9.5 本期结论

v1 的结论是：

- 支持 `acp_security` 字段下发。
- 支持协议层 encrypted envelope 形状。
- 对敏感 `provider.config` 类资源预留 `E2EE_REQUIRED` / `DECRYPT_FAILED` 错误。
- 不把 Agent Bridge Protocol 默认改成全量 E2EE。
- 不承诺 Backend 在 v1 能解密/加密所有 payload；内容加解密实现按后续阶段推进。

---

## 10. 时序、超时与可靠性

### 10.1 超时建议

| 项 | 默认 | 说明 |
|----|------|------|
| auth timeout | 10s | WS open 后 10s 内必须收到合法 auth |
| connector ready timeout | 10s | Backend 可暂缓 task 派发；超时标记 bot not ready |
| heartbeat interval | 30s | connector 发送 `ping` |
| heartbeat idle close | 90s | Backend 可关闭长时间无读写的连接 |
| reconnect base | 1s | connector 指数退避起点 |
| reconnect max | 30s | connector 指数退避上限 |
| send/resource ack timeout | 10min | connector 本地等待上限，具体可配置 |
| terminal ack timeout | 30s | `done/error` 应快速 ack |
| permission wait timeout | 15min | runtime 等待用户审批的默认上限，可由配置覆盖 |

这些值是协议建议，具体 connector 可通过 `connector_config.settings` 调整。

### 10.2 顺序

- 单条 WS 内，帧按 WebSocket 顺序到达。
- control 与 data 之间没有全局顺序保证。
- `resource_res` 可以和请求顺序不同，必须用 `req_id` 关联。
- `send_ack` / `terminal_ack` 必须用 `client_msg_id` 关联。
- 浏览器可见的 `message_stream.seq` 由 Backend 生成，不透传 connector 自报 seq。

### 10.3 持久化分层

| 分层 | 帧 | 是否持久化 | 恢复方式 |
|------|----|------------|----------|
| 平台终态 | `task` 创建的 placeholder、`done`、`send`、文件记录 | 是 | REST/resource 重新读取 |
| 流式过程 | `delta`、`trace` | 否 | `done.content` 覆盖，trace 可丢 |
| 控制事件 | `cancel`、`permission_resolution`、`config_update` | 部分持久化状态 | connector 重连后由 hello/config snapshot 对齐 |
| resource 响应 | `resource_res` | 否 | connector 重试 |

### 10.4 Resume

v1 保留：

```jsonc
{
  "type": "resume",
  "v": 1,
  "last_event_seq": 123
}
```

以及：

```jsonc
{
  "type": "resume_ack",
  "v": 1,
  "replayed": 0,
  "up_to_seq": 123
}
```

当前实现状态：

- `data hello.last_event_seq` 固定为 `0`。
- `resume` 被接收但不重放。
- connector 需要通过 `resource_req: channel.activity.read` 或 REST 读取上下文恢复。

v1.1 再引入 durable event_log，并定义哪些 Backend → Connector event 可重放。

---

## 11. 当前实现差距

这部分用于避免“靠临时兼容字段糊过去”。现状与目标契约不一致的地方，应按根因修正。

| 差距 | 根因 | v1 方向 |
|------|------|---------|
| server 发 control `task`，SDK 等 data `message` | 历史协议漂移 | 统一为 control `task`，更新 SDK 类型和 connector 处理 |
| `task` 只有 id，不含 `trigger_message` / attachments | producer 不是自包含 task | dispatcher 构造 rich task frame |
| Backend → Connector 发送模型没有写成协议 | 只写了代码里的 registry/channel 机制 | 按 §2.4 定义 command/event/ack 投递语义 |
| 远端 ACP/runtime session 生命周期没有协议帧 | task 和 session 概念混在一起 | 增加 `runtime_session_control` / `runtime_session_control_ack`，支持 `create/pause/terminate/resume` |
| control hello 没有 `bridge_protocol_version` / `server_capabilities` / `connector_config` | 握手契约未完整定义 | 按 §3.3 补齐 |
| data hello 没有 data capabilities | 握手契约未完整定义 | 按 §3.4 补齐 |
| `ready` 只记录 `plugin_version` | connector 能力未上报 | 按 §3.5 上报 runtime/capabilities |
| `done/error/send/file_upload/permission_request` ack 不完整 | request/ack 关联未落地 | 实现 `terminal_ack` / `send_ack` / `file_upload_ack` |
| `trace` / `file_upload` / terminal `error` server 未处理 | data frame 表未闭合 | 补 handler，或从 SDK 删除未支持 API |
| error 帧有的没有 `code` | 错误 envelope 未统一 | 统一 §8.1 |
| `permission_resolution` 未实现 | 浏览器审批到 connector 路径缺失 | 补 Browser → Backend → control WS 闭环 |
| config 状态写入顶层 `binding_config.config_options` 等 | 配置存储路径不统一 | 统一到 `binding_config.connector_control.*` |
| `resume` no-op | event_log 未实现 | v1 明确 no-op，v1.1 再做 durable replay |
| `4403 BOT_UNAVAILABLE` 未实际区分 | auth/status 错误混合 | status 非 online 关闭 `4403` |
| `acp_security` 只有配置/hello 协商，缺少协议层说明 | 旧 E2EE 设计未合并进 Agent Bridge Protocol | 按 §9 定义可选 encrypted envelope、明文元数据和 `E2EE_REQUIRED` / `DECRYPT_FAILED` |

---

## 12. 实施顺序

### Step 1：定协议面

- 新增/更新 Rust Agent Bridge frame serde：control `task` 为 canonical。
- 新增 Backend → Connector 发送模型：command/event/response 三类。
- 新增 `runtime_session_control` / `runtime_session_control_ack` 类型。
- Backend hello/ready 增加版本和 capabilities。
- error envelope 统一。
- 合并 `acp_security` 协商和 encrypted envelope 规范。

### Step 2：实现 runtime session lifecycle

- Backend 创建/更新 AgentNexus runtime session。
- connector 将 `create/pause/terminate/resume` 映射到 ACP/custom runtime adapter。
- connector 回写 `provider_session_id` 和 session status。
- 明确 task 的 `session_policy` 只做 lazy ensure，不替代 lifecycle command。

### Step 3：修 task producer/consumer

- dispatcher 生成 rich `task`。
- Rust BridgeSession/BridgeRuntime 从 data `message` 改为 control `task`。
- connector runtime 使用 `task.placeholder_msg_id` 做 delta/done。

### Step 4：补 ack 和终态帧

- `done` / terminal `error` 回 `terminal_ack`。
- `send` / `permission_request` 回 `send_ack`。
- `file_upload` 回 `file_upload_ack`。

### Step 5：补控制闭环

- `permission_resolution`。
- `config_update` / `config_option_set`。
- `connector_config` 下发和状态写回。

### Step 6：补 observability 和恢复

- `trace` handler。
- heartbeat idle close。
- `resume_ack` no-op 明确返回。
- 后续 v1.1 event_log replay。

---

## 13. 一句话原则

**Backend 只实现 AgentNexus 平台协议；connector 负责把 ACP 或任何自定义 runtime 协议翻译成这个平台协议。**

这能同时保住两件事：

- AgentNexus 平台层的权限、消息、文件、审批、配置语义不被 ACP 或 vendor 协议污染。
- ACP 和自定义 agent 都能接入，因为差异被限制在 connector adapter 内部。
