# OpenClaw 接入 AgentNexus 指南

## 一、架构说明

### 消息流向

```
用户在 AgentNexus 发消息
        ↓
AgentNexus POST /hooks/agent
  + Authorization: Bearer <token>
        ↓
OpenClaw Gateway :18789
        ↓
Agent 运行、调用 LLM
        ↓
响应返回给 AgentNexus
```

> **注意：** OpenClaw 是**接收方**，没有 `/execute` 端点。AgentNexus 主动调用 OpenClaw，而不是反过来。

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

在 AgentNexus 注册 Bot 时，需填写以下信息：

| 字段 | 示例值 | 说明 |
|------|--------|------|
| `username` | `openclaw66` | @ 时使用的名称，全局唯一 |
| `openclaw_endpoint` | `http://10.1.10.66:18789` | OpenClaw Gateway 地址，**端口必须是 18789**，不要用 nginx 端口 |
| `hook_token` | `your-long-random-secret` | 与 `hooks.token` 一致 |

同时在 AgentNexus 的环境变量或 Bot 配置中设置：

```
OPENCLAW_HOOK_TOKEN=your-long-random-secret
```

若未配置，AgentNexus 会以无鉴权头方式调用，OpenClaw 将返回 401。

---

## 五、调用方式

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

### 字段说明

| 字段 | 说明 |
|------|------|
| `message` | 用户消息，必填 |
| `agentId` | 目标 agent，需在 `allowedAgentIds` 白名单中 |
| `sessionKey` | 会话隔离键，前缀需在 `allowedSessionKeyPrefixes` 中；每个用户用不同的 key 保持独立上下文 |
| `wakeMode` | `now` = 立即处理；`next-heartbeat` = 等下次心跳 |
| `deliver` | `false` = 不让 OpenClaw 主动推送到 WhatsApp/Telegram，由 AgentNexus 自己处理响应 |

### 注意事项

- Token **必须放在 Header**，不能放 query string（`?token=...` 会返回 400）
- `/hooks/agent` 是**异步**接口，返回 200 仅表示任务已接受，不代表 Agent 已回复
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

### 本地直接测试 hooks

```bash
# 测试连通性
curl http://127.0.0.1:18789/healthz

# 测试完整调用
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
