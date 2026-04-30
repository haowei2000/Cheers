# OpenClaw Channel Plugin ↔ AgentNexus 接入指南

把 OpenClaw agent 接入 AgentNexus，让它作为一个 "WebSocket Bot" 出现在频道里，被 `@mention` 时自动响应。

本文档覆盖：
- 架构与协议（后端 ↔ plugin ↔ OpenClaw）
- 两种接入方式（独立模式 / OpenClaw plugin 模式）
- 配置参考
- 安全模型
- 已知限制与 TODO

**验证环境**：AgentNexus `feat/openclaw-channel-plugin` 分支；`openclaw` CLI 2026.4.15；macOS（Linux 类似）。

> ⚠️ **分支要求**：TS plugin 包在 `packages/openclaw-channel-agentnexus/`。在 feature branch 合进 `develop` 之前，操作前请先：
> ```bash
> cd /path/to/AgentNexus                       # 项目根
> git checkout feat/openclaw-channel-plugin
> git pull
> ```
> 合并到 `develop` 之后这一步可以省略。

---

## 1. 架构总览

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  OpenClaw runtime           │         │  AgentNexus backend          │
│                             │         │                              │
│  ┌──────────────────────┐   │         │  ┌────────────────────────┐  │
│  │ agentnexus plugin    │   │  WS     │  │ /ws/openclaw/control   │  │
│  │  (channel adapter)   │◄────────────│►│  （hello/join/left）   │  │
│  │                      │   │         │  └────────────────────────┘  │
│  │  BotSession          │   │  WS     │  ┌────────────────────────┐  │
│  │  ├── control client  │◄────────────│►│  /ws/openclaw/data     │  │
│  │  └── data client     │   │         │  │ （message/reply/send） │  │
│  └──────────────────────┘   │         │  └────────────────────────┘  │
│           ▲                 │         │           │                  │
│           │ startAccount    │         │           │                  │
│           │ outbound.sendText│        │           ▼                  │
│  ┌──────────────────────┐   │         │  ┌────────────────────────┐  │
│  │  OpenClaw agent turn │   │         │  │ Orchestrator + frontend│  │
│  └──────────────────────┘   │         │  │ @bot → 派发 → 回复广播 │  │
└─────────────────────────────┘         │  └────────────────────────┘  │
                                        └──────────────────────────────┘
```

一个 OpenClaw `account` 对应一个 AgentNexus `WebSocket Bot`（`binding_type = "websocket"`）。
同一 OpenClaw 实例里可以挂多个 account，对应 AgentNexus 里多个独立 Bot。

### 组件职责

| 组件 | 在谁那 | 做什么 |
|---|---|---|
| `/ws/openclaw/control` | AgentNexus backend | 发 `hello`（membership 快照）+ 推 `channel_joined / channel_left` |
| `/ws/openclaw/data` | AgentNexus backend | 推 `message` 事件；接受 `reply / send` 帧；支持 `resume` |
| `POST /api/v1/bots/{id}/rotate-token` | AgentNexus backend | 生成新 bot token（旧的立即作废） |
| `BotSession` | TS plugin 包 | 管理一对 control+data 连接、重连、ack 跟踪 |
| `agentnexusPlugin` | TS plugin 包 | 实现 OpenClaw `ChannelPlugin` 契约，`startAccount` 时 spawn session |
| OpenClaw CLI | OpenClaw 自带 | `plugins install` / `channels status` / `daemon restart` |

---

## 2. 准备工作

### 2.1 AgentNexus 后端

```bash
# 启动 docker 栈
cd /path/to/AgentNexus
docker compose up -d

# 应用 Alembic 迁移（首次必需，含 030/031/032）
docker exec agentnexus-backend-1 /app/.venv/bin/alembic upgrade head
```

后端默认监听：
- HTTP：`http://localhost:8002`（`BACKEND_HOST_PORT` 可配）
- WS：`ws://localhost:8002/ws/openclaw/{control,data}`

### 2.2 OpenClaw CLI

```bash
# 确认已安装
openclaw --version         # 推荐 2026.4.15+

# 确认 gateway 能启动
openclaw daemon status     # Runtime: running
```

如果 `openclaw` 命令没有，按官方指南装（homebrew / npm）。

### 2.3 Node 环境

构建 plugin 需要 Node 20+。

```bash
node -v                    # v20+ ideal
```

---

## 3. 接入方式一：独立模式（最快能跑）

**适用场景**：你想验证 bridge 协议、或只需要一个轻量 Node 进程充当 Bot。不经过 OpenClaw runtime。

### 3.1 建一个 WebSocket Bot

在 AgentNexus 管理面板 (`http://localhost/admin`) → Bot 管理 → 创建 Bot：

- 绑定类型：**WebSocket Bot**
- 用户名：自定（例如 `oc-demo`）
- 显示名：任意
- 点「创建 Bot」

弹窗显示**一次性** `bot_token`（`ocw_...`），**立刻复制**。关闭后只能 `rotate`。

把该 Bot 加入某频道（Bot 列表 → 添加到项目）。

### 3.2 构建 plugin

```bash
# 先从项目根开始，避免 shell 残留在其它目录
cd /path/to/AgentNexus
cd packages/openclaw-channel-agentnexus
npm install
npm run build
```

### 3.3 跑 demo

```bash
AGENTNEXUS_BOT_TOKEN=ocw_粘贴刚复制的 \
AGENTNEXUS_CONTROL_URL=ws://localhost:8002/ws/openclaw/control \
AGENTNEXUS_DATA_URL=ws://localhost:8002/ws/openclaw/data \
  npm run demo
```

输出：

```
[demo] data open
[demo] control open
[demo] ready bot_id=... memberships=1
```

在 AgentNexus 频道里 `@oc-demo 你好` → demo 立刻回一条 `echo: @oc-demo 你好`，占位消息被原地 finalize（同一 msg_id）。

### 3.4 自定义回复逻辑

编辑 `packages/openclaw-channel-agentnexus/src/demo.ts`，把 `session.reply({ source: m, text: \`echo: ${m.text}\` })` 替换成你的实际处理（调 LLM、查 DB、跑 skill 等）。

---

## 4. 接入方式二：OpenClaw Plugin 模式

**适用场景**：你希望 OpenClaw runtime 管理这个 channel，在 `openclaw channels status`、`openclaw plugins list` 里能看到，后面由 OpenClaw agent 自动响应（见 §8 TODO）。

### 4.1 构建 + 安装

```bash
# 从项目根开始
cd /path/to/AgentNexus
cd packages/openclaw-channel-agentnexus
npm install
npm run build

# $(pwd) 必须解析为 packages/openclaw-channel-agentnexus 绝对路径
openclaw plugins install -l "$(pwd)"
```

**常见错误**：
- `HOOK.md missing in ...` —— 你在错误的目录（比如 `docs/develop/`）。OpenClaw 把该目录当作 hook pack 识别失败。解法：`cd` 到 `packages/openclaw-channel-agentnexus/` 再执行。
- `plugin manifest not found: .../openclaw.plugin.json` —— `dist/` 没构建出来，或包根目录没有 `openclaw.plugin.json`。先跑 `npm run build`。
- `cd: no such file or directory: packages/...` —— 当前分支没有 `packages/`。按本文档顶部提示先 `git checkout feat/openclaw-channel-plugin`。

`-l` 表示 link 模式（不拷贝 dist/，改 dist/ 后重启 gateway 即生效）。

验证：

```bash
openclaw plugins list | grep agentnexus
# openclaw-channel-agentnexus  agentnexus  openclaw  loaded  …/dist/index.js  0.1.0
```

### 4.2 在 AgentNexus 建 WS Bot 并拿 token

同 §3.1。

### 4.3 把 token 写进 OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`，在顶层 `channels` 下加入：

```jsonc
{
  "channels": {
    "agentnexus": {
      "enabled": true,
      "accounts": {
        "my-bot": {
          "enabled": true,
          "botToken": "ocw_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "controlUrl": "ws://localhost:8002/ws/openclaw/control",
          "dataUrl": "ws://localhost:8002/ws/openclaw/data",
          "advanced": {
            "reconnectBaseMs": 1000,
            "reconnectMaxMs": 30000,
            "heartbeatIntervalMs": 30000,
            "sendAckTimeoutMs": 10000
          }
        }
      }
    }
  }
}
```

`accounts` 下的 key（此处 `my-bot`）是 OpenClaw 侧的 accountId，与 AgentNexus 侧的 bot username 不必相同。多个 key 表示多个独立 bot。

### 4.4 重启 gateway + 验证

```bash
openclaw daemon restart
sleep 3
openclaw channels status --probe
# Gateway reachable.
# - AgentNexus my-bot: enabled
```

AgentNexus 侧检查：

```bash
# 需要一个 bridge debug token；.env 里的 OPENCLAW_BRIDGE_TOKEN
curl -H "X-OpenClaw-Token: <BRIDGE_TOKEN>" \
  http://localhost:8002/api/v1/openclaw/bridge/status
```

预期 `bot_sessions: 1`（plugin 已连上）。

### 4.5 发消息联调

把 bot 加入 AgentNexus 频道后 `@my-bot ...`：

```bash
openclaw channels logs | grep agentnexus | tail
# agentnexus: my-bot ready bot_id=... memberships=1
# agentnexus: my-bot inbound channel=ch-... task=... text="@my-bot 你好"
```

**注意**：截至本文件写作时，plugin 把 inbound message 推进 OpenClaw agent turn 的那一环还没接通（见 §8）。如果你现在就要让它回复，把 plugin 的 `src/plugin.ts` 里 `onMessage` 改成直接调 `session.reply(...)`，同样能回一条消息到 AgentNexus 频道。

---

## 5. 配置参考

### 5.1 `~/.openclaw/openclaw.json` 下的 plugin 配置

```jsonc
"channels.agentnexus": {
  "enabled": true,                     // 整个 channel 开关
  "accounts": {
    "<accountId>": {
      "enabled": true,                 // 账号级开关
      "botToken": "ocw_...",           // 必填；AgentNexus 创建 WS Bot 时一次性返回
      "controlUrl": "ws://host/ws/openclaw/control",  // 必填
      "dataUrl":    "ws://host/ws/openclaw/data",     // 必填
      "advanced": {
        "reconnectBaseMs": 1000,       // 重连退避起点；默认 1000
        "reconnectMaxMs": 30000,       // 重连退避上限；默认 30000
        "heartbeatIntervalMs": 30000,  // plugin → backend 的 ping 间隔；默认 30000
        "sendAckTimeoutMs": 10000      // reply/send 等 send_ack 的超时；默认 10000
      }
    }
  }
}
```

### 5.2 AgentNexus 后端 `.env`

```bash
# 桥接开关（生产建议 true）
OPENCLAW_BRIDGE_ENABLED=true

# 后端调试/监控专用的共享 token（仅用于 /bridge/status 等只读端点）
# 与 plugin 用的 per-bot token 无关
OPENCLAW_BRIDGE_TOKEN=change-me

# 后端对 WebSocket Bot dispatch 的超时；超时后占位消息自动 finalize 为
# "[WebSocket Bot] 等待 OpenClaw channel plugin 回推超时（>Ns）"
OPENCLAW_BRIDGE_TIMEOUT_SECONDS=60
```

---

## 6. 协议参考

### 6.1 连接鉴权

两条 WS 都用同一个 `bot_token`：

```
Authorization: Bearer ocw_...
```

Header 是首选；调试时可用 `?token=ocw_...` 查询参数，但生产不推荐（会进 access log）。

### 6.2 Close codes

| code | 语义 | plugin 侧处理 |
|------|------|--------------|
| 1000 | normal | 正常退出 |
| 1011 / 1006 / ... | 瞬时错误 | 指数退避 + jitter 自动重连 |
| **4401** | token 缺失 / 无效 / 已撤销 | **fatal**：停止重连，触发 `onFatal` |
| **4402** | 同 token 的新连接接管了本连接 | **fatal**：不自动重连（否则 ping-pong） |
| **4403** | bot.status != online | **fatal**：等 admin 恢复 |

### 6.3 Control 流

**入站（server → plugin）**

```jsonc
// 连接后首帧
{ "type": "hello", "bot_id": "...", "bot_username": "...", "session_id": "...",
  "memberships": [{"channel_id":"...","channel_name":"...","channel_type":"public","workspace_id":"...","joined_at":"..."}] }

// 成员变更（幂等；plugin 应去重）
{ "type": "channel_joined", "channel": {...}, "invited_by": "u-001" }
{ "type": "channel_left",   "channel_id": "...", "reason": "kicked" | "left" }

{ "type": "pong" }
```

**出站（plugin → server）**

```jsonc
{ "type": "ping" }
{ "type": "ready", "plugin_version": "1.0.0" }
```

### 6.4 Data 流

**入站**

```jsonc
// 连接后首帧：带 last_event_seq
{ "type": "hello", "stream": "data", "bot_id": "...", "session_id": "...", "last_event_seq": 42 }

// 用户 @mention Bot，orchestrator 派发过来
{
  "type": "message",
  "seq": 43,                              // 全局递增，resume 时用
  "bot_id": "...",
  "channel_id": "...",
  "task_id": "...",                       // 一次 orchestrator 触发的 id
  "placeholder_msg_id": "...",            // plugin reply 时带回这个 id 即原地 finalize
  "trigger_message": {
    "user": "...", "sender_name": "...", "text": "@bot 你好",
    "timestamp": "...", "msg_id": "...", "in_reply_to_msg_id": null
  },
  "session": {
    "id": "...",                           // AgentNexus 持有的稳定 session_id
    "openclaw_session_key": "agent:...:session:...",
    "openclaw_account_id": "my-bot",
    "openclaw_agent_id": "agent-main",
    "primary_scope_type": "channel",       // channel | dm | topic
    "primary_scope_id": "...",
    "task_scope_id": "..."
  },
  "openclaw_session_key": "agent:...:session:...", // 兼容字段；同 session.openclaw_session_key
  "memory_context": { "anchor":"...", "decisions":"...", "files_index":"...", "recent":"..." },
  "attachments": [{"file_id":"...","filename":"...","content_type":"...","size_bytes":..., "summary":"..."}],
  "binding_config": { "agent_id": "..." }  // 从 AgentNexus Bot 的 binding_config 原样透传
}

// plugin 侧 reply/send 的 ack
{ "type": "send_ack", "client_msg_id": "...", "ok": true, "message_id": "...", "finalized_placeholder": true }
{ "type": "send_ack", "client_msg_id": "...", "ok": false, "code": "not_member", "error": "..." }

// resume 完成
{ "type": "resume_ack", "replayed": N, "up_to_seq": M }
```

**出站**

```jsonc
// finalize 某条占位消息（最常用）
{ "type": "reply", "client_msg_id": "uuid",
  "task_id": "...", "reply_to_msg_id": "placeholder-msg-id",
  "channel_id": "...", "text": "...", "file_ids": [] }

// 主动在某频道发（非响应用）
{ "type": "send", "client_msg_id": "uuid", "channel_id": "...",
  "text": "...", "in_reply_to_msg_id": null, "file_ids": [] }

// 断线重连后立刻发，补推 seq>N 的所有 message
{ "type": "resume", "last_event_seq": 42 }

{ "type": "ping" }
{ "type": "typing", "channel_id": "..." }  // 可选，当前 server 忽略
```

### 6.5 安全校验（server 侧强制）

每条 `reply / send` 进来都会：

1. Bot 必须是 `binding_type=websocket`
2. Bot 必须是 target `channel_id` 的 `ChannelMembership.bot` 成员（跨频道注入 → 403）
3. Bot `status` 必须是 `online`（否则 409）
4. `file_ids` 里每个文件必须属于同一频道（跨频道附件越权 → 403）
5. `in_reply_to_msg_id` 指向的消息必须在同频道（跨频道 thread 污染 → 403）
6. `reply_to_msg_id` 匹配 `pending_replies` 时，**bot_id 必须一致** —— plugin A 不能 finalize plugin B 的占位

### 6.6 Session 映射

AgentNexus 不把 OpenClaw runtime 的 `sessionId` 当持久主键，而是自己生成稳定 `session_id`，并维护：

- `agentnexus_sessions`：`session_id`、`bot_id`、`openclaw_account_id`、`openclaw_agent_id`、`openclaw_session_key`
- `agentnexus_session_bindings`：`channel / dm / topic / task` scope 到 `session_id` 的绑定

派发时后端会按 `task_id` 优先命中已有 task alias；否则按 `topic > dm > channel` 命中 primary scope。普通频道消息才占用 `channel` 绑定；同一频道里的不同 topic/task 可以分别绑定独立 session。从 task 视图回流到频道表面时，只复用该 task 的 session，不会把整个 channel 重新绑定到这个 task session。TS plugin 会优先使用 `event.session.openclaw_session_key`，旧后端没有该字段时才退回 `agentnexus:<accountId>:<channelId>`。

多 account 场景下，每个 OpenClaw account 建议对应一个 AgentNexus WebSocket Bot 和一份独立 bot token。若希望后台数据里直接显示 OpenClaw 配置里的 accountId，可在 Bot 的 `binding_config` 中写入：

```jsonc
{
  "account_id": "my-bot",
  "agent_id": "agent-main"
}
```

---

## 7. 安全模型

### 7.1 Per-bot token

- 每个 WebSocket Bot 有自己独立的 `bot_token`，在 AgentNexus 创建 Bot 时一次性返回（`ocw_<43chars>`）
- 后端只存 pbkdf2_sha256 哈希（`bot_token_hash`）+ 前 8 字符明文（`bot_token_prefix`）用于索引
- **明文不入 DB，不入日志**
- 一次 token 泄漏只影响一个 Bot

### 7.2 Token 轮换

```
POST /api/v1/bots/{bot_id}/rotate-token
```

- 返回新明文一次性
- 哈希立刻覆盖，旧 token 失效
- 旧 token 的活跃 WS 连接会在下次 ping 或重连时被 4401 拒绝

### 7.3 承担的威胁

| 威胁 | 缓解 |
|---|---|
| Plugin 冒充其他 Bot 发消息 | token 绑 bot_id，POST/WS 都强校验 Bot 成员关系 |
| Plugin 订阅其他 Bot 的派发流 | data WS 连接后只接收该 bot_id 的 dispatch |
| Task_id 抢答 / 抢 finalize 占位 | `pending_replies.resolve` 按 `bot_id` 匹配 |
| 跨频道附件越权 | file_id 必须在同一 `channel_id` |
| 主动 `send` 到非成员频道 | Bot ∈ channel 成员校验 |

### 7.4 没做的（生产前要考虑）

- **事件日志保留策略** —— `openclaw_plugin_events` 当前无限增长；需要 cron prune
- **服务端主动心跳超时踢连接** —— 当前只靠 plugin 侧 ping；plugin 卡死时需外部监控
- **TLS** —— 文档里示例用 `ws://`；生产必须 `wss://`，配反向代理
- **Plugin 被打穿的横向移动** —— 单 token 只影响 1 个 Bot，但若机器上多个 Bot token 都泄漏则无额外隔离

---

## 8. 已知限制与 TODO

### 8.1 OpenClaw agent 自动响应

Plugin 模式已经通过 `registerFull` 注册自 loopback HTTP 路由：

1. WS `message` 入站后，`plugin.ts` 将消息转发到 `POST /plugins/agentnexus/inbound`
2. 该 handler 处于 gateway request scope，可合法调用 `runtime.subagent.run`
3. handler 先把 `sessionKey → {channel: "agentnexus", accountId, conversationId: taskId}` 写入 SessionBinding
4. 再调用 `runtime.subagent.run({ sessionKey, message, deliver: true, idempotencyKey: taskId })`
5. agent 输出经 `outbound.sendText/sendMedia` 回到 `session.reply` / streaming delta，最终原地 finalize AgentNexus 占位消息

如果 `registerFull` 尚未执行或 HTTP route 不可达，plugin 会回一条诊断消息到 AgentNexus 频道，便于区分 bridge 已通但 OpenClaw runtime 未就绪的情况。

### 8.2 事件日志无保留策略

`openclaw_plugin_events` 表随着 dispatch 数量单调增长。生产前需要：

```sql
-- 例如只保留 7 天
DELETE FROM openclaw_plugin_events WHERE created_at < now() - interval '7 days';
```

或配一个定时任务（cron、apscheduler 等）。

### 8.3 同 token 只能一个活跃连接

- 新连接进来，旧连接被关 4402 —— 这是刻意设计
- 两台机器用同一 token 跑 plugin 会相互踢；**每台机器用独立 bot + 独立 token**

### 8.4 offline bot 的 plugin 连接行为

- `bot.status != online` 时 WS 连接被 4403 拒绝
- Plugin 若在 bot 变 offline 时正好活跃，下次发 ping / 重连会被踢
- 想"暂停 bot"但保持连接：当前不支持（可改 `binding_config` 里加一个软开关，但得改后端 adapter）

---

## 9. 开发 & 测试

### 9.1 单元测试

```bash
cd packages/openclaw-channel-agentnexus
npm test
```

分层：
- `test/reconnect.test.ts` —— 纯数学（backoff、fatal code 分类）
- `test/session.test.ts` —— 用 `test/mock-bridge.ts` 起本地 WS server 驱动 `BotSession`，覆盖 hello / 成员事件 / reply→ack 全链路 / 4402 supersede / 自动 resume
- `test/session.integration.test.ts` —— 连真 backend 做握手；缺 env 自动 skip

### 9.2 改完 plugin 后

```bash
npm run build
openclaw daemon restart
openclaw channels logs | tail
```

用 `-l`（link 模式）安装时不需要重新 `plugins install`。

### 9.3 完全下架

```bash
echo y | openclaw plugins uninstall agentnexus
# config 中的 channels.agentnexus 条目也会一并清掉
openclaw daemon restart
```

AgentNexus 侧把 Bot 的 `binding_type` 改成 `http`（如果要复用该 Bot）或直接删掉。

---

## 10. 故障排查

| 现象 | 可能原因 | 排查 |
|---|---|---|
| `openclaw plugins install` 报 `plugin manifest not found` | 缺 `openclaw.plugin.json` | 检查包根目录有这个文件（不是 package.json 里的 `openclaw` 字段） |
| `openclaw plugins list` 看不到 agentnexus | build 没跑 | `ls dist/` 应有 `index.js`、`plugin.js` |
| `channels status --probe` 不显示 account | 配置路径错 | 确认是 `channels.agentnexus.accounts`，不是 `agentnexus.accounts` |
| `bot_sessions: 0` 但 plugin 已 loaded | token 不对 / WS URL 写错 | 看 `openclaw channels logs`，应该有 `agentnexus: ... control open`；否则看 AgentNexus 后端日志 |
| 连上但很快 4401 断开 | token 已被 rotate | AdminPage 重新 rotate-token，更新配置，重启 gateway |
| 连上但总是 4402 | 另一个进程 / 机器用了同 token | 确认只有一处在跑；每 Bot 一份 token |
| `openclaw channels logs` 无 `inbound`，但 AgentNexus 用户已 @ | bot 不在频道成员里 | AdminPage 把 bot 加入频道；或检查 binding_type 是否真的是 `websocket` |
| reply 返回 `code=not_member` | bot 不在 target 频道 | 用 `/api/v1/channels/{id}/members` 检查成员关系 |
| reply 返回 `code=file_cross_channel` | 附件文件属于别的频道 | 只能 attach 当前频道上传过的 file_id |
| reply 返回 `code=ack_timeout` | backend 没回 ack；网络抖或 backend 挂了 | 查 backend 日志；调大 `sendAckTimeoutMs` |

---

## 11. 参考

- 包源码：[`packages/openclaw-channel-agentnexus/`](../../packages/openclaw-channel-agentnexus/)
- AgentNexus 后端 bridge 路由：[`backend/app/api/v1/openclaw_bridge/routes.py`](../../backend/app/api/v1/openclaw_bridge/routes.py)
- AgentNexus adapter：[`backend/app/services/adapters/websocket_bot.py`](../../backend/app/services/adapters/websocket_bot.py)
- 会话/派发注册表：[`backend/app/services/openclaw_bridge/registry.py`](../../backend/app/services/openclaw_bridge/registry.py)
- 事件日志 / resume：[`backend/app/services/openclaw_bridge/event_log.py`](../../backend/app/services/openclaw_bridge/event_log.py)
- OpenClaw SDK 本地路径：`/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/` （参考 shape，非稳定 API）

分支 `feat/openclaw-channel-plugin` 的所有 commits 记录了接入过程：token 模型 → control WS → data WS → resume → 前端 → TS plugin 骨架 → 本机 OpenClaw 接入。
