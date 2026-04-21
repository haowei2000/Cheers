# openclaw-channel-agentnexus

OpenClaw channel plugin for **AgentNexus**. One OpenClaw `account` = one AgentNexus `WebSocket Bot`, connected over the per-bot control + data WS bridge.

```
┌────────────────────────────┐        ┌───────────────────────────┐
│  OpenClaw (this plugin)    │        │  AgentNexus backend       │
│                            │        │                           │
│  createChatChannelPlugin(  │  ws    │  /ws/openclaw/control     │
│    {outbound.sendText,     │◄──────►│     (hello, join/left)    │
│     gateway.start, ...}    │        │                           │
│                            │  ws    │  /ws/openclaw/data        │
│   ┌──────────────────┐     │◄──────►│     (message, reply, send)│
│   │  BotSession      │     │        │                           │
│   │   control + data │     │        │                           │
│   └──────────────────┘     │        │  Per-bot token auth       │
└────────────────────────────┘        └───────────────────────────┘
```

## Quick start

### 1. 在 AgentNexus 创建 WebSocket Bot

打开 AdminPage → Bot 管理 → 创建 Bot，选 **WebSocket Bot**。创建后会弹出一个一次性的 `ocw_...` token —— 复制下来。

### 2. 配置 OpenClaw（channel plugin 侧）

把 token 填到 OpenClaw 的 channel 配置里：

```jsonc
{
  "channels": {
    "agentnexus": {
      "accounts": {
        "my-bot": {
          "enabled": true,
          "botToken": "ocw_xxxxxxxxxxxxxxxx",
          "controlUrl": "ws://agentnexus.example.com/ws/openclaw/control",
          "dataUrl": "ws://agentnexus.example.com/ws/openclaw/data",
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

一个 OpenClaw 实例里可以放多个 account —— 每个 account 对应 AgentNexus 里一个独立的 WebSocket Bot。

### 3. 把 plugin 扔给 OpenClaw

```ts
import plugin from "openclaw-channel-agentnexus";
// 真实 SDK 接入方式参考 OpenClaw plugin docs
```

## 独立使用（不走 OpenClaw SDK）

`BotSession` 是一个独立可用的 Node 类。在没有 OpenClaw SDK 的环境里可以直接：

```ts
import { BotSession } from "openclaw-channel-agentnexus";

const session = new BotSession(
  {
    botToken: process.env.AGENTNEXUS_BOT_TOKEN!,
    controlUrl: "ws://localhost:8002/ws/openclaw/control",
    dataUrl: "ws://localhost:8002/ws/openclaw/data",
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
