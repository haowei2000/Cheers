# OpenClaw 接入 AgentNexus 指南

> 面向 **OpenClaw 开发者**：如何让 OpenClaw 实例发现 AgentNexus 并自动提交注册申请，经管理员审核后作为一个 Bot 被 @ 使用；同时说明 AgentNexus 如何通过 OpenClaw Gateway 的 `/hooks/agent` 接口转发用户消息。

---

## 一、接入流程概览

```text
OpenClaw → ① GET 发现接口 → ② POST 注册申请 → ③ 管理员审核通过 → ④ 将 Bot 加入项目 → ⑤ 用户在频道内 @Bot，AgentNexus 通过 /hooks/agent 将消息转发给 OpenClaw
```

---

## 二、在 AgentNexus 侧：发现与注册 Bot

### 2.1 前置条件

- 已知 AgentNexus 后端地址，例如：`http://10.1.9.130:8000`（替换为实际 IP 和端口）
- 已知 OpenClaw Gateway HTTP 地址，例如：`http://10.1.10.66:18789`

### 2.2 第一步：获取发现与注册指南

**请求：**

```bash
curl -X GET "http://10.1.9.130:8000/api/public/agentnexus-discovery"
```

**注意：路径必须包含 `/api` 前缀。** 以下路径会返回 404，请勿使用：

- ❌ `http://10.1.9.130:8000/public/agentnexus-discovery`（缺少 `/api`）
- ❌ `http://10.1.9.130:8001/...`（端口错误，请确认后端实际端口）

**响应示例（简化）：**

```json
{
  "name": "AgentNexus",
  "description": "智枢人机协作平台；Bot 需管理员审核通过后可被加入项目并 @。",
  "base_url": "http://10.1.9.130:8000",
  "register_request": {
    "url": "http://10.1.9.130:8000/api/bots/register-request",
    "method": "POST",
    "content_type": "application/json",
    "body_schema": {
      "username": "string，必填，@ 时使用的名字，唯一",
      "display_name": "string，选填，显示名称",
      "openclaw_endpoint": "string，必填，本 OpenClaw Gateway 的 http(s) 根地址（不含 /hooks）；系统会向 {openclaw_endpoint}/hooks/agent 发送 POST 请求"
    }
  },
  "execute_contract": "审核通过后，用户 @ 该 Bot 时，AgentNexus 会按 OpenClaw /hooks/agent 协议转发消息。"
}
```

OpenClaw 可解析 `register_request.url` 和 `body_schema`，根据其中的 URL 和字段说明构造下一步的注册请求。

---

### 2.3 第二步：提交注册申请

使用第一步返回的 `register_request.url` 发起 POST 请求。

**示例：**

```bash
curl -X POST "http://10.1.9.130:8000/api/bots/register-request" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "openclaw66",
    "openclaw_endpoint": "http://10.1.10.66:18789",
    "display_name": "Epicwise-MOM"
  }'
```

**参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `username` | 是 | @ 时使用的名字，系统内唯一；建议不含 `@`，用户输入时会自动补全 |
| `openclaw_endpoint` | 是 | 本 OpenClaw Gateway 的 http(s) 根地址，例如 `http://10.1.10.66:18789`；AgentNexus 将向 `{openclaw_endpoint}/hooks/agent` 发送 POST 请求 |
| `display_name` | 否 | 显示名称 |

**成功响应示例：**

```json
{
  "status": "success",
  "data": {
    "request_id": "f76d5bbd-af6b-40dd-998d-8cae0f6812a7",
    "message": "注册申请已提交，等待管理员在「管理」界面审核通过后可被加入项目并 @。"
  }
}
```

---

### 2.4 第三步：管理员审核并加入频道

1. 管理员打开 AgentNexus 前端，进入 **「管理」→「Bot 与频道」** 标签
2. 在 **「待审核 Bot 申请」** 区块查看列表，点击 **「刷新」** 可重新拉取
3. 对每条申请点击 **「通过」** 或 **「拒绝」**
4. 通过后，管理员可将该 Bot 加入目标项目：
   - 方式一（推荐）：在频道内输入 `@`，从下拉列表选择该 Bot；若 Bot 未加入频道，系统会提示「不在本频道，是否邀请加入？」→ 点击「加入并 @ta」
   - 方式二：在「管理」→「添加成员」中，选择项目，`member_id` 填该 Bot 的 `bot_id`，类型选 `bot`，点击「添加」

**若管理端看不到申请，请确认：**

- 前端连接的 API 与提交注册的后端是同一实例（同一 IP、同一端口）
- 若前端通过 Vite 代理，代理目标端口需与后端一致（默认 8000）

---

## 三、在 OpenClaw 侧：配置 /hooks/agent Hook

OpenClaw Gateway 提供 HTTP Hook 接口 `/hooks/agent`，用于外部系统（如 AgentNexus）将用户消息转发给某个 Agent。

### 3.1 Gateway 配置示例

```jsonc
"gateway": {
  "port": 18789,
  "mode": "local",
  "bind": "lan",
  "auth": {
    "mode": "token",
    "token": "YOUR_GATEWAY_TOKEN"
  },
  "hooks": {
    "agent": {
      "enabled": true,
      "token": "YOUR_HOOK_TOKEN",
      "path": "/hooks",
      "allowedAgentIds": ["main"],
      "allowRequestSessionKey": true,
      "allowedSessionKeyPrefixes": ["nexus:"]
    }
  }
}
```

关键点：

- `port`：对外 HTTP/WebSocket 端口（如 18789），需要与 `openclaw_endpoint` 保持一致
- `hooks.agent.enabled: true`：开启 Agent Hook
- `hooks.agent.token`：Hook 专用 token，AgentNexus 调用时会放在 `Authorization: Bearer ...` 头里
- `hooks.agent.path: "/hooks"`：前缀；实际调用路径为 `{openclaw_endpoint}/hooks/agent`
- `allowedAgentIds`：允许被调用的 Agent ID，例如 `"main"`
- `allowedSessionKeyPrefixes: ["nexus:"]`：允许的 sessionKey 前缀；AgentNexus 会使用 `nexus:<user_id>` 作为 sessionKey，以区分不同用户会话

### 3.2 /hooks/agent 请求格式

AgentNexus 会按 OpenClaw 官方文档调用：

- URL：`POST {openclaw_endpoint}/hooks/agent`，如 `POST http://10.1.10.66:18789/hooks/agent`
- Header：

```http
Authorization: Bearer YOUR_HOOK_TOKEN
Content-Type: application/json
```

- Body：

```json
{
  "message": "用户在 AgentNexus 中输入的内容",
  "agentId": "main",
  "sessionKey": "nexus:<user_id>",
  "wakeMode": "now",
  "deliver": false
}
```

说明：

- `message`：用户发送的自然语言消息
- `agentId`：OpenClaw 内配置的 Agent ID（默认 `"main"`）
- `sessionKey`：`nexus:` 前缀加上 AgentNexus 用户 ID，用于隔离不同用户会话上下文
- `wakeMode: "now"`：立即唤醒 Agent
- `deliver: false`：不让 OpenClaw 把回复投递到 WhatsApp/Telegram，而是由外部工具（将来）来处理回复

### 3.3 /hooks/agent 响应

- 成功：`200 OK`，表示异步任务已接受（**不代表 Agent 已产生最终回复**）
- 认证失败：`401`
- 限流：`429`
- 请求错误：`400`
- 工具/Agent 异常：`500`

当前版本的 AgentNexus 会在频道内生成一条 Bot 消息：

> OpenClaw 已接收请求，正在处理…

用于提示调用已成功投递。实际的 Agent 回复需要在 OpenClaw 侧通过 WebSocket 或其他机制获得后，再根据业务需求推回 AgentNexus（后续版本可扩展为回调或轮询机制）。

---

## 四、AgentNexus 后端配置

在 `backend/.env` 中增加以下环境变量（或在部署环境中设置）：

```env
OPENCLAW_HOOK_TOKEN=YOUR_HOOK_TOKEN      # 对应 gateway.hooks.agent.token
OPENCLAW_AGENT_ID=main                   # 对应 allowedAgentIds 中的值
OPENCLAW_SESSION_PREFIX=nexus:           # 对应 allowedSessionKeyPrefixes 中的前缀
```

后端配置类（`app.config.Settings`）会读取这些值，并在 HTTP 适配器中使用。

在 Bot 配置中（前端「管理 → Bot 与频道 → 已注册 Bot 列表」中的 endpoint 字段），填写：

```text
http://10.1.10.66:18789
```

**注意：**

- 只填 Gateway 根地址，不要在这里写 `/hooks` 或 `/hooks/agent`，后端会自动拼接
- 若端口或 IP 变更，需要同步更新 `openclaw_endpoint`

---

## 五、常见问题与排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `{"detail":"Not Found"}`（发现接口） | 路径缺少 `/api` 前缀 | 使用 `/api/public/agentnexus-discovery`，不要用 `/public/agentnexus-discovery` |
| `Connection refused` / 超时 | 端口错误或后端未启动 | 确认 AgentNexus 后端端口（默认 8000），并使用 `--host 0.0.0.0` 以便外网访问 |
| 管理端看不到申请 | 前端连到不同后端 | 确保前端代理指向接收注册的同一后端（IP + 端口） |
| @Bot 后一直无反应 | Bot 未加入频道、或 `openclaw_endpoint` 填写错误 | 确认 Bot 已加入当前项目（频道）、`openclaw_endpoint` 指向正确的 Gateway 根地址 |
| 日志显示 `http_openclaw: POST .../hooks/agent` 但返回 4xx/5xx | Hook token 错误、路径错误或 OpenClaw 内部异常 | 检查 `OPENCLAW_HOOK_TOKEN` 是否与 `gateway.hooks.agent.token` 一致；确认 Gateway 配置中的 `path` 和端口；查看 OpenClaw 自身日志 |

---

## 六、相关文档

- [系统管理说明书](系统管理说明书.md) §四 OpenClaw 接入、§五 发现与自动注册
- [技术排查Q&A](技术排查Q&A.md) §三 @ Bot 无回复
