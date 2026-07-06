# ACP 连接器 `config.toml` —— 完整字段参考

> **语言**：[English](CONNECTOR_TOML_CONFIG.md) | 中文

Cheers ACP 连接器（`cce-acp-connector`）读取的本地 TOML 配置的逐字段参考。这个文件
是一份**人工审计的安全策略**：它声明远端 Cheers 后端**被允许让你这台机器做什么**。
它用 TOML（而非 JSON）是有意为之——便于阅读与审阅；协议帧与状态文件仍是 JSON。

相关：[Agent Bridge 接入指南](../help/AgentBridge接入指南.zh-CN.md) ·
[Bot 配置治理](BOT_CONFIG_GOVERNANCE.md) ·
[Bot 配置分层（L0/L1/L2）](BOT_CONFIG_LAYERING.md) ·
[ACP 审批流](ACP_APPROVAL_FLOW.md)。

通常你会从接入流程直接拿到一份可编辑的配置（**设置 → Bots → 你的 bot → 连接器配置**，
或 `GET /api/v1/bots/{bot_id}/connector-config`）。本页解释**每一个键**，方便你手工微调或审阅。

---

## 先读：它是怎么被解析的

- **`version` 必须是 `1`。** 其它值直接报错。
- **未知键会被拒绝。** 每张表都是 `deny_unknown_fields`，所以像 `command_line =`
  这样的拼写错误或多余键会让整份配置加载失败并给出明确报错——绝不会静默忽略。
  守护进程起不来时，先查拼写。
- **相对路径相对于配置文件所在目录**解析，而非你 shell 的当前目录。`~` 展开为家目录。
- **一个文件可承载多个 bot。** 每个 `[accounts.<id>...]` 块是一个 bot；`<id>` 是本地
  标签（字母、数字、`_`、`-`）。一个守护进程会运行其配置文件里的**每一个** account——
  `--name` 标识的是*守护进程实例*（其状态/日志/pid 目录 `~/.cheers/acp-connector/<name>/`），
  它**不**用来选择某个 account，`<id>` 也无需与它一致。
- 这是分层模型里的 **L0**：连接器总会把后端下推的东西（model、mode、config option）
  重新钳制到这里的上限。再宽松的后端也无法越过 L0 允许的范围。

---

## 顶层

```toml
version = 1
```

| 键        | 类型 | 默认 | 含义 |
|-----------|------|------|------|
| `version` | int  | —    | 配置模式版本。**必须为 `1`。** |

### `[daemon]` —— 守护进程级（可选）

作用于整个守护进程，而非单个 bot。

| 键           | 类型   | 默认         | 含义 |
|--------------|--------|--------------|------|
| `name`       | string | 无           | 保留字段；当前会被接受但不读取。 |
| `home_dir`   | string | —            | 保留字段；守护进程 home 由 `--home` / `CHEERS_ACP_HOME` 决定（默认 `~/.cheers/acp-connector`），**不**由此键设置。 |
| `state_path` | string | `state.json` | 守护进程持久化运行态的位置（相对配置文件所在目录）。 |
| `log_dir`    | string | `~/.cheers/acp-connector/<name>/` | 守护进程写 `stdout`/`stderr` 日志的位置。设置后日志为 `<log_dir>/<name>.stdout.log` / `.stderr.log`。 |

---

## 单个 bot：`[accounts.<id>]`

下面所有内容都归属于一个账户 id。把 `<id>` 换成你 bot 的本地标签（如 `haowei_codex`）。

### `[accounts.<id>.bridge]` —— 如何连到后端

| 键                      | 类型   | 默认     | 含义 |
|-------------------------|--------|----------|------|
| `control_url`           | string | 必填     | Agent Bridge **control** WebSocket，如 `wss://cheers.example.com/ws/agent-bridge/control`。 |
| `data_url`              | string | 必填     | Agent Bridge **data** WebSocket（`…/ws/agent-bridge/data`）。 |
| `bot_token_env`         | string | —        | 保存 bot token 的环境变量名。 |
| `bot_token_file`        | string | —        | 保存 bot token 的文件路径（`chmod 600`）。 |
| `heartbeat_interval_ms` | int    | `25000`  | control-WS 心跳间隔。 |
| `ack_timeout_ms`        | int    | `600000` | 等待后端确认一个 data 帧的超时，超时视为发送失败。 |

**`bot_token_env` / `bot_token_file` 恰好提供其一。** token 就是连接器用来鉴权的凭据
（与你通过 `POST /api/v1/bots/{bot_id}/token` 铸造的是同一个）。守护进程优先用
`bot_token_file`，shell/容器里用 `…_env`。

#### `[accounts.<id>.bridge.reconnect]`

| 键        | 类型 | 默认    | 含义 |
|-----------|------|---------|------|
| `base_ms` | int  | `500`   | 初始重连退避。 |
| `max_ms`  | int  | `30000` | 退避上限（其间指数增长）。 |

### `[accounts.<id>.adapter]` —— 如何启动本地 ACP agent

这是**唯一**描述启动 agent 二进制的段。文件系统与终端访问归那个被拉起的进程所有
（受 OS 用户、cwd、容器/沙箱约束）——连接器**不**代理 ACP 客户端侧的 fs/terminal。

| 键                | 类型     | 默认 | 含义 |
|-------------------|----------|------|------|
| `type`            | string   | 必填 | 必须是 `"stdio"`（连接器通过 agent 的 stdio 讲 ACP）。 |
| `command`         | string   | 必填 | ACP agent 二进制——绝对路径或 `PATH` 上的名字（如 `codex-acp`、`claude-agent-acp`、`opencode-acp`）。 |
| `args`            | string[] | `[]` | 传给 agent 的额外 CLI 参数。 |
| `permission_mode` | string   | 无   | **临时手段**：启动时通过 `session/set_mode` 强制 agent 的 ACP 会话模式（如 `"default"` 让它索取权限）。不了解 agent 的 mode id 就别写。 |

> ⚠ 对 **Codex** bot，`command = "codex-acp"` 必须在本机可解析（`which codex-acp`），
> 且 Codex 本身已登录。二进制缺失是 bot 迟迟不**上线**的头号原因。

### 策略段 —— 安全信封（`[accounts.<id>.policy.*]`）

所有 policy 表均可选；每个键缺省时用下面的默认值。

#### `.policy.sessions`

| 键                   | 类型 | 默认     | 含义 |
|----------------------|------|----------|------|
| `create`             | bool | `true`   | 后端可开新 ACP 会话。 |
| `load`               | bool | `true`   | 后端可恢复/加载既有会话。 |
| `cancel`             | bool | `true`   | 后端可取消进行中的回合。 |
| `terminate`          | bool | `true`   | 后端可终止会话。 |
| `request_timeout_ms` | int  | `120000` | 单次会话 RPC 超时。 |

#### `.policy.prompt`

| 键                      | 类型 | 默认     | 含义 |
|-------------------------|------|----------|------|
| `allow`                 | bool | `true`   | 总开关：是否接受 prompt 回合。 |
| `max_concurrent`        | int  | `1`      | 每个 bot 的并发回合（除非 agent 可重入，保持 1）。 |
| `max_prompt_bytes`      | int  | `200000` | 超过则拒绝该 prompt。 |
| `max_duration_ms`       | int  | `900000` | 超过时长（15 分钟）就杀掉该回合。 |
| `allow_attachments`     | bool | `true`   | 允许 prompt 携带非图片附件。 |
| `allow_images`          | bool | `true`   | 允许内联图片内容块。 |
| `allow_audio`           | bool | `true`   | 允许内联音频内容块。 |
| `allow_local_file_refs` | bool | `false`  | 允许 prompt 直接引用本地路径。默认关闭。 |

#### `.policy.workspace`

| 键                    | 类型     | 默认    | 含义 |
|-----------------------|----------|---------|------|
| `default_cwd`         | string   | 无      | 后端未指定 cwd 时 agent 启动所在目录。 |
| `backend_may_set_cwd` | bool     | `false` | 后端能否从 `allowed_roots` 选会话 cwd？ |
| `allowed_roots`       | string[] | `[]`    | 会话 cwd 与附加目录只能落在这些目录之下。 |
| `git_ops`             | string   | `"read"`| `"read"` = 暴露只读 `git_status`/`git_diff`/`git_log`；`"off"` = 不暴露 git 资源。 |

#### `.policy.env`

| 键        | 类型     | 默认 | 含义 |
|-----------|----------|------|------|
| `inherit` | bool     | `false` | 继承守护进程的整个环境。保持 `false`。 |
| `allow`   | string[] | `[]`    | 透传的环境变量名（如 `["HOME", "PATH"]`）。 |
| `set`     | table    | `{}`    | 显式注入的 `KEY = "value"` 对。 |

#### `.policy.config` —— model 与原生选项上限（L0）

| 键                               | 类型     | 默认    | 含义 |
|----------------------------------|----------|---------|------|
| `backend_may_set_model`          | bool     | `false` | 后端能否在运行时切换 agent 的 model？ |
| `backend_may_set_native_options` | bool     | `false` | 后端能否设置 agent 原生选项？ |
| `allowed_config_options`         | string[] | `[]`    | 后端可设置的 ACP `configOptions` id 白名单（空 = 一个都不许）。 |

> **为什么你的“config option”设不上去**（常见坑）：config option 是由**运行中的 agent
> 通过 ACP 实时上报**的，连接器会用 `allowed_config_options` 重新钳制。若此列表为空，
> 后端一个都设不了——把该选项 id 加进来。见 [ACP 审批流](ACP_APPROVAL_FLOW.md)。

#### `.policy.permission` —— 工具权限处理 + 模式（L0）

| 键                     | 类型     | 默认       | 含义 |
|------------------------|----------|------------|------|
| `forward_to_backend`   | bool     | `true`     | 把每个 ACP 工具权限请求转发到频道，由人来决定。 |
| `wait_timeout_ms`      | int      | `900000`   | 等待人答复的时长（15 分钟）。 |
| `on_timeout`           | string   | `"cancel"` | 超时动作：`"cancel"` 或 `"deny"`。 |
| `auto_allow`           | bool     | `false`    | `true` 则本地放行每个工具、跳过审批卡。**很强——除非 agent 完全沙箱化，否则保持 `false`。** |
| `backend_may_set_mode` | bool     | `true`     | 后端能否运行时切换 ACP 权限模式（`session/set_mode`）？ |
| `allowed_modes`        | string[] | `[]`       | 后端可选的 ACP 模式 id 白名单（空 = agent 上报的任意模式）。 |

> 不要在这里硬写 `permission_mode = "ask"` 指望本地弹窗——ACP 权限请求会作为
> `permission_request` 帧转发给后端，由人在频道里答复。本段只控制*是否*转发、以及等多久。

#### `.policy.send`

| 键               | 类型 | 默认     | 含义 |
|------------------|------|----------|------|
| `allow`          | bool | `true`   | agent 能否往频道回发消息？ |
| `max_text_bytes` | int  | `200000` | 单条外发消息上限。 |
| `max_files`      | int  | `10`     | 单条外发消息附件数上限。 |

#### `.policy.file_upload`

| 键                      | 类型     | 默认       | 含义 |
|-------------------------|----------|------------|------|
| `allow`                 | bool     | `false`    | agent 能否向后端上传文件？ |
| `max_bytes`             | int      | `26214400` | 单文件大小上限（25 MiB）。 |
| `allowed_content_types` | string[] | `[]`       | MIME 白名单（`allow=true` 时空 = 任意）。 |

#### `.policy.trace`

| 键                  | 类型 | 默认    | 含义 |
|---------------------|------|---------|------|
| `allow`             | bool | `true`  | 向后端发送 agent-trace 时间线事件。 |
| `max_message_bytes` | int  | `32000` | 单个 trace 载荷超过则截断。 |

#### `.policy.session_update`

| 键                 | 类型 | 默认    | 含义 |
|--------------------|------|---------|------|
| `allow`            | bool | `true`  | 转发 ACP `session/update` 通知（流式）。 |
| `include_metadata` | bool | `true`  | 附带更新的 metadata 块。 |

#### `.policy.mcp` —— MCP 服务器注入

| 键                                 | 类型     | 默认    | 含义 |
|------------------------------------|----------|---------|------|
| `inject_cheers`                    | bool     | `true`  | 注入 `cheers` MCP 服务器（desk/inbox/channel 工具）。保持 `true`，否则 bot 没有 Cheers 工具。 |
| `backend_may_inject_extra_servers` | bool     | `false` | 后端能否在运行时追加 MCP 服务器？ |
| `allowed_servers`                  | string[] | `[]`    | 后端可注入的服务器名白名单（如 `["cheers"]`）。 |
| `servers`                          | 表数组   | `[]`    | 你在本地自定义的额外 MCP 服务器。 |

#### `.policy.loopback`

| 键                   | 类型 | 默认     | 含义 |
|----------------------|------|----------|------|
| `request_timeout_ms` | int  | `600000` | 连接器 loopback 资源 IPC 的超时（`cheers` MCP 服务器走这条）。 |

### `[accounts.<id>.security.acp_capability]` —— 签名能力（可选）

仅当后端要求签名 ACP 能力委托（`acp_security.require_capability`）时才需要。

| 键                  | 类型   | 默认       | 含义 |
|---------------------|--------|------------|------|
| `delegation_id`     | string | 必填       | 后端签发的委托 id。 |
| `private_key`       | string | —          | 内联私钥（优先用 env/file 变体）。 |
| `private_key_env`   | string | —          | 保存私钥的环境变量。 |
| `private_key_file`  | string | —          | 保存私钥的文件。 |
| `algorithm`         | string | `"ed25519"`| 签名算法。 |
| `kid`               | string | 无         | 密钥 id 提示。 |
| `request_id_prefix` | string | 无         | 签名请求 id 前缀（便于追踪）。 |

`private_key` / `private_key_env` / `private_key_file` 恰好提供其一。

---

## Codex 最小示例

让 **Codex** bot 上线的最小配置（省略项全部走默认）：

```toml
version = 1

[daemon]
state_path = "state-codex.json"
log_dir    = "logs-codex"

[accounts.haowei_codex.bridge]
control_url    = "wss://www.structure.chat/ws/agent-bridge/control"
data_url       = "wss://www.structure.chat/ws/agent-bridge/data"
bot_token_file = "secrets/codex.token"   # chmod 600

[accounts.haowei_codex.adapter]
type    = "stdio"
command = "codex-acp"                     # 必须在 PATH 上；`which codex-acp`
args    = []

[accounts.haowei_codex.policy.workspace]
default_cwd   = "~/.cheers/workspace"
allowed_roots = ["~/.cheers/workspace"]

[accounts.haowei_codex.policy.config]
# 允许后端从 UI 设置这些 Codex 上报的选项：
allowed_config_options = ["model", "reasoning_effort"]

[accounts.haowei_codex.policy.permission]
# 把工具权限转发到频道由人审批（推荐）。
forward_to_backend = true
allowed_modes      = []                   # [] = Codex 上报的任意模式
```

启动 / 查看：

```bash
cce-acp-connector start  --config ./cheers-codex.toml --name haowei_codex
cce-acp-connector status --name haowei_codex
cce-acp-connector logs   --name haowei_codex --lines 120
cce-acp-connector stop   --name haowei_codex
```

---

## 排查

| 症状 | 可能原因 | 处理 |
|------|----------|------|
| 守护进程起不来，报 “unknown field” | 拼写错/多余键（`deny_unknown_fields`） | 按它点名的键修正 |
| 起不来，报 “unsupported config version” | `version` ≠ `1` | 设 `version = 1` |
| bot 迟迟不**上线** | `command` 找不到，或 token 缺失/没写 | `which <command>`；把 token 写进 `bot_token_file`；看 `logs` |
| UI 里**设不上 config option** | 选项不在 `allowed_config_options`，或 bot 离线 | 把该 id 加进 `allowed_config_options`；让 bot 上线 |
| **设不上 mode** | mode 不在 `allowed_modes`，或 `backend_may_set_mode = false` | 加上 mode id（或用 `[]` 表示任意）；开启 `backend_may_set_mode` |
| agent 读不到上传的文件 | 它尝试 HTTP 网关 | agent 通过 `cheers` MCP 的 `inbox_open` 工具读附件，绝不 HTTP |
| bot 没有 Cheers 工具 | `inject_cheers = false` | 设 `inject_cheers = true` |
