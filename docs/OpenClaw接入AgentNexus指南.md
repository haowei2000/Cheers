# OpenClaw 接入 AgentNexus 指南

## 一、架构说明与模式选择

AgentNexus 支持两种模式与 OpenClaw 通信，选择不同，用户体验不同：

### 模式对比

| 模式 | endpoint 前缀 | 说明 | 用户是否能看到真实 AI 回复 |
|------|--------------|------|--------------------------|
| **WS 模式（推荐）** | `ws://` 或 `wss://` | 通过 WebSocket JSON-RPC 调用，同步等待 AI 完整回复 | ✅ 能，实时写入聊天频道 |
| **HTTP 模式** | `http://` 或 `https://` | 调用 `/hooks/agent`，fire-and-forget | ❌ 不能，仅显示"已接收请求，正在处理…" |

> **生产环境强烈建议使用 WS 模式**，HTTP 模式仅适合不需要展示回复的场景（如纯触发式任务）。

### WS 模式消息流向

```
用户在 AgentNexus 发消息
        ↓
AgentNexus WS 连接 OpenClaw Gateway :18789
  握手 → chat.send（携带 sessionKey + message）
        ↓
OpenClaw Gateway 路由给 Agent
        ↓
Agent 运行、调用 LLM，流式输出
        ↓
stream=assistant 事件 → AgentNexus 累积文本
stream=lifecycle phase=end → AgentNexus 写入频道并展示
```

### HTTP 模式消息流向

```
用户在 AgentNexus 发消息
        ↓
AgentNexus POST /hooks/agent
  + Authorization: Bearer <token>
        ↓
OpenClaw Gateway :18789（立即返回 200，任务异步处理）
        ↓
AgentNexus 写入占位消息"已接收请求，正在处理…"
```

> **注意：** HTTP 模式下 AgentNexus 收不到 AI 回复内容。OpenClaw 没有 `/execute` 端点；若需真实回复，请使用 WS 模式。

### Hooks 的两种类型（不要混淆）

| 类型 | 配置节 | 作用 |
|------|--------|------|
| 内部 Hooks | `hooks.internal` | Gateway 内部事件触发，如 `/new`、`/reset`，不对外暴露 HTTP |
| 外部 Webhook | `hooks`（顶层字段） | 对外暴露 HTTP 端点，供 AgentNexus 等外部系统调用 |

---

## 二、OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`，在 `hooks` 节中，将外部 webhook 字段加在 `internal` **平级位置**（即 `hooks` 顶层）：

```json
"hooks": {
  "enabled": true,
  "token": "your-long-random-secret",
  "path": "/hooks",
  "allowedAgentIds": ["main"],
  "defaultSessionKey": "hook:ingress",
  "allowRequestSessionKey": true,
  "allowedSessionKeyPrefixes": ["nexus:", "hook:"],

  "internal": {
    "enabled": true,
    "entries": {
      "boot-md":               { "enabled": true },
      "bootstrap-extra-files": { "enabled": true },
      "command-logger":        { "enabled": true },
      "session-memory":        { "enabled": true }
    }
  }
}
```

### 关键字段说明

| 字段 | 说明 |
|------|------|
| `enabled` | 开启外部 webhook，必须为 `true` |
| `token` | 鉴权密钥，AgentNexus 调用时需在 Header 中携带 |
| `allowedAgentIds` | 限制可路由的 agent，填你的 agent 名称 |
| `defaultSessionKey` | 无 sessionKey 时的默认会话，前缀必须在 `allowedSessionKeyPrefixes` 中 |
| `allowRequestSessionKey` | 允许调用方指定 sessionKey（多用户隔离需要） |
| `allowedSessionKeyPrefixes` | 合法的 sessionKey 前缀白名单，**必须包含 `defaultSessionKey` 的前缀** |

### gateway.mode 配置

若 Gateway 启动报 `Gateway start blocked: set gateway.mode=local`，需补充：

```bash
openclaw config set gateway.mode local
openclaw config set gateway.bind lan
```

或在配置文件中加入（与 `hooks` 平级）：

```json
"gateway": {
  "mode": "local",
  "bind": "lan"
}
```

> `mode=local` 表示单机模式，`bind=lan` 表示监听所有网卡（`0.0.0.0`），两者互不影响，可同时设置。

---

## 三、配置文件校验与重启

**每次手动修改配置后，先验证 JSON 语法：**

```bash
python3 -m json.tool ~/.openclaw/openclaw.json > /dev/null && echo "✅ JSON 合法"
```

常见 JSON 错误：
- 把注释（`//`）粘贴进了配置文件（标准 JSON 不支持注释）
- 新字段放进了 `internal` 内部，而不是与它平级
- 末尾多余逗号（trailing comma）

**重启 Gateway：**

```bash
openclaw gateway restart
```

**验证是否正常监听：**

```bash
curl http://127.0.0.1:18789/healthz
```

---

## 四、AgentNexus 侧配置

### 4.1 通过管理后台 UI 配置（推荐）

1. 打开前端 → 左侧「**管理**」→ **Bot 管理** 区块
2. 点击「添加 Bot」，填写 **@ 名字**（username）后创建
3. 在 Bot 列表中点击「**编辑**」，按模式填写：

**WS 模式（推荐，能获取真实 AI 回复）：**

| 字段 | 示例值 | 说明 |
|------|--------|------|
| `openclaw_endpoint` | `ws://10.1.10.66:18789` | Gateway WebSocket 地址，端口通常为 18789 |
| `openclaw_session` | `nexus:user1` | **必填**，session key，前缀须在 `allowedSessionKeyPrefixes` 中 |
| `openclaw_token` | `your-long-random-secret` | 与 `hooks.token` 一致；WS 握手鉴权用 |

**HTTP 模式（fire-and-forget，不等真实回复）：**

| 字段 | 示例值 | 说明 |
|------|--------|------|
| `openclaw_endpoint` | `http://10.1.10.66:18789` | Gateway HTTP 地址 |

HTTP 模式还需在后端 `.env` 中配置 Token（全局共用）：

```
OPENCLAW_HOOK_TOKEN=your-long-random-secret
OPENCLAW_AGENT_ID=main
OPENCLAW_SESSION_PREFIX=nexus:
```

若未配置 `OPENCLAW_HOOK_TOKEN`，AgentNexus 将不带鉴权头调用，OpenClaw 会返回 401。

### 4.2 Bot 配置完成后

1. 在「管理」→ **Bot 与频道** 区块，将 Bot 添加到目标项目
2. 用户在项目中 `@username` 即可触发

---

## 五、调用方式详解

### 5.1 WS 模式（推荐）

AgentNexus 与 OpenClaw Gateway 建立 WebSocket 连接后，执行三步 JSON-RPC：

**第 1 步：握手**

```json
→ {"type":"req","id":"<uuid>","method":"connect","params":{
    "minProtocol":3,"maxProtocol":3,
    "client":{"id":"cli","version":"1.0","platform":"server","mode":"webchat"},
    "role":"operator","scopes":["operator.admin"],
    "auth":{"token":"your-long-random-secret"},
    "caps":[]
  }}
← {"type":"res","id":"<uuid>","result":{...}}
```

**第 2 步：发消息**

```json
→ {"type":"req","id":"<uuid>","method":"chat.send","params":{
    "sessionKey":"nexus:user1",
    "message":"用户消息内容",
    "deliver":false,
    "idempotencyKey":"<task_id>"
  }}
← {"type":"res","id":"<uuid>","result":{...}}
```

**第 3 步：等待事件**

```json
← {"type":"event","payload":{"stream":"assistant","data":{"text":"AI 回复..."}}}
← {"type":"event","payload":{"stream":"lifecycle","data":{"phase":"end"}}}
```

收到 `lifecycle phase=end`（或 `done`/`error`/`abort`）后，AgentNexus 将累积的 `assistant text` 写入频道并展示给用户。

**关键配置对应关系：**

| AgentNexus Bot 字段 | 对应 OpenClaw 配置 |
|--------------------|------------------|
| `openclaw_endpoint` | Gateway WebSocket 地址，如 `ws://10.1.10.66:18789` |
| `openclaw_session` | `sessionKey`，前缀需在 `allowedSessionKeyPrefixes` 中 |
| `openclaw_token` | `hooks.token`，握手时放入 `auth.token` |

### 5.2 HTTP 模式

AgentNexus 收到用户消息后，向 OpenClaw 发送：

```http
POST http://<openclaw_host>:18789/hooks/agent
Authorization: Bearer your-long-random-secret
Content-Type: application/json

{
  "message": "用户的消息内容",
  "agentId": "main",
  "sessionKey": "nexus:<user_id>",
  "wakeMode": "now",
  "deliver": false
}
```

| 字段 | 说明 |
|------|------|
| `message` | 用户消息，必填 |
| `agentId` | 目标 agent，需在 `allowedAgentIds` 白名单中 |
| `sessionKey` | 会话隔离键，前缀需在 `allowedSessionKeyPrefixes` 中；每个用户用不同的 key 保持独立上下文 |
| `wakeMode` | `now` = 立即处理；`next-heartbeat` = 等下次心跳 |
| `deliver` | `false` = 不让 OpenClaw 主动推送到 WhatsApp/Telegram，由 AgentNexus 自己处理响应 |

注意事项：

- Token **必须放在 Header**，不能放 query string（`?token=...` 会返回 400）
- `/hooks/agent` 是**异步**接口，返回 200 仅表示任务已接受，**AgentNexus 不等待 AI 回复**
- `sessionKey` 前缀必须匹配 `allowedSessionKeyPrefixes`，否则请求会被拒绝

---

## 六、HTTP 状态码速查

| 状态码 | 含义 | 处理方式 |
|--------|------|----------|
| 200 | 任务已接受 | 正常，等待 Agent 响应 |
| 400 | Payload 格式错误 / token 放在 query string | 检查请求体和 Header |
| 401 | Token 错误或未携带 | 检查 `OPENCLAW_HOOK_TOKEN` 配置 |
| 429 | 同一 IP 多次认证失败被限速 | 等待 `Retry-After` 后重试 |
| 502 | Gateway 未启动或端口未监听 | 执行 `openclaw gateway status` 排查 |

---

## 七、常见故障排查

### Gateway 启动失败

```bash
# 查看最新错误日志
tail -20 ~/.openclaw/logs/gateway.err.log

# 自动检测并修复配置问题
openclaw doctor --fix
```

### 端口未监听（502 / Connection refused）

```bash
# 确认进程状态
openclaw gateway status

# 确认端口是否在监听
lsof -i :18789

# 强制重载 LaunchAgent
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl load  ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

### WS 模式 Bot 无回复

AgentNexus 日志出现 `ws_openclaw: failed` 时：

1. 确认 `openclaw_session` 已填写（不能为空）
2. 确认 `openclaw_session` 的前缀在 OpenClaw `allowedSessionKeyPrefixes` 中
3. 确认 `openclaw_token` 与 OpenClaw `hooks.token` 一致
4. 检查 Gateway 是否支持 WebSocket（`openclaw gateway status`）

AgentNexus 日志出现 `ws_openclaw: timeout waiting for reply` 时：

- Agent 处理超过 30 秒（默认超时）
- 考虑缩短 Agent 响应链路，或检查 LLM 是否正常

**WS 模式显示"endpoint 未配置或格式不支持"**

- `openclaw_endpoint` 未填写，或不是 `ws://` / `wss://` 前缀（如误填了 `http://`）
- 前往管理后台 → Bot 管理 → 编辑，将 endpoint 改为 `ws://...`

### 本地直接测试 hooks（HTTP 模式）

```bash
# 测试连通性
curl http://127.0.0.1:18789/healthz

# 测试完整调用（HTTP 模式）
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H "Authorization: Bearer your-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","agentId":"main","sessionKey":"nexus:test"}'
```

---

## 八、安全建议

以下警告来自 `openclaw security audit`，建议按需处理：

**CRITICAL**
- `allowRequestSessionKey=true` 允许调用方自定义 sessionKey，务必同时配置 `allowedSessionKeyPrefixes` 进行限制

**WARN（建议修复）**
```bash
# 1. 配置认证限速，防止暴力破解
openclaw config set gateway.auth.rateLimit '{"maxAttempts":10,"windowMs":60000,"lockoutMs":300000}'

# 2. 收紧 credentials 目录权限
chmod 700 ~/.openclaw/credentials
```
