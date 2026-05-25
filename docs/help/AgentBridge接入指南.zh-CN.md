# AgentNexus Agent Bridge 接入指南

> **语言**：中文 | [English](AgentBridge接入指南.md)

本文档说明两类外部 Agent 如何接入 AgentNexus：

1. OpenClaw 通过 `@haowei0520/openclaw-channel-agentnexus` 插件接入。
2. ACP 协议 Agent 通过 `@haowei0520/acp-connector` 接入，并以 OpenCode ACP 为例。

两种方式都使用 AgentNexus 的 **Agent Bridge Bot**。用户在频道或 DM 中 `@Bot` 后，AgentNexus 通过两条 WebSocket 把任务推给外部 provider，provider 再把流式文本、最终回复和附件回传给 AgentNexus。

---

## 一、统一概念

### 1.1 Agent Bridge Bot

Agent Bridge Bot 是 AgentNexus 中专门给外部 provider 使用的 Bot 账号。创建后会得到一次性明文 `botToken`，格式类似 `agb_...`。

关键点：

- `binding_type` 必须是 `agent_bridge`，不是旧版 `websocket`。
- 每个 Bot 有独立 `botToken`；明文只在创建或 rotate 后显示一次。
- 外部 provider 必须把 Bot 加入目标频道，用户 `@Bot用户名` 才会触发。
- OpenClaw、ACP Connector 都是 Agent Bridge provider，不需要改 AgentNexus 后端协议。

### 1.2 WebSocket 地址

Agent Bridge 使用两条 WebSocket：

| 通道 | 路径 | 用途 |
|------|------|------|
| control | `/ws/agent-bridge/control` | 连接握手、频道 membership 快照、加入/移除通知、心跳 |
| data | `/ws/agent-bridge/data` | 推送用户消息，接收 `reply` / `delta` / `done` / `error` / 文件上传 |

Docker 默认从 `.env.example` 复制时，后端宿主机端口是 `8000`；本地 `uvicorn` 开发也常用 `8000`。下面示例用变量表示：

```bash
export AGENTNEXUS_BASE_URL=http://localhost:8000
export AGENTNEXUS_WS_BASE=ws://localhost:8000
```

如果是 HTTPS 反代部署，把 `ws://` 换成 `wss://`。

### 1.3 后端开关

后端 `.env` 中保持：

```bash
AGENT_BRIDGE_ENABLED=true
AGENT_BRIDGE_TOKEN=<管理调试用共享密钥>
AGENT_BRIDGE_TIMEOUT_SECONDS=600
```

说明：

- `AGENT_BRIDGE_TOKEN` 用于 `/api/v1/agent-bridge/*` 这类管理/调试 HTTP 接口。
- OpenClaw 插件和 ACP Connector 连接两条 WS 时使用的是每个 Bot 自己的 `agb_...` token。

---

## 二、在 AgentNexus 创建 Agent Bridge Bot

推荐用前端 UI 创建：

1. 打开 AgentNexus 前端。
2. 进入左侧「管理」。
3. 在 Bot 管理中创建 Bot，绑定类型选择 **Agent Bridge Bot**。
4. `bridge_provider` 按场景填写：
   - OpenClaw：`openclaw`
   - ACP / OpenCode ACP：`acp`
5. 创建后立刻保存弹出的 `agb_...` token。
6. 把该 Bot 加入要使用的频道。

也可以通过机器可读注册接口创建：

```bash
curl -X POST "$AGENTNEXUS_BASE_URL/docs/agent-bridge/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "my-agent",
    "display_name": "My Agent",
    "bridge_provider": "openclaw",
    "account_username": "admin",
    "account_password": "<你的登录密码>",
    "agent_id": "main",
    "scope": "private"
  }'
```

响应里的 `data.bot.bot_token` 是外部 provider 要保存的 `botToken`。如果丢失，只能在 AgentNexus 里 rotate token。

---

## 三、连接 OpenClaw

### 3.1 安装 OpenClaw channel plugin

公开 npm 包名是 `@haowei0520/openclaw-channel-agentnexus`。如果看到
`@haowei2000/openclaw-channel-agentnexus`，只有在你自己的私有 npm registry 中确实发布了这个包时才使用；公开 npm registry 上应使用 `@haowei0520`。

推荐从 npm 拉取当前发布包并交给 OpenClaw 安装：

```bash
npm pack @haowei0520/openclaw-channel-agentnexus@0.2.4 --pack-destination /tmp
openclaw plugins install /tmp/haowei0520-openclaw-channel-agentnexus-0.2.4.tgz
```

如果当前 AgentNexus 后端已经挂载了 `release/openclaw-channel-agentnexus.tgz`，也可以从后端下载离线包。使用这条路径前，先确认 `release/` 下的 tarball 是最新构建产物：

```bash
curl -L -o /tmp/openclaw-channel-agentnexus.tgz \
  "$AGENTNEXUS_BASE_URL/release/openclaw-channel-agentnexus.tgz"

openclaw plugins install /tmp/openclaw-channel-agentnexus.tgz
```

也可以从 GitHub Release 安装预构建包：

```bash
gh release download openclaw-channel-agentnexus-v0.2.4 \
  -R Grant-Huang/AgentNexus \
  --pattern "*.tgz" \
  --dir /tmp

openclaw plugins install /tmp/haowei0520-openclaw-channel-agentnexus-0.2.4.tgz
```

或使用 GitHub latest 下载地址：

```bash
curl -L -o /tmp/agentnexus-openclaw.tgz \
  "https://github.com/Grant-Huang/AgentNexus/releases/latest/download/openclaw-channel-agentnexus.tgz"

openclaw plugins install /tmp/agentnexus-openclaw.tgz
```

开发态可以从仓库源码 link：

```bash
cd packages/openclaw-channel-agentnexus
npm install
npm run build
openclaw plugins install -l "$(pwd)"
```

检查插件状态：

```bash
openclaw plugins list | grep agentnexus
```

应看到 `@haowei0520/openclaw-channel-agentnexus` 且状态为 loaded。

### 3.2 配置 OpenClaw account

编辑 `~/.openclaw/openclaw.json`，在顶层 `channels` 下加入：

```jsonc
{
  "channels": {
    "agentnexus": {
      "enabled": true,
      "accounts": {
        "openclaw-main": {
          "enabled": true,
          "botToken": "agb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "controlUrl": "ws://localhost:8000/ws/agent-bridge/control",
          "dataUrl": "ws://localhost:8000/ws/agent-bridge/data",
          "advanced": {
            "reconnectBaseMs": 1000,
            "reconnectMaxMs": 30000,
            "heartbeatIntervalMs": 30000,
            "sendAckTimeoutMs": 600000
          }
        }
      }
    }
  }
}
```

也可以用脚本快速写入配置。先确认插件已安装并在 `openclaw plugins list | grep agentnexus` 中显示 `loaded`，再执行：

```bash
AGENTNEXUS_BOT_TOKEN='agb_替换成最新token' python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

token = os.environ.get("AGENTNEXUS_BOT_TOKEN", "").strip()
if not token.startswith("agb_"):
    sys.exit("AGENTNEXUS_BOT_TOKEN 必须是最新的 agb_... token")

plugin_dir = Path.home() / ".openclaw" / "extensions" / "agentnexus"
if not plugin_dir.exists():
    sys.exit(f"插件目录不存在：{plugin_dir}\n请先安装插件，再添加 channels.agentnexus")

p = Path.home() / ".openclaw" / "openclaw.json"
backup = p.with_suffix(".json.bak.add-agentnexus")
backup.write_text(p.read_text())

data = json.loads(p.read_text())

plugins = data.setdefault("plugins", {})
entries = plugins.setdefault("entries", {})
entries["agentnexus"] = {"enabled": True}

allow = plugins.setdefault("allow", [])
if "agentnexus" not in allow:
    allow.append("agentnexus")

data.setdefault("channels", {})["agentnexus"] = {
    "enabled": True,
    "accounts": {
        "remote-bot": {
            "enabled": True,
            "botToken": token,
            "controlUrl": "wss://agentnexus.example.com/ws/agent-bridge/control",
            "dataUrl": "wss://agentnexus.example.com/ws/agent-bridge/data",
            "advanced": {
                "reconnectBaseMs": 1000,
                "reconnectMaxMs": 30000,
                "heartbeatIntervalMs": 30000,
                "sendAckTimeoutMs": 600000,
            },
        },
    },
}

p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
print(f"已写入 {p}")
print(f"备份文件 {backup}")
PY

openclaw daemon restart
openclaw channels status --probe
```

如果 OpenClaw 报 `channels.agentnexus: unknown channel id: agentnexus`，通常是还没安装或启用插件就先写入了 channel 配置。先删除 `channels.agentnexus`，安装并确认插件 `loaded` 后再执行上面的脚本。

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `botToken` | 是 | AgentNexus 创建 Bot 时返回的 `agb_...` |
| `controlUrl` | 是 | AgentNexus control WS |
| `dataUrl` | 是 | AgentNexus data WS |
| `enabled` | 否 | 临时启停该 account，默认 `true` |
| `advanced.sendAckTimeoutMs` | 否 | 大文件或长任务建议设置到 10 分钟左右 |

一个 OpenClaw 进程可以挂多个 account。每个 account 对应一个 AgentNexus Agent Bridge Bot。

### 3.3 重启 OpenClaw 并验证

```bash
openclaw daemon restart
openclaw channels status --probe
openclaw channels logs | grep agentnexus | tail -50
```

也可以从 AgentNexus 后端看在线状态：

```bash
curl -H "X-Agent-Bridge-Token: $AGENT_BRIDGE_TOKEN" \
  "$AGENTNEXUS_BASE_URL/api/v1/agent-bridge/status"
```

期望 `bot_sessions` 数量增加，OpenClaw 日志中出现类似：

```text
agentnexus: openclaw-main ready bot_id=...
agentnexus: openclaw-main inbound channel=... task=...
```

### 3.4 发送测试消息

在 AgentNexus 目标频道中发送：

```text
@openclaw-main 你好，确认一下你已经连上 AgentNexus
```

如果 Bot 在频道中、token 正确、OpenClaw 插件在线，AgentNexus 会显示 Bot 的流式回复或最终回复。

---

## 四、连接 ACP 协议 Agent：以 OpenCode ACP 为例

ACP Connector 适合把本机 stdio ACP agent 接到 AgentNexus。它本身负责：

- 连接 AgentNexus 的 control/data WS；
- 启动本机 ACP agent，例如 `opencode acp`；
- 把 AgentNexus 用户消息转成 ACP session prompt；
- 把 ACP 的流式输出、最终回复和文件资源回传给 AgentNexus。

### 4.1 安装 ACP Connector

从 npm 安装：

```bash
npm install -g @haowei0520/acp-connector
```

或从当前仓库源码安装：

```bash
npm install -g ./packages/agentnexus-bridge-client
npm install -g ./packages/agentnexus-acp-connector
```

确认命令可用：

```bash
agentnexus-acp-connector --help
```

### 4.2 Docker Compose 预置 OpenCode Bot

`docker-compose.yml.template` 内置了可选的 `opencode-bot` profile：backend seed 会创建一个 Agent Bridge Bot，`opencode-bot` 容器会用同一个 Bot token 连接 AgentNexus，并通过 OpenCode ACP 调用 DeepSeek/OpenAI 兼容 API。OpenCode ACP 声明支持图片输入和嵌入文件上下文；实际图片理解能力仍取决于配置的模型/供应商。

在 `.env` 中配置：

```bash
OPENCODE_BOT_ENABLED=true
OPENCODE_BOT_TOKEN=agb_<随机密钥>
OPENCODE_OPENAI_API_KEY=<你的 OpenAI 兼容 API Key>
OPENCODE_OPENAI_BASE_URL=https://api.deepseek.com
OPENCODE_PROVIDER=deepseek
OPENCODE_MODEL=<模型名>
```

生成 `OPENCODE_BOT_TOKEN` 示例：

```bash
python - <<'PY'
import secrets
print("agb_" + secrets.token_urlsafe(32))
PY
```

启动：

```bash
docker compose --profile opencode-bot up -d --wait
```

`OPENCODE_BOT_TOKEN` 必须同时给 backend seed 和 `opencode-bot` 容器使用。`OPENCODE_PERMISSION_MODE` 默认是 `ask`，会在 AgentNexus 中生成真实审批卡片；如需全部拒绝可改为 `reject`，如需直接允许 OpenCode 在容器工作区内写文件，可改成 `allow` 并确认 `./data/opencode-workspace` 是可信目录。

### 4.3 注册 OpenCode ACP Bot

通过 AgentNexus 注册接口创建一个 ACP provider Bot：

```bash
curl -X POST "$AGENTNEXUS_BASE_URL/docs/agent-bridge/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "opencode-acp",
    "display_name": "OpenCode ACP",
    "bridge_provider": "acp",
    "account_username": "admin",
    "account_password": "<你的登录密码>",
    "agent_id": "opencode-acp",
    "scope": "private"
  }'
```

保存响应中的：

- `data.bot.bot_token`
- `data.bridge.control_ws`
- `data.bridge.data_ws`
- 或直接保存 `data.acp_connector_config` 后再修改本地 agent 配置。

### 4.4 编写 `agentnexus-acp.json`

示例：

```json
{
  "accounts": {
    "opencode-acp": {
      "botToken": "agb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "controlUrl": "ws://localhost:8000/ws/agent-bridge/control",
      "dataUrl": "ws://localhost:8000/ws/agent-bridge/data",
      "agent": {
        "transport": "stdio",
        "command": "opencode",
        "args": ["acp", "--cwd", "/Users/haowei/Projects/AgentNexus"],
        "cwd": "/Users/haowei/Projects/AgentNexus",
        "env": {
          "OPENCODE_CONFIG_CONTENT": "$OPENCODE_CONFIG_CONTENT"
        },
        "requestTimeoutMs": 1200000,
        "permissionMode": "ask"
      }
    }
  }
}
```

注意：

- `requestTimeoutMs` 和 `permissionMode` 放在 `agent` 对象里。
- `permissionMode` 支持：
  - `ask`：在当前频道发送权限审批卡片，只有 Bot 所有者可以批准或拒绝。
  - `reject`：遇到写文件、执行命令等权限请求时自动拒绝。
  - `allow`：自动选择允许；只建议用于可信本地工作区。
  - `cancel`：收到权限请求时取消。
- 如果希望 OpenCode ACP 能生成并返回文件，需要把 `cwd` 设成允许它读写的项目目录；生产/协作场景建议使用 `"permissionMode": "ask"`，可信本地工作区才使用 `"allow"`。

### 4.5 启动 ACP Connector

前台调试：

```bash
agentnexus-acp-connector run --config ./agentnexus-acp.json
```

后台守护进程：

```bash
agentnexus-acp-connector start --config ./agentnexus-acp.json --name opencode-acp
agentnexus-acp-connector status --name opencode-acp
agentnexus-acp-connector logs --name opencode-acp --lines 200
```

停止或重启：

```bash
agentnexus-acp-connector restart --name opencode-acp
agentnexus-acp-connector stop --name opencode-acp
```

### 4.6 在 AgentNexus 中测试 OpenCode ACP

先把 `opencode-acp` Bot 加入目标频道，然后发送：

```text
@opencode-acp 请读取当前消息并回复一句你已经通过 ACP 接入 AgentNexus
```

测试图片输入：

1. 在 AgentNexus 消息框上传一张图片。
2. 发送：

```text
@opencode-acp 请分析这张图片的内容
```

当前 ACP Connector 会在 agent 声明 `image` capability 时，把图片通过 `/api/v1/agent-bridge/files/{file_id}/binary` 读取后作为 ACP `image` content block 传给 agent。

测试文档/resource 输入：

1. 上传 `.txt`、`.md`、`.pdf` 或 `.docx`。
2. 发送：

```text
@opencode-acp 请总结这个附件
```

当前 ACP Connector 会在 agent 声明 `embeddedContext` capability 时，通过 `/api/v1/agent-bridge/files/{file_id}/content` 读取文件正文，并作为 ACP `resource` content block 传给 agent。

### 4.7 让 OpenCode ACP 返回文件到 AgentNexus

ACP Connector 支持两条文件回传路径：

1. ACP agent 在 `agent_message_chunk` 中返回 `resource` 内容，connector 会上传到 AgentNexus 并把 `file_id` 附到最终回复。
2. ACP agent 在最终文本里提到 `file://...` 或 Markdown 文件链接，且文件位于 `agent.cwd` 内，connector 会扫描并上传新增或修改过的文件。

可以在 AgentNexus 中这样测试：

```text
@opencode-acp 在当前工作区生成一个 outputs/acp-test.md，内容写一段 AgentNexus ACP 文件回传测试，然后把文件链接返回给我
```

配置要求：

- `agent.cwd` 必须是该文件所在工作区或其父目录。
- `permissionMode` 需要允许 agent 写文件，例如 `"allow"`。
- 返回文件必须在 `agent.cwd` 内，避免误传工作区外的本地文件。

---

## 五、常见问题

### 5.1 Bot 没反应

检查顺序：

1. Bot 是否已经加入当前频道。
2. 用户消息里的 `@username` 是否和 Bot 用户名完全一致。
3. `botToken` 是否是明文 `agb_...`，不是数据库中的 hash 或 token prefix。
4. `controlUrl` / `dataUrl` 是否能从 provider 所在机器访问。
5. 后端 `AGENT_BRIDGE_ENABLED` 是否为 `true`。

### 5.2 OpenClaw 显示 loaded 但没有 inbound

优先看：

```bash
openclaw channels status --probe
openclaw channels logs | grep agentnexus | tail -100
```

常见原因是 Bot 未加入频道，或 OpenClaw 配置中的 account 没有写到 `channels.agentnexus.accounts` 下。

### 5.3 ACP Connector 启动失败

常见原因：

- JSON 少逗号或字段放错层级。
- `agent.command` 找不到，例如本机没有 `opencode`。
- `OPENCODE_CONFIG_CONTENT` 或其中引用的 API Key 没有在环境中设置。
- `agent.cwd` 不存在。

### 5.4 生成 PPT、文档或长任务被取消

ACP 的默认请求超时较短。长任务建议在 `agent` 里设置：

```json
{
  "requestTimeoutMs": 1200000,
  "permissionMode": "allow"
}
```

同时保持后端：

```bash
AGENT_BRIDGE_TIMEOUT_SECONDS=600
```

后端超过等待阈值后会把前台占位消息转为后台任务，不会主动终止 provider；真正取消通常来自 ACP agent 请求超时或权限请求被拒绝。

### 5.5 如何轮换 token

在 AgentNexus 管理界面对 Agent Bridge Bot 执行 rotate token，拿到新的 `agb_...` 后：

- OpenClaw：更新 `~/.openclaw/openclaw.json`，再 `openclaw daemon restart`。
- ACP：更新 `agentnexus-acp.json`，再 `agentnexus-acp-connector restart --name <name>`。

旧 token 会立即失效。

---

## 六、参考路径

当前仓库中的实现入口：

- Agent Bridge HTTP/WS 路由：`backend/app/api/v1/agent_bridge/routes.py`
- Agent Bridge 机器可读注册页：`backend/app/agent_bridge_docs_routes.py`
- Agent Bridge Bot 适配器：`backend/app/features/bot_runtime/adapters/agent_bridge_bot.py`
- OpenClaw 插件包：`packages/openclaw-channel-agentnexus/`
- ACP Connector：`packages/agentnexus-acp-connector/`
