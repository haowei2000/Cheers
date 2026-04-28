# OpenClaw 接入指南

> 面向管理员与集成工程师：基于当前代码实现，说明 OpenClaw 接入 AgentNexus 的可用路径、配置项与排查方法。

---

## 一、先理解两种接入路径

当前系统同时支持两类路径：

1. **推荐路径（默认）**：把 OpenClaw Gateway 当作 OpenAI 兼容模型接入，使用 `HttpBotAdapter` 执行（稳定、配置简单）。  
2. **适配器路径（高级）**：使用 HTTP/WS OpenClaw 适配器协议接入（代码已实现，适合已有 OpenClaw 服务协议链路）。

> 说明：当前 `adapter_resolver` 默认走 `HttpBotAdapter` 与 `ChannelBotAdapter`，因此大多数场景建议使用“推荐路径”。

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

## 三、适配器路径：Channel Plugin（WebSocket Bot）

把 OpenClaw runtime 当成 channel adapter 接入：一个 OpenClaw `account` ↔ 一个 AgentNexus `WebSocket Bot`，OpenClaw agent 通过 `outbound.sendText / sendMedia` 把回复写回频道（支持流式 token 渲染、文件附件、取消）。

### 3.1 在 AgentNexus 创建 WebSocket Bot

管理面板 → Bot 管理 → 创建 Bot：

- 绑定类型选 **WebSocket Bot**
- 创建后弹出的一次性 `ocw_...` token **立刻复制**（关闭后只能 rotate）
- 把该 Bot 加进想让它工作的频道（频道成员里加 bot）

### 3.2 安装 channel plugin

推荐从 GitHub Release 装预构建 tarball（不用 clone 仓库）：

```bash
gh release download openclaw-channel-agentnexus-v0.2.0 \
  -R Grant-Huang/AgentNexus \
  --pattern "*.tgz" \
  --dir /tmp
openclaw plugins install /tmp/openclaw-channel-agentnexus-0.2.0.tgz
```

或用 curl（**URL 必须用引号包住**，避免终端换行截断）：

```bash
curl -L -o /tmp/agentnexus.tgz \
  "https://github.com/Grant-Huang/AgentNexus/releases/download/openclaw-channel-agentnexus-v0.2.0/openclaw-channel-agentnexus-0.2.0.tgz"
openclaw plugins install /tmp/agentnexus.tgz
```

如果是开发态、想改了立刻生效，从源码 link：

```bash
cd packages/openclaw-channel-agentnexus
npm install && npm run build
openclaw plugins install -l "$(pwd)"
```

验证：`openclaw plugins list | grep agentnexus` 应看到 `loaded`。

### 3.3 配置 `~/.openclaw/openclaw.json`

```jsonc
{
  "channels": {
    "agentnexus": {
      "enabled": true,
      "accounts": {
        "my-bot": {                    // 任意 ID，对应 AgentNexus 里一个 WS Bot
          "enabled": true,
          "botToken": "ocw_xxxxxxxxxxxxxxxx",                       // 第 3.1 步拿到的 token
          "controlUrl": "ws://your-host:8002/ws/openclaw/control",
          "dataUrl":    "ws://your-host:8002/ws/openclaw/data",
          "advanced": {                            // 可选
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

| 字段 | 必填 | 说明 |
|---|---|---|
| `botToken` | ✅ | AgentNexus WS Bot 的一次性 token |
| `controlUrl` / `dataUrl` | ✅ | bridge 路径固定 `/ws/openclaw/control` 与 `/data` |
| `enabled` | ❌ | 默认 `true`；可设 `false` 临时禁用 |
| `advanced.*` | ❌ | 重连/心跳/ACK 超时，默认值够用 |

**HTTPS 部署**：`ws://` → `wss://`；反代 `proxy_read_timeout` ≥ 600s。

### 3.4 重启 gateway 与验证

```bash
openclaw daemon restart
openclaw channels status --probe
# - AgentNexus my-bot: enabled

curl -H "X-OpenClaw-Token: <BRIDGE_TOKEN>" \
  http://localhost:8002/api/v1/openclaw/bridge/status
# data.bot_sessions 从 0 变 1（或之前的数 +1）
```

在频道里 `@my-bot ...`，OpenClaw 日志应看到：

```bash
openclaw channels logs | grep agentnexus | tail
# agentnexus: my-bot ready bot_id=... memberships=N
# agentnexus: my-bot inbound channel=... task=... text="@my-bot ..."
```

### 3.5 Channel Plugin 模式的常见踩坑

| 现象 / close code | 原因 | 处理 |
|---|---|---|
| `4401 token invalid` | token 复制时多了空格/换行 | 重新 rotate 拿原文 |
| `4402 superseded` | 多台机器用了同一 token | 让旧实例退出 |
| `4403 bot offline` | AgentNexus 里 bot status = `offline` | 改回 `online` |
| `ECONNREFUSED` / 连不上 | URL 端口写错（应是 `8002`，不是 `8000`） | 检查 `controlUrl/dataUrl` |
| 连得上但收不到 message | bot 没在 channel 成员里 | 频道成员里加 bot |

更深入的协议、独立模式（绕过 OpenClaw runtime 直接用 `BotSession`）、close code 全表，见 `docs/develop/OpenClaw_channel_plugin_接入指南.md`。

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
- [Channel Plugin 开发者深度文档](../develop/OpenClaw_channel_plugin_接入指南.md)
