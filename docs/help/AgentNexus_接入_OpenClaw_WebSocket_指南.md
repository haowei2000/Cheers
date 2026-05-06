# AgentNexus 以 WebSocket 方式接入 OpenClaw 完整指南

把 OpenClaw 里跑的 agent 接到 AgentNexus 频道里，作为一个 **WebSocket Bot** 出现。被 `@mention` 时，AgentNexus 通过 WS 把消息推给 OpenClaw plugin，plugin 回推 reply，全流程实时。

---

## 1. 架构总览

```
┌──────────────────────────┐       ┌──────────────────────────────┐
│ AgentNexus 后端          │       │ OpenClaw 进程                │
│                          │       │                              │
│ /ws/openclaw/control ◄───┼──ws───┤ openclaw-channel-agentnexus  │
│   ↳ membership / hello   │       │   (channel plugin)           │
│                          │       │                              │
│ /ws/openclaw/data    ◄───┼──ws───┤   ↳ 转发 message → agent     │
│   ↳ message / reply      │       │   ↳ agent reply → reply 帧   │
│   ↳ delta  / send_ack    │       │                              │
│                          │       │                              │
│ Per-bot token 鉴权        │       │ Per-account token 配置        │
└──────────────────────────┘       └──────────────────────────────┘
```

- **角色**：一个 AgentNexus `WebSocket Bot` ↔ 一个 OpenClaw `account`。一个 OpenClaw 进程可以挂多个 account（多 Bot）。
- **两条 WS**：`control` 流通报频道成员变更和心跳；`data` 流跑实际消息和回复。
- **鉴权**：AgentNexus 为每个 WS Bot 生成一次性 `ocw_xxx...` token；plugin 用这个 token 连两条 WS。

---

## 2. 前置条件

| 项 | 要求 |
|---|---|
| AgentNexus 版本 | 含 `openclaw_bridge` 路由（`/ws/openclaw/control`、`/ws/openclaw/data`） |
| OpenClaw CLI | `2026.4.15` 或更新 |
| Plugin 包 | `openclaw-channel-agentnexus` ≥ `0.2.0` |
| 网络 | OpenClaw 主机能直连 AgentNexus 后端的 8002（或反代后的 SSL 端口） |
| 后端 `.env` | `OPENCLAW_BRIDGE_ENABLED=1`、`OPENCLAW_BRIDGE_TOKEN=<任意非空字符串>` |

> `OPENCLAW_BRIDGE_TOKEN` 是 bridge 路由的总开关，仅 `/api/v1/openclaw/bridge/*` 的 HTTP 端点使用；plugin 走的两条 WS 用的是 **per-bot** token，不需要 bridge token。

---

## 3. AgentNexus 端：创建 WebSocket Bot

### 3.0 机器可读入口（推荐给 OpenClaw 自动接入）

OpenClaw 可以先读取：

```bash
curl http://localhost:8000/docs/openclaw/discovery
```

该接口会返回登录、注册、帮助问答、WebSocket bridge 等入口。OpenClaw 可让用户输入 AgentNexus 账号密码，然后直接注册：

```bash
curl -X POST http://localhost:8000/docs/openclaw/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "mybot",
    "account_username": "user@example.com",
    "account_password": "your-password",
    "display_name": "OpenClaw 助手",
    "agent_id": "main",
    "scope": "private"
  }'
```

如果本机已有 AgentNexus access token，也可以不传账号密码，改用 Header `Authorization: Bearer <AgentNexus access_token>`。

响应会一次性返回 `bot_token`、`controlUrl`、`dataUrl` 与 OpenClaw 配置片段。也可以调用 `/docs/openclaw/help?q=怎么接入OpenClaw` 获取问答式帮助。

### 3.1 创建 Bot

打开 **AdminPage → Bot 管理 → 创建 Bot**，关键字段：

| 字段 | 值 |
|---|---|
| Bot 名称 | 自取，如 `code-reviewer` |
| 绑定类型 | **WebSocket Bot** |
| OpenClaw agent id | （可选）用于 `binding_config.agent_id`，plugin 可据此路由到具体 agent |
| 状态 | `online`（必须，control 握手会拒绝非 online） |

提交后，UI 会**只此一次**弹出 `ocw_xxxx...` 形式的 token —— 立刻复制存好。

> 关闭后只能从后台 **rotate** 重新生成（旧 token 立刻失效）。

### 3.2 把 Bot 加进频道

在频道的 **成员管理** 里加入这个 Bot；只有作为频道成员时，频道里的 `@mention` 才会派发到 plugin。

---

## 4. OpenClaw 端：安装 plugin

### 方式 A：从 Release 装 tarball（推荐）

```bash
curl -L -o /tmp/openclaw-channel-agentnexus.tgz \
  "http://localhost:8000/docs/openclaw/release/openclaw-channel-agentnexus.tgz"
openclaw plugins install /tmp/openclaw-channel-agentnexus.tgz
```

机器可读下载地址也会出现在 `GET /docs/openclaw/discovery` 的 `plugin.download_url` 字段中。

后端从 AgentNexus 项目根目录的 `release/` 文件夹读取插件包，默认文件名为 `openclaw-channel-agentnexus.tgz`。部署时请把打包好的插件放到 `AgentNexus/release/openclaw-channel-agentnexus.tgz`；如需调整目录或文件名，可设置 `OPENCLAW_PLUGIN_RELEASE_DIR` / `OPENCLAW_PLUGIN_FILE`。

### 方式 B：源码 link（开发态）

```bash
cd packages/openclaw-channel-agentnexus
npm install
npm run build
openclaw plugins install -l "$(pwd)"
```

### 验证

```bash
openclaw plugins list | grep agentnexus
# openclaw-channel-agentnexus  agentnexus  openclaw  loaded  …/dist/index.js  0.2.0
```

`failed to load`？检查 `dist/` 是否齐 + `openclaw.plugin.json` 是否在包根。

---

## 5. OpenClaw 端：写配置

编辑 `~/.openclaw/openclaw.json`，顶层 `channels` 下加 `agentnexus`：

```jsonc
{
  "channels": {
    "agentnexus": {
      "enabled": true,
      "accounts": {
        "my-bot": {
          "enabled": true,
          "botToken": "ocw_xxxxxxxxxxxxxxxx",
          "controlUrl": "ws://your-host:8002/ws/openclaw/control",
          "dataUrl":    "ws://your-host:8002/ws/openclaw/data",
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

| 字段 | 必填 | 说明 |
|---|:-:|---|
| `botToken` | ✅ | AgentNexus 创建 WS Bot 时弹出的 `ocw_...`，**仅一次可见** |
| `controlUrl` | ✅ | 路径固定 `/ws/openclaw/control` |
| `dataUrl` | ✅ | 路径固定 `/ws/openclaw/data` |
| `enabled` | ❌ | 默认 `true`；置 `false` 可临时禁用 |
| `advanced.reconnectBaseMs` | ❌ | 重连退避起点（默认 1s） |
| `advanced.reconnectMaxMs` | ❌ | 重连退避上限（默认 30s） |
| `advanced.heartbeatIntervalMs` | ❌ | `ping` 间隔（默认 30s） |
| `advanced.sendAckTimeoutMs` | ❌ | reply / send_ack 超时（默认 10s） |

**HTTPS / WSS**：把 `ws://` 改成 `wss://`，端口改成反代的 SSL 端口。

> Nginx：`proxy_read_timeout ≥ 600s`，否则长连接会被踢。

> 多 Bot：在 `accounts` 下并列加 `another-bot: { ... }` 即可，互不干扰。

---

## 6. 启动与验证

```bash
openclaw daemon restart
openclaw channels status --probe
#   AgentNexus my-bot: enabled
```

后端日志（默认 `agentnexus-backend-1`）应能看到：

```
control_ws: connected bot_id=<uuid> session=<sid> memberships=<N>
data_ws:    connected bot_id=<uuid>
```

把 Bot 加到的频道里发一条 `@my-bot 你好`：

- 后端会派发 `message` 帧到 plugin 的 `data` 流；
- plugin 调用 OpenClaw agent；
- agent 回复后，plugin 用 `reply` 帧把内容回推；
- AgentNexus finalize 占位消息并通过 `/ws/channels/{id}` 推给频道里所有在线成员。

---

## 7. 协议速查（control / data 帧）

### 7.1 control 流

| 方向 | 帧 | 说明 |
|---|---|---|
| 服务端 → plugin | `hello` | 首帧，携带 `bot_id`、`session_id`、完整 `memberships` 快照 |
| 服务端 → plugin | `member_added` / `member_removed` | 频道成员变更 |
| plugin → 服务端 | `ready` | plugin 已就绪（带 `plugin_version`） |
| plugin → 服务端 | `ping` / 服务端 → plugin `pong` | 心跳 |
| 服务端 → plugin | `error` | 协议错误（不会断线） |

> 同一个 `bot_id` 的新 control 连接会把旧连接以 close code `4402`（superseded）踢下线。

### 7.2 data 流

| 方向 | 帧 | 说明 |
|---|---|---|
| 服务端 → plugin | `message` | 用户在频道里 `@bot` 触发的消息（含 `channel_id`、`text`、`file_ids` 等） |
| plugin → 服务端 | `delta` | 流式 token，写入流式缓冲并广播 `message_stream`，不落库 |
| plugin → 服务端 | `reply` | 最终回复，finalize 占位消息或新建消息 |
| 服务端 → plugin | `send_ack` | 对 `reply` / `send` 的确认（`ok: true/false` + `message_id` 或 `error`） |
| plugin → 服务端 | `send` | plugin 主动发起的消息（不是回复，少用） |

### 7.3 鉴权

```
Authorization: Bearer ocw_xxxxxxxxxxxx       (推荐)
?token=ocw_xxxxxxxxxxxx                       (CLI 兼容)
```

握手失败的 close code：

| code | 含义 |
|---|---|
| `4401` | token 缺失 / 无效 / 已撤销 |
| `4402` | 被新连接 superseded |
| `4403` | bot 状态不是 `online` |

---

## 8. 安全模型

- **per-bot token**：每个 WS Bot 独立 token，前 8 字符（`ocw_xxxx`）用作前缀检索，全 token pbkdf2_sha256 哈希存库；明文只在创建时一次性返回。
- **写入校验**：`reply` 帧带的 `file_ids` 必须属于同频道；目标 Bot 必须是该频道成员且 `status=online`。
- **隔离**：plugin 收到的 `message` 只包含该 Bot 是成员的频道；不会窥探到无关频道。
- **撤销**：在 AdminPage 给 Bot rotate token，旧 token 下次握手即被拒；当前在线连接需要等心跳过期或主动断开。

---

## 9. 排错速查

| 现象 | 原因 / 处置 |
|---|---|
| `openclaw channels status` 显示 `disabled` | `enabled=false`、`botToken` 缺失，或配置 JSON 解析失败 |
| close `4401` | token 写错；从 AgentNexus 后台 rotate 拿新的 |
| close `4402` | 同 token 在别处也连着；停掉旧进程或 rotate |
| close `4403` | Bot 状态不是 `online`，去 AgentNexus 改成 `online` |
| 频道里 `@bot` 没反应 | Bot 不是该频道成员；或 control 流断了 plugin 还没重连完 |
| `reply` 老是 `send_ack ok=false` | `file_ids` 跨频道、或 `reply_to_msg_id` 指向其他频道；从 `message` 帧里直接取 `channel_id` 透传 |
| 长连接每隔几分钟断一次 | 反代 `proxy_read_timeout` 太短，调到 ≥ 600s |
| WSS 握手 502/握手失败 | nginx 没开 `proxy_http_version 1.1` + `Upgrade` / `Connection` 头 |

后端调试：

```bash
docker compose logs -f backend | grep -E 'control_ws|data_ws|openclaw'
```

OpenClaw 调试：

```bash
openclaw daemon logs --follow | grep agentnexus
```

---

## 10. FAQ

**Q：能不能不通过 OpenClaw plugin，直接用自己写的客户端连两条 WS？**
能。协议公开，鉴权用 `Bearer ocw_...`，按第 7 节实现 `hello / message / reply / delta / send_ack` 即可。OpenClaw plugin 只是其中一个参考实现。

**Q：一个 OpenClaw 进程能挂几个 Bot？**
没硬上限。一个 account = 一个 Bot = 两条 WS（control + data）；按机器资源决定。

**Q：消息支持流式吗？**
支持。plugin 每收到 agent 一段 token，就发 `delta` 帧，AgentNexus 广播 `message_stream`；最后用 `reply` 帧 finalize。

**Q：plugin 离线时，期间发的 `@bot` 会丢吗？**
后端会把消息当作 placeholder 存库；plugin 重连后可以基于 `pending_replies` 兜底（`reply_to_msg_id` / `task_id` peek），从而把答复贴回原占位。但**无主动重投**——如果 plugin 重连前 placeholder 已超时（默认 60s），就只是一条"等待超时"的消息。

**Q：能给 Bot 上传文件吗？**
可以。frontend 上传后会在 `message` 帧里带 `file_ids`，plugin 透传给 agent；agent 回复时也可以带 `file_ids`（必须是已上传到该频道的文件 id）。

---

## 11. 进一步阅读

- `packages/openclaw-channel-agentnexus/README.md` —— plugin 实现细节、本地开发方式、demo 脚本
- `docs/develop/OpenClaw_channel_plugin_接入指南.md` —— 完整协议规范（含历史决策与 TODO）
- `backend/app/api/v1/openclaw_bridge/routes.py` —— 后端两条 WS 的权威实现
- `backend/app/services/openclaw_bridge/` —— dispatcher / pending / token 等模块
