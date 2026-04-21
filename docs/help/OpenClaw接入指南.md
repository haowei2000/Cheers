# OpenClaw 接入指南

> 面向管理员与集成工程师：基于当前代码实现，说明 OpenClaw 接入 AgentNexus 的可用路径、配置项与排查方法。

---

## 一、先理解两种接入路径

当前系统同时支持两类路径：

1. **推荐路径（默认）**：把 OpenClaw Gateway 当作 OpenAI 兼容模型接入，使用 `LLMBotAdapter` 执行（稳定、配置简单）。  
2. **适配器路径（高级）**：使用 HTTP/WS OpenClaw 适配器协议接入（代码已实现，适合已有 OpenClaw 服务协议链路）。

> 说明：当前 `adapter_resolver` 默认走 `LLMBotAdapter` 与 `UnifiedBuiltinBotAdapter`，因此大多数场景建议使用“推荐路径”。

---

## 二、推荐路径：OpenClaw 作为 OpenAI 兼容模型

### 2.1 准备 OpenClaw Gateway 参数

在 OpenClaw 侧准备以下信息：

- `Base URL`：例如 `http://10.1.10.66:18789/v1`
- `API Key`：Gateway token（若未启用鉴权可使用占位值）
- `Model Name`：对应 Agent ID，例如 `main`

参考官方文档：[OpenAI HTTP API](https://docs.openclaw.ai/zh-CN/gateway/openai-http-api)

### 2.2 在 AgentNexus 创建模型

在前端「管理」中创建模型（Provider 选 `openai`）：

| 字段 | 示例 |
|------|------|
| 模型名称 | `openclaw-main` |
| Provider | `openai` |
| Base URL | `http://10.1.10.66:18789/v1` |
| Model Name | `main` |
| API Key | `YOUR_GATEWAY_TOKEN` |

### 2.3 创建提示词模板与 Bot

1. 创建模板（`system_prompt` + `user_template`，通常 `{{message}}` 即可）  
2. 创建 Bot，并绑定上一步模型和模板  
3. 将 Bot 加入目标频道（聊天内 `@` 邀请或成员管理）

完成后可在频道内 `@bot_username 你的问题` 触发回复。

---

## 三、适配器路径：HTTP / WS OpenClaw（高级）

### 3.1 HTTP Hook 方式

- 适配器实现：`backend/app/adapters/http_openclaw.py`
- 约定路径：`/hooks/agent`
- 认证头：`Authorization: Bearer <openclaw_hook_token>`
- 关键配置来源：`backend/app/config.py`
  - `openclaw_hook_token`
  - `openclaw_agent_id`
  - `openclaw_session_prefix`

### 3.2 WebSocket 方式

- 适配器实现：`backend/app/adapters/ws_openclaw.py`
- 协议：JSON-RPC（`connect`、`chat.send`）
- token 放置：`connect.params.auth.token`

> 若你是外部 OpenClaw 服务提供方，建议先用推荐路径完成接入，再按需切换适配器路径。

---

## 四、验证与排查

| 现象 | 常见原因 | 处理建议 |
|------|----------|----------|
| Bot 无回复 | Bot 未加入频道 | 先确认频道成员里有该 bot |
| 回复 401 | API Key 错误 | 校验 Gateway token 与模型配置一致 |
| 回复 404 | Model Name 不匹配 | 确认与 OpenClaw Agent ID 完全一致 |
| 长时间 thinking | 网络不通或后端到 OpenClaw 超时 | 检查后端到 Gateway 的连通性与防火墙 |
| 启动时报 Bot 字段缺失 | 数据库迁移未完成 | 执行迁移并核对表结构 |

---

## 五、相关文档

- [外部Bot接入指南](外部Bot接入指南.md)
- [系统管理说明书](系统管理说明书.md)
- [技术排查Q&A](技术排查Q&A.md)
- [安装部署说明](安装部署说明.md)
