# openclaw-channel-agentnexus

OpenClaw channel plugin for **AgentNexus**. One OpenClaw `account` = one AgentNexus `Agent Bridge Bot`, connected over the per-bot control + data WS bridge.

```
┌────────────────────────────┐        ┌───────────────────────────┐
│  OpenClaw (this plugin)    │        │  AgentNexus backend       │
│                            │        │                           │
│  createChatChannelPlugin(  │  ws    │  /ws/agent-bridge/control     │
│    {outbound.sendText,     │◄──────►│     (hello, join/left)    │
│     gateway.start, ...}    │        │                           │
│                            │  ws    │  /ws/agent-bridge/data        │
│   ┌──────────────────┐     │◄──────►│     (message, reply, send)│
│   │  BotSession      │     │        │                           │
│   │   control + data │     │        │                           │
│   └──────────────────┘     │        │  Per-bot token auth       │
└────────────────────────────┘        └───────────────────────────┘
```

## Install

### A. 从 GitHub Release 装预构建 tarball（推荐）

不用 clone 仓库，对方机器只要能上 GitHub 就行：

```bash
# 用 gh CLI（最稳，URL 不会被换行截断）
gh release download openclaw-channel-agentnexus-v0.2.2 \
  -R Grant-Huang/AgentNexus \
  --pattern "*.tgz" \
  --dir /tmp
openclaw plugins install /tmp/openclaw-channel-agentnexus-0.2.2.tgz

# 或直接 curl（URL 必须用引号括住，避免终端换行截断）
curl -L -o /tmp/agentnexus.tgz \
  "https://github.com/Grant-Huang/AgentNexus/releases/latest/download/openclaw-channel-agentnexus.tgz"
openclaw plugins install /tmp/agentnexus.tgz
```

### B. 从源码 link 安装（开发态）

```bash
cd packages/openclaw-channel-agentnexus
npm install
npm run build
openclaw plugins install -l "$(pwd)"      # -l 表示 link，改 dist 重启即生效
```

两种方式都装完后，应在 `openclaw plugins list` 里看到：

```
openclaw-channel-agentnexus  agentnexus  openclaw  loaded  …/dist/index.js  0.2.2
```

如果 `failed to load`：检查 `dist/` 是否齐 + `openclaw.plugin.json` 是否在包根。

---

## Quick start —— 在本机 OpenClaw 跑起来

以下流程在 OpenClaw CLI `2026.4.15` 上实测通过。

### 1. AgentNexus 侧准备一个 Agent Bridge Bot

打开 AdminPage → Bot 管理 → 创建 Bot，选 **Agent Bridge Bot**。弹出的一次性 `agb_...` token **立刻复制**，关闭后只能 rotate。

把 bot 加进想让它工作的频道（频道成员里加 bot）。

### 2. 安装 plugin

按上面 Install 章节，A 或 B 任选。装完 `openclaw plugins list | grep agentnexus` 应该看到 `loaded`。

### 3. 把 bot token 写进 OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`，在顶层 `channels` 下加入：

```jsonc
{
  "channels": {
    "agentnexus": {
      "enabled": true,
      "accounts": {
        "my-bot": {                    // 任意 ID，对应 AgentNexus 里的一个 Agent Bridge Bot
          "enabled": true,
          "botToken": "agb_xxxxxxxxxxxxxxxx",                       // 必填：第 1 步拿到的 token
          "controlUrl": "ws://your-host:8002/ws/agent-bridge/control",  // 必填
          "dataUrl":    "ws://your-host:8002/ws/agent-bridge/data",     // 必填
          "advanced": {                              // 可选，全部有合理默认
            "reconnectBaseMs": 1000,                 // 重连退避起点
            "reconnectMaxMs": 30000,                 // 重连退避上限
            "heartbeatIntervalMs": 30000,            // ping 间隔
            "sendAckTimeoutMs": 600000               // reply/send ack 超时（10 分钟）
          }
        }
        // 想多挂 bot 就再加 "another-bot": { ... }
      }
    }
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `botToken` | ✅ | AgentNexus 创建 Agent Bridge Bot 时弹出的 `agb_...` token，仅该次可见 |
| `controlUrl` | ✅ | bridge 控制流，路径固定 `/ws/agent-bridge/control` |
| `dataUrl` | ✅ | bridge 数据流，路径固定 `/ws/agent-bridge/data` |
| `enabled` | ❌ | 默认 `true`；置 `false` 临时禁用该 account |
| `advanced.*` | ❌ | 重连 / 心跳 / ACK 超时；默认值适合大多数场景 |

**HTTPS 部署**：把 `ws://` 换成 `wss://`，端口换成你前端反代上的 SSL 端口；反代的 `proxy_read_timeout` 不能太短（建议 ≥ 600s，否则 WS 长连会被踢）。

### 4. 重启 gateway 让配置生效

```bash
openclaw daemon restart
openclaw channels status --probe
# - AgentNexus my-bot: enabled
```

验证 AgentNexus 后端是否收到 plugin 连接：

```bash
curl -H "X-Agent-Bridge-Token: <BRIDGE_TOKEN>" http://localhost:8002/api/v1/agent-bridge/status
# data.bot_sessions 应从 0 变成 1（或之前的数 +1）
```

### 5. 发消息联调

在频道里 `@my-bot ...`，`openclaw channels logs | grep agentnexus | tail` 应看到：

```
agentnexus: my-bot ready bot_id=... memberships=1
agentnexus: my-bot inbound channel=ch-... task=... text="@my-bot ..."
```

### 常见踩坑

| 现象 / close code | 原因 | 处理 |
|---|---|---|
| `4401 token invalid` | token 复制时多了空格/换行；或用了 hash 后的存储值 | 重新 rotate 拿原文 token |
| `4402 superseded` | 多台机器用了同一 token | 让旧实例退出 |
| `4403 bot offline` | AgentNexus 里 bot status = `offline` | 改回 `online` |
| 连不上 / `ECONNREFUSED` | URL 写错（端口、host、是否走反代） | 后端默认 `8002`，不是 `8000` |
| 连得上但收不到 message | bot 没在 channel 成员里 | 频道成员加 bot |

### 已知 TODO：真正把消息推进 OpenClaw agent

截至当前版本，plugin 做到了「连上 bridge、接收 membership、收到用户入站消息」。把
`onMessage` 中拿到的消息**转交给某个 OpenClaw agent 跑一轮**并回 `sendText` —— 需要
SDK 的 `ChannelGatewayContext.runtime` helpers，这些在 2026.4.15 SDK 里还不是稳定
公开 API。请参考 plugin.ts 里 `onMessage` 内的 TODO 注释。

在那之前，如果你只是想让它在 AgentNexus 里跑一个 echo/自定义逻辑的 Bot，推荐走
**独立模式**（下面）—— 绕过 OpenClaw SDK，直接用 `BotSession` 当 WS 客户端。

## 独立使用（不走 OpenClaw SDK）

`BotSession` 是一个独立可用的 Node 类。在没有 OpenClaw SDK 的环境里可以直接：

```ts
import { BotSession } from "openclaw-channel-agentnexus";

const session = new BotSession(
  {
    botToken: process.env.AGENTNEXUS_BOT_TOKEN!,
    controlUrl: "ws://localhost:8002/ws/agent-bridge/control",
    dataUrl: "ws://localhost:8002/ws/agent-bridge/data",
  },
  {
    onReady: () => console.log("ready", session.botId),
    onMessage: async (m) => {
      const r = await session.reply({ source: m, text: `echo: ${m.text}` });
      console.log("reply:", r);
    },
    onChannelJoined: (ch) => console.log("joined", ch.channel_id),
    onChannelLeft: (id, reason) => console.log("left", id, reason),
    onFatal: (reason) => console.error("fatal:", reason),
  },
);

session.start();
```

内置 `src/demo.ts` 就是这个用法的完整可执行版（`npm run demo`）。

## 协议速查

### control → plugin

```jsonc
{ "type": "hello", "bot_id": "...", "session_id": "...",
  "memberships": [{"channel_id": "...", "channel_name": "...", ...}] }

{ "type": "channel_joined", "channel": {...}, "invited_by": "..." }
{ "type": "channel_left", "channel_id": "...", "reason": "kicked|left" }
```

### plugin → control

```jsonc
{ "type": "ping" }                         // heartbeat
{ "type": "ready", "plugin_version": "1.0.0" }
```

### data → plugin

```jsonc
{ "type": "hello", "stream": "data", "bot_id": "...", "last_event_seq": 42 }

{ "type": "message", "seq": 43,
  "bot_id": "...", "channel_id": "...",
  "task_id": "...", "placeholder_msg_id": "...",
  "trigger_message": { "user": "...", "sender_name": "...", "text": "...",
                        "timestamp": "...", "msg_id": "..." },
  "memory_context": {...},
  "attachments": [...],
  "binding_config": {...} }

{ "type": "send_ack", "client_msg_id": "...", "ok": true, "message_id": "...",
  "finalized_placeholder": true }
{ "type": "send_ack", "client_msg_id": "...", "ok": false, "code": "...", "error": "..." }

{ "type": "resume_ack", "replayed": N, "up_to_seq": M }
```

### plugin → data

```jsonc
{ "type": "reply", "client_msg_id": "...", "task_id": "...",
  "reply_to_msg_id": "...", "channel_id": "...", "text": "..." }

{ "type": "send", "client_msg_id": "...", "channel_id": "...",
  "text": "...", "in_reply_to_msg_id": "...", "file_ids": [] }

{ "type": "resume", "last_event_seq": 42 }
{ "type": "ping" }
```

### Close codes

| code | 语义 | plugin 处理 |
|------|------|-------------|
| 1000 | normal | 正常 |
| 1011 / 1006 / ... | 瞬时网络错 | 自动重连（指数退避 + 50-100% jitter） |
| 4401 | token 缺失 / 无效 / 已撤销 | **fatal**：session 自动 stop，触发 onFatal |
| 4402 | 被同 token 的新连接接管 | **fatal**：不自动重连（否则与对方 ping-pong）。需人工干预或确认旧实例应退出 |
| 4403 | bot.status != online | **fatal**：等 admin 改回 online |

收到 fatal 码时 `onFatal(reason)` 触发，session 自动 stop；需要新实例重启才能再次连接（构造新的 `BotSession`）。

## 与 OpenClaw SDK 的关系

目前这个包里用 `src/sdk-shim.ts` 声明了一份**本地的** SDK 类型 —— 这是为了在 OpenClaw 的真实包发布/接入前先让代码可编译。当拿到真实 SDK 时，把 `plugin.ts` / `index.ts` / `setup-entry.ts` 里 `./sdk-shim.js` 的 import 换成

```ts
import {...} from "openclaw/plugin-sdk/channel-core";
```

即可，类型 shape 已对齐文档 (`https://docs.openclaw.ai/plugins/sdk-channel-plugins`)。

## 脚本

```bash
npm install
npm run build        # tsc → dist/
npm test             # 全部测试：reconnect 数学 + mock bridge 驱动 session 行为 + 集成
npm run demo         # 需 env：AGENTNEXUS_BOT_TOKEN / CONTROL_URL / DATA_URL
```

### 测试分层

- **`test/reconnect.test.ts`** —— 纯数学：backoff 计算、致命码判定
- **`test/session.test.ts`** —— 启动本地 mock bridge（`test/mock-bridge.ts`）驱动 session 跑完整交互路径：
  - hello + membership 加载
  - channel_joined / channel_left 同步
  - message → reply → send_ack 完整来回
  - send() 主动发话
  - reply timeout（mock 吃掉不回 ack）
  - 4402 supersede → fatal → session.stop
  - 非致命断连后自动重连 + 自动 `resume{last_event_seq}`
  - 错 token upgrade 拒绝
- **`test/session.integration.test.ts`** —— 对真实 AgentNexus bridge 做 hello 握手（`AGENTNEXUS_BOT_TOKEN / CONTROL_URL / DATA_URL` 缺一即 skip）

## 容量与背压

- BotSession 的 inflight send 软上限 500 条；超过返回 `code=backpressure`。
- plugin.ts 的 `lastInboundByTaskId` 按近似 LRU 截到 1000 条，防止 agent 永不回复造成内存泄漏。
- 重连指数退避上限 30s（可通过 `advanced.reconnectMaxMs` 覆盖），发生 fatal 码时立即停止。

## 生产建议

1. `botToken` 存 secrets / 密钥管理系统，不要硬编码
2. 为每个 bot 部署单实例（4402 fatal 后需外部编排把它重新起来）
3. 给 `BotSession` 传 `advanced.heartbeatIntervalMs` ≤ 反向代理的 idle 超时
4. 监控 `status.getStatus` 的 `state`：`running` / `stopped` 都是确定状态
