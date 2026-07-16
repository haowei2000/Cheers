# 本地 Bot 配置指南（ACP Connector）

> **语言**：中文 | [English](本地Bot配置指南.md)

面向**在本机以 host 守护进程方式**接入 ACP Agent（如 Codex、Claude）的用户 / 开发者。
讲清楚：一个 bot 怎么配、token 放哪、多个 bot 怎么管、怎么排障。

- 容器化部署（Docker 内置 OpenCode Bot）、在 UI 里创建 Bot 的完整流程，见
  [AgentBridge 接入指南](AgentBridge接入指南.md)。本文聚焦**本地、从源码跑网关 + host 连接器**这条链路。
- 名词：**网关 / Gateway**（Rust 后端，`server/`）、**连接器 / Connector**（`cce-acp-connector`，把
  ACP Agent 桥接到网关）、**ACP Agent**（`codex-acp` / `claude-agent-acp` 等子进程）。

---

## 0. 心智模型（一句话）

```
你的浏览器 ──▶ 网关(:8000, 从源码跑) ◀──WebSocket── 连接器守护进程 ──stdio──▶ ACP Agent(codex/claude)
                                                   └ 一个 TOML = 一个 bot = 一个守护进程
```

三条铁律：

1. **一个 TOML 文件 = 一个 bot = 一个守护进程**（用 `--name` 区分）。两个 bot 就两个文件、两个守护进程，互不影响。
2. **Token 放在独立的 sidecar 文件里**（`bot_token_file`），**不写进 TOML**（TOML 会被提交/分享，明文 token 会泄露），本地也**不建议用环境变量**（重启要重新 export，且会进程环境可见）。
3. 网关从源码跑、复用已有 Docker 基础设施（Postgres/Redis/RustFS）；**不要**对本仓库的 `docker-compose.yml` 跑 `up`（它已过时，且会和已有容器抢 5432/6379/9000 端口）。

---

## 1. 前置条件

| 依赖 | 检查 | 说明 |
|---|---|---|
| 网关在跑 | `curl -fsS http://127.0.0.1:8000/health` → `ok` | 从源码启动：`server/.dev/run-dev.sh`（注入 RS256 JWT 密钥 + `cargo run`） |
| ACP Agent 已装 | `command -v codex-acp` / `command -v claude-agent-acp` | 一般是 `npm i -g @agentclientprotocol/codex-acp` 等，落在 `/opt/homebrew/bin/` |
| Agent 鉴权就绪 | `~/.codex` / `~/.claude` 存在 | Codex/Claude 用**订阅鉴权**（经 `HOME` 传给子进程），无需 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`；如用 API Key 则在 shell 里 export，并加进该 bot 的 `policy.env.allow` |
| 连接器二进制 | `cce-acp-connector --help` | 预编译 Release 下载（§1.1，推荐）；或源码构建：在 `packages/cheers-acp-connector-rs/` 里 `cargo build` → `target/debug/cce-acp-connector` |

### 1.1 获取连接器二进制（预编译 Release）

直接从项目的 [GitHub Releases](https://github.com/ElePerson/Cheers/releases/latest)
下载对应平台的二进制，无需 Rust 工具链（`release-connector` workflow 按 tag 发布
`cce-acp-connector-{darwin,linux}-{arm64,amd64}` 四个产物）：

```bash
os=$(uname -s | tr 'A-Z' 'a-z'); arch=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
mkdir -p ~/.cheers/bin
curl -fsSL -o ~/.cheers/bin/cce-acp-connector \
  "https://github.com/ElePerson/Cheers/releases/latest/download/cce-acp-connector-$os-$arch"
chmod +x ~/.cheers/bin/cce-acp-connector
export PATH="$HOME/.cheers/bin:$PATH"   # 写进 shell profile 长期生效
cce-acp-connector --help
```

需要固定版本时，把 `latest/download` 换成 `download/connector-v<版本号>`
（例如 `download/connector-v0.1.22`）。仓库还是**私有**时匿名 curl 会 404，
有权限的用户改用 GitHub CLI 认证下载：
`gh release download connector-v0.1.22 -R ElePerson/Cheers -p "cce-acp-connector-$os-$arch" -O ~/.cheers/bin/cce-acp-connector`。
开发连接器本身的同学仍可用源码构建
（`cargo build` → `target/debug/cce-acp-connector`）；下文命令默认
`cce-acp-connector` 已在 `PATH` 上，两种方式均可。

---

## 2. 目录布局（推荐）

把**运行期配置 + 密钥放在仓库外**（`~/.cheers/`），仓库里的 `examples/*.toml` 只当模板：

```
~/.cheers/
├─ cheers-daemon.codex.toml      # bot：codex（一个文件一个 bot）
├─ cheers-daemon.claude.toml     # bot：claude
├─ secrets/
│   ├─ codex.token   (chmod 600) # 仅 token 明文，gitignore
│   └─ claude.token  (chmod 600)
├─ workspace/                    # Agent 的工作目录（allowed_roots）
├─ logs-codex/ · logs-claude/    # 每个 bot 独立日志
└─ state-codex.json · state-claude.json   # 每个 bot 独立会话状态
```

守护进程元数据（pid 等）在 `~/.cheers/acp-connector/<name>/daemon.json`（可用 `--home` 或环境变量 `CHEERS_ACP_HOME` 改根目录）。

---

## 3. 五步接入一个 Bot

下面以 **codex** 为例（claude 把名字/命令/bot_id 换掉即可）。

### 3.1 在 Cheers 里确认/创建 Bot，拿到 `bot_id`
UI：登录 → 设置 → Bots → 新建（bridge_provider 选 generic/acp）。或用 API 列出：

```bash
TOK=$(curl -s -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"admin12345"}' | jq -r .access_token)   # 本地默认管理员见 server/.env
curl -s http://127.0.0.1:8000/api/v1/bots -H "Authorization: Bearer $TOK" \
  | jq -r '.[] | "\(.username)  \(.bot_id)"'
```

### 3.2 签发 token，写进 sidecar 文件（mode 600）
> ⚠️ 签发会**轮换**：旧 token 立刻失效。确保没有别的连接器在用同一个 bot。

```bash
mkdir -p ~/.cheers/secrets && chmod 700 ~/.cheers/secrets
curl -s -X POST "http://127.0.0.1:8000/api/v1/bots/<BOT_ID>/token" \
  -H "Authorization: Bearer $TOK" | jq -r .token > ~/.cheers/secrets/codex.token
chmod 600 ~/.cheers/secrets/codex.token
```

### 3.3 写 per-bot 配置 `~/.cheers/cheers-daemon.codex.toml`
（完整字段含义见 [§6 配置参考](#6-完整配置参考)。`bot_token_file` 相对**配置文件所在目录**解析。）

```toml
version = 1

[daemon]
state_path = "state-codex.json"     # 相对本文件目录(~/.cheers)
log_dir    = "logs-codex"

[update]                             # 可选：签名自动更新（默认关闭；连接器 >= 0.1.27）
auto = true                          # 验签 ed25519 清单 + sha256，排空后原子替换并原地重启

[accounts.codex.bridge]
control_url    = "ws://localhost:8000/ws/agent-bridge/control"
data_url       = "ws://localhost:8000/ws/agent-bridge/data"
bot_token_file = "secrets/codex.token"   # ← token 放文件，不内联、不用环境变量

[accounts.codex.adapter]
type    = "stdio"
command = "/opt/homebrew/bin/codex-acp"
args    = []

[accounts.codex.policy.prompt]
allow = true
allow_attachments = true
allow_images      = true             # 仅当 Agent 也支持 image 时才真正发图，否则降级为文字

[accounts.codex.policy.workspace]
default_cwd   = "~/.cheers/workspace"
allowed_roots = ["~/.cheers/workspace"]
backend_may_set_cwd = true

[accounts.codex.policy.env]
inherit = false
allow   = ["HOME", "PATH", "OPENAI_API_KEY"]   # HOME 让子进程读 ~/.codex 订阅鉴权

[accounts.codex.policy.permission]
forward_to_backend = true            # 把 Agent 的工具授权请求转到频道审批卡
wait_timeout_ms    = 900000
on_timeout         = "cancel"        # 仅 "cancel" 或 "deny"
auto_allow         = false           # true=本地自动放行、不进频道

[accounts.codex.policy.mcp]
inject_cheers = true                 # 注入 cheers stdio MCP（虚拟文件系统等）
```

> 上面是**精简版**（省略的字段都有合理默认）。要全字段模板，复制
> `packages/cheers-acp-connector-rs/examples/cheers-daemon.codex.toml` 再改 token 来源为 `bot_token_file`。

### 3.4 启动守护进程
```bash
cce-acp-connector start \
  --config ~/.cheers/cheers-daemon.codex.toml --name codex
```
（因为 token 在文件里，**重启无需 export 任何环境变量**。）

### 3.5 验证
```bash
cce-acp-connector status --name codex          # → status=running
cce-acp-connector logs   --name codex --lines 40
# 期望日志：initialized ACP agent  +  Rust BridgeRuntime started，且无 ERROR
```
再从网关侧确认在线：

```bash
curl -s http://127.0.0.1:8000/api/v1/bots -H "Authorization: Bearer $TOK" \
  | jq -r '.[] | select(.username=="codex") | .status'        # → online
```
最后在频道里 @ 这个 bot 发一条消息，看是否回流。

---

## 4. 多个 Bot

**一个 bot 一个文件、各自一个守护进程**（独立生命周期：重启 codex 不影响 claude）：

```bash
cce-acp-connector start --config ~/.cheers/cheers-daemon.codex.toml  --name codex
cce-acp-connector start --config ~/.cheers/cheers-daemon.claude.toml --name claude
```

嫌一条条敲？放个小启动器 `~/.cheers/cheers-bots.sh`，按文件名自动派生 `--name`：

```bash
#!/usr/bin/env bash
set -euo pipefail
BIN="${CCE_BIN:-$HOME/.cheers/bin/cce-acp-connector}"   # §1.1 下载的 release 二进制（或用 CCE_BIN 指向源码构建产物）
CONF_DIR="${CHEERS_CONF_DIR:-$HOME/.cheers}"
action="${1:-status}"
shopt -s nullglob
for f in "$CONF_DIR"/cheers-daemon.*.toml; do        # 只匹配 cheers-daemon.<name>.toml
  base=$(basename "$f"); name=${base#cheers-daemon.}; name=${name%.toml}
  case "$action" in
    start)   "$BIN" status --name "$name" 2>/dev/null | grep -q running \
               && echo "[$name] already running" || "$BIN" start --config "$f" --name "$name" ;;
    stop)    "$BIN" stop    --name "$name" ;;
    restart) "$BIN" restart --config "$f" --name "$name" ;;
    status)  "$BIN" status  --name "$name" | head -2 ;;
    *) echo "usage: $0 {start|stop|restart|status}"; exit 2 ;;
  esac
done
```
```bash
chmod +x ~/.cheers/cheers-bots.sh
~/.cheers/cheers-bots.sh start     # 起所有 bot
~/.cheers/cheers-bots.sh status    # 看所有 bot
```

> **为什么不把多个 bot 塞进一个 TOML？** 配置确实支持（`[accounts.A]`、`[accounts.B]` 同文件，一个守护进程全带），
> 但那样它们**共享生命周期**（重启全停）、共享日志/状态、一个崩全崩。除非是“一组同质 bot 当一个单位管”，
> 否则**一个文件一个 bot** 更好：独立重启、独立日志、故障隔离。

---

## 5. Token 放哪：文件 vs 环境变量 vs 内联

配置 schema **要求** `bot_token_env` 与 `bot_token_file` **二选一**，并**拒绝**在 TOML 里内联 `bot_token`（这是有意的安全设计）。

| | 内联进 TOML | 环境变量 `bot_token_env` | **独立文件 `bot_token_file`** ✅ 本地推荐 |
|---|---|---|---|
| 是否支持 | ❌ 被拒绝 | ✅ | ✅ |
| 提交安全 | 明文进 git/截图/工单 | 配置无明文 | 配置无明文，token 单独 gitignore |
| 重启/启动器 | — | 每次要重新 export | 直接可用，无需 export |
| 泄露面 | 最大 | 进程环境可见（`ps eww`）、shell 历史 | 只在内存；文件 600 |
| 轮换 | 改配置（易误改） | 重新 export + 重启 | 覆盖一个小文件即可 |
| 适用场景 | 不要用 | **容器/CI**（密钥管理器注入、不想落盘） | **本地 host 守护进程** |

**结论**：本地用 `bot_token_file`；只有当外部（容器编排 / CI 的密钥管理器）在运行期注入密钥时才用 `bot_token_env`。

---

## 6. 完整配置参考

每个 `[accounts.<id>....]` 是一个 bot。`<id>` 自取（建议与 `--name`、文件名一致）。

```toml
version = 1                          # 配置版本，固定 1

[daemon]                             # 守护进程级（本文件共享），路径相对本文件目录
state_path = "state-codex.json"      # 会话状态存储
log_dir    = "logs-codex"            # 日志目录（<name>.stdout.log / .stderr.log）

# ── 桥接（连到网关）──
[accounts.codex.bridge]
control_url           = "ws://localhost:8000/ws/agent-bridge/control"
data_url              = "ws://localhost:8000/ws/agent-bridge/data"
bot_token_file        = "secrets/codex.token"   # 或 bot_token_env = "VAR"，二选一
heartbeat_interval_ms = 25000
ack_timeout_ms        = 600000
[accounts.codex.bridge.reconnect]
base_ms = 500
max_ms  = 30000

# ── ACP Agent 子进程 ──
[accounts.codex.adapter]
type    = "stdio"                    # 目前仅 stdio
command = "/opt/homebrew/bin/codex-acp"
args    = []

# ── 策略 ──
[accounts.codex.policy.sessions]     # 允许的会话控制
create = true
load = true
cancel = true
terminate = true
request_timeout_ms = 120000

[accounts.codex.policy.prompt]
allow = true
max_concurrent = 1
max_prompt_bytes = 200000
max_duration_ms = 900000
allow_attachments = true
allow_images = true                  # 与 Agent 的 promptCapabilities.image 取与；不支持则降级为文字摘要
allow_local_file_refs = false

[accounts.codex.policy.workspace]
default_cwd = "~/.cheers/workspace"
allowed_roots = ["~/.cheers/workspace"]   # cwd 必须落在其中
backend_may_set_cwd = true

[accounts.codex.policy.env]
inherit = false                      # false=不继承整套环境，只放行下面这些
allow = ["HOME", "PATH", "OPENAI_API_KEY"]
# set = { FOO = "bar" }              # 可选：额外注入的环境变量

[accounts.codex.policy.config]
backend_may_set_model = false
backend_may_set_native_options = false
allowed_config_options = []

[accounts.codex.policy.permission]
forward_to_backend = true            # true=工具授权请求转到频道审批卡
wait_timeout_ms = 900000
on_timeout = "cancel"                # 超时动作：仅 "cancel" 或 "deny"
auto_allow = false                   # true=本地自动放行、永不进频道

[accounts.codex.policy.send]
allow = true
max_text_bytes = 200000
max_files = 10

[accounts.codex.policy.mcp]
inject_cheers = true                 # 注入 cheers stdio MCP（baseline 传输，无需 capability）
backend_may_inject_extra_servers = false
allowed_servers = ["cheers"]
# servers = [ ... ]                   # 可选：额外 MCP server（http/sse 需 Agent 支持对应 mcpCapabilities）

[accounts.codex.policy.loopback]
request_timeout_ms = 30000

# ── 可选 / 进阶：能力签名 ──
# [accounts.codex.security.acp_capability]
# private_key_env = "..."   # 或 private_key_file；二选一
```

---

## 7. 运维

```bash
BIN=~/.cheers/bin/cce-acp-connector   # §1.1 下载的 release 二进制（或源码构建产物）
$BIN status  --name codex
$BIN logs    --name codex --lines 120
$BIN restart --name codex        # 仅重启 codex；用文件存 token 时无需 export
$BIN stop    --name codex
$BIN run     --config <file>     # 前台运行（调试用，不守护）
```

- **轮换 token**：重新签发（§3.2）覆盖 `secrets/<name>.token`，再 `restart --name <name>`。
- **开机自启**：可写一个 launchd plist（每个 bot 一个，或一个跑 `cheers-bots.sh start`）。需要可让我补一份。

### 自动更新（连接器 >= 0.1.27）

在配置里显式开启（§6）：`[update] auto = true`。当网关通告更新的连接器版本时，
连接器会经网关下载该版本的**签名清单**，用**编译进二进制的 ed25519 公钥**验签，
再逐个校验二进制的 **sha256**，等到没有进行中的对话轮次后，原子替换自身 +
`cheers-mcp-server` 并原地重启（PID 不变，launchd/systemd 无感知）。旧二进制保留为
`<exe>.old`；新版本连续 3 次启动都连不上网关会自动回滚，且该版本不再重试。

- **默认关闭**——更新本质是执行从网络下载的代码，必须由宿主机所有者显式开启。
  即使关闭也有提醒：启动/连接时的 warn 日志 + `cce-acp-connector status` 里的
  `update available:` 行。
- `CHEERS_ACP_NO_SELF_UPDATE=1` 强制禁用；容器内永不自更新（应更新镜像）。
- 全新安装：在安装一行命令前加 `CHEERS_AUTO_UPDATE=1` 即可默认开启。
- **老版本（< 0.1.27）升级注意：先手动升二进制，再加 `[update]`** ——
  旧二进制会拒绝解析含该配置段的文件。

---

## 8. 排障

| 现象 | 多半原因 | 处理 |
|---|---|---|
| `start` 后立刻退出 / 日志报 token | token 来源缺失或空 | `bridge` 必须设 `bot_token_env` 或 `bot_token_file` 之一；检查文件存在且非空 |
| `bot_token_env ... is not set` | 用了 env 但没 export | 改用 `bot_token_file`，或在启动前 export |
| 日志 `ACP agent ... command not found` | Agent 二进制路径不对 | `command -v codex-acp`，把绝对路径填到 `adapter.command` |
| Agent 起来但无回复 / 子进程鉴权失败 | 子进程拿不到鉴权 | `policy.env.allow` 要含 `HOME`（订阅鉴权）或对应 API Key 变量并已 export |
| 网关连不上 / 一直重连 | 网关没跑或 URL 错 | `curl :8000/health`；`control_url/data_url` 指向 `ws://localhost:8000/ws/agent-bridge/...` |
| `unsupported protocolVersion ... Closing` | Agent 的 ACP 主版本与连接器不一致 | 升级/降级 Agent 到兼容版本 |
| 网关启动 panic（JWT） | 缺 RS256 密钥 | 用 `server/.dev/run-dev.sh`（注入 PEM），别直接 `docker compose up` 那份过时 compose |
| 起容器栈后端口冲突 | 误跑了本仓库 `docker-compose.yml` | 本地复用已有 Postgres/Redis/RustFS，**不要** `up` 仓库里那份（5432/6379/9000 冲突） |
| 工具操作卡住等审批 | `auto_allow=false` | 去频道审批卡放行；或临时设 `auto_allow=true` |

---

## 9. 参考

- [AgentBridge 接入指南](AgentBridge接入指南.md)：概念、UI 建 Bot、Docker 内置 OpenCode Bot、OpenClaw（遗留）
- [安装部署说明](安装部署说明.md)：整体部署、`.env`、迁移
- [技术排查 Q&A](技术排查Q&A.md)：健康检查、日志、Bot 无回复
- 连接器源码：`packages/cheers-acp-connector-rs/`（`examples/` 下有可直接改的模板）
- 网关从源码跑：`server/.dev/run-dev.sh`
