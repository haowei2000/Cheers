# Local Bot Setup Guide (ACP Connector)

> **Language**: English | [中文](本地Bot配置指南.zh-CN.md)

For users / developers connecting an ACP agent (e.g. Codex, Claude) **as a local host daemon**.
It covers: how to configure one bot, where the token goes, how to manage multiple bots, and how to troubleshoot.

- For containerized deployment (the built-in OpenCode bot in Docker) and the full "create a bot in the UI"
  flow, see the [Agent Bridge Integration Guide](AgentBridge接入指南.md). This document focuses on the
  **local path: gateway from source + a host connector**.
- Terms: **Gateway** (the Rust backend in `server/`), **Connector** (`cce-acp-connector`, bridges an ACP
  agent to the gateway), **ACP agent** (the `codex-acp` / `claude-agent-acp` child process).

---

## 0. Mental model (one line)

```
your browser ──▶ gateway(:8000, from source) ◀──WebSocket── connector daemon ──stdio──▶ ACP agent (codex/claude)
                                                            └ one TOML = one bot = one daemon
```

Three rules:

1. **One TOML file = one bot = one daemon** (distinguished by `--name`). Two bots → two files, two daemons, fully independent.
2. **Put the token in a separate sidecar file** (`bot_token_file`); **not inline in the TOML** (configs get committed/shared — a plaintext token leaks), and for local use **avoid env vars** (you'd re-export on every restart, and it shows up in the process environment).
3. The gateway runs from source and reuses your existing Docker infra (Postgres/Redis/RustFS). **Do not** `docker compose up` the repo's `docker-compose.yml` — it's stale and would collide with your running containers on ports 5432/6379/9000.

---

## 1. Prerequisites

| Dependency | Check | Notes |
|---|---|---|
| Gateway running | `curl -fsS http://127.0.0.1:8000/health` → `ok` | From source: `server/.dev/run-dev.sh` (injects RS256 JWT keys + `cargo run`) |
| ACP agent installed | `command -v codex-acp` / `command -v claude-agent-acp` | Usually `npm i -g @agentclientprotocol/codex-acp` etc., landing in `/opt/homebrew/bin/` |
| Agent auth ready | `~/.codex` / `~/.claude` exists | Codex/Claude use **subscription auth** (passed to the child via `HOME`), so no `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` needed; if you use an API key, export it and add it to that bot's `policy.env.allow` |
| Connector binary | `cce-acp-connector --help` | Prebuilt release download (§1.1, recommended), or from source: `cargo build` in `packages/cheers-acp-connector-rs/` → `target/debug/cce-acp-connector` |

### 1.1 Get the connector binary (prebuilt release)

Download the platform binary from the project's
[GitHub Releases](https://github.com/haowei2000/Cheers/releases/latest) — no Rust
toolchain needed (`release-connector` publishes
`cce-acp-connector-{darwin,linux}-{arm64,amd64}` per tag):

```bash
os=$(uname -s | tr 'A-Z' 'a-z'); arch=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
mkdir -p ~/.cheers/bin
curl -fsSL -o ~/.cheers/bin/cce-acp-connector \
  "https://github.com/haowei2000/Cheers/releases/latest/download/cce-acp-connector-$os-$arch"
chmod +x ~/.cheers/bin/cce-acp-connector
export PATH="$HOME/.cheers/bin:$PATH"   # add to your shell profile to keep it
cce-acp-connector --help
```

To pin a version, replace `latest/download` with `download/connector-v<version>`
(e.g. `download/connector-v0.1.22`). While the repository is **private**, plain curl
returns 404 — download with the authenticated GitHub CLI instead:
`gh release download connector-v0.1.22 -R haowei2000/Cheers -p "cce-acp-connector-$os-$arch" -O ~/.cheers/bin/cce-acp-connector`.
Developers hacking on the connector itself can
keep using the source build (`cargo build` → `target/debug/cce-acp-connector`);
the commands below assume `cce-acp-connector` is on `PATH` either way.

---

## 2. Recommended layout

Keep **runtime config + secrets outside the repo** (`~/.cheers/`); treat the repo's `examples/*.toml` as templates only:

```
~/.cheers/
├─ cheers-daemon.codex.toml      # bot: codex (one file = one bot)
├─ cheers-daemon.claude.toml     # bot: claude
├─ secrets/
│   ├─ codex.token   (chmod 600) # token plaintext only, gitignored
│   └─ claude.token  (chmod 600)
├─ workspace/                    # the agent's working dir (allowed_roots)
├─ logs-codex/ · logs-claude/    # per-bot logs
└─ state-codex.json · state-claude.json   # per-bot session state
```

Daemon metadata (pid, etc.) lives in `~/.cheers/acp-connector/<name>/daemon.json` (override the root with `--home` or the `CHEERS_ACP_HOME` env var).

---

## 3. Connect a bot in 5 steps

Example: **codex** (for claude, swap the name / command / bot_id).

### 3.1 Confirm/create the bot in Cheers, get its `bot_id`
UI: log in → Settings → Bots → New (set bridge_provider to generic/acp). Or list via API:

```bash
TOK=$(curl -s -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"admin12345"}' | jq -r .access_token)   # local default admin: see server/.env
curl -s http://127.0.0.1:8000/api/v1/bots -H "Authorization: Bearer $TOK" \
  | jq -r '.[] | "\(.username)  \(.bot_id)"'
```

### 3.2 Issue a token into a sidecar file (mode 600)
> ⚠️ Issuing **rotates**: the old token is invalidated immediately. Make sure no other connector is using this bot.

```bash
mkdir -p ~/.cheers/secrets && chmod 700 ~/.cheers/secrets
curl -s -X POST "http://127.0.0.1:8000/api/v1/bots/<BOT_ID>/token" \
  -H "Authorization: Bearer $TOK" | jq -r .token > ~/.cheers/secrets/codex.token
chmod 600 ~/.cheers/secrets/codex.token
```

### 3.3 Write the per-bot config `~/.cheers/cheers-daemon.codex.toml`
(Field reference in [§6](#6-full-config-reference). `bot_token_file` resolves relative to **the config file's directory**.)

```toml
version = 1

[daemon]
state_path = "state-codex.json"     # relative to this file's dir (~/.cheers)
log_dir    = "logs-codex"

[accounts.codex.bridge]
control_url    = "ws://localhost:8000/ws/agent-bridge/control"
data_url       = "ws://localhost:8000/ws/agent-bridge/data"
bot_token_file = "secrets/codex.token"   # ← token in a file, not inline, not env

[accounts.codex.adapter]
type    = "stdio"
command = "/opt/homebrew/bin/codex-acp"
args    = []

[accounts.codex.policy.prompt]
allow = true
allow_attachments = true
allow_images      = true             # images are only sent if the agent supports them, else downgraded to text

[accounts.codex.policy.workspace]
default_cwd   = "~/.cheers/workspace"
allowed_roots = ["~/.cheers/workspace"]
backend_may_set_cwd = true

[accounts.codex.policy.env]
inherit = false
allow   = ["HOME", "PATH", "OPENAI_API_KEY"]   # HOME lets the child read ~/.codex subscription auth

[accounts.codex.policy.permission]
forward_to_backend = true            # route the agent's tool-permission requests to the channel approval card
wait_timeout_ms    = 900000
on_timeout         = "cancel"        # only "cancel" or "deny"
auto_allow         = false           # true = auto-approve locally, never reaches the channel

[accounts.codex.policy.mcp]
inject_cheers = true                 # inject the cheers stdio MCP (virtual filesystem, etc.)
```

> This is the **minimal** form (omitted fields have sensible defaults). For a full template, copy
> `packages/cheers-acp-connector-rs/examples/cheers-daemon.codex.toml` and switch the token source to `bot_token_file`.

### 3.4 Start the daemon
```bash
cce-acp-connector start \
  --config ~/.cheers/cheers-daemon.codex.toml --name codex
```
(Because the token is in a file, **restarts need no env export**.)

### 3.5 Verify
```bash
cce-acp-connector status --name codex          # → status=running
cce-acp-connector logs   --name codex --lines 40
# expect: "initialized ACP agent" + "Rust BridgeRuntime started", no ERROR
```
Confirm online from the gateway side:

```bash
curl -s http://127.0.0.1:8000/api/v1/bots -H "Authorization: Bearer $TOK" \
  | jq -r '.[] | select(.username=="codex") | .status'        # → online
```
Finally, @-mention the bot in a channel and check the reply comes back.

---

## 4. Multiple bots

**One file per bot, one daemon each** (independent lifecycle: restarting codex doesn't touch claude):

```bash
cce-acp-connector start --config ~/.cheers/cheers-daemon.codex.toml  --name codex
cce-acp-connector start --config ~/.cheers/cheers-daemon.claude.toml --name claude
```

To avoid typing per bot, drop in a small launcher `~/.cheers/cheers-bots.sh` that derives `--name` from the filename:

```bash
#!/usr/bin/env bash
set -euo pipefail
BIN="${CCE_BIN:-$HOME/.cheers/bin/cce-acp-connector}"   # release binary from §1.1 (or point CCE_BIN at a source build)
CONF_DIR="${CHEERS_CONF_DIR:-$HOME/.cheers}"
action="${1:-status}"
shopt -s nullglob
for f in "$CONF_DIR"/cheers-daemon.*.toml; do        # matches cheers-daemon.<name>.toml only
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
~/.cheers/cheers-bots.sh start     # start all bots
~/.cheers/cheers-bots.sh status    # status of all bots
```

> **Why not put many bots in one TOML?** The schema supports it (`[accounts.A]`, `[accounts.B]` in one file,
> one daemon serving all), but then they **share a lifecycle** (restart stops all), share logs/state, and one
> crash takes all down. Unless you manage a group of identical bots as one unit, **one file per bot** is better:
> independent restart, separate logs, fault isolation.

---

## 5. Where the token goes: file vs env vs inline

The schema **requires** exactly one of `bot_token_env` / `bot_token_file`, and **rejects** an inline `bot_token` in the TOML (a deliberate security choice).

| | Inline in TOML | Env var `bot_token_env` | **Sidecar file `bot_token_file`** ✅ local default |
|---|---|---|---|
| Supported | ❌ rejected | ✅ | ✅ |
| Commit-safe | plaintext into git/screenshots/tickets | config has no secret | config has no secret; token gitignored separately |
| Restart / launcher | — | must re-export each time | works as-is, no export |
| Leak surface | largest | visible in process env (`ps eww`), shell history | in memory only; file is 600 |
| Rotation | edit the config (risk fat-fingering) | re-export + restart | overwrite one small file |
| Best for | don't | **containers / CI** (secrets manager injects, no disk) | **local host daemons** |

**Bottom line:** use `bot_token_file` locally; use `bot_token_env` only when something external (container orchestrator / CI secrets manager) injects the secret at runtime.

---

## 6. Full config reference

Each `[accounts.<id>....]` is one bot. `<id>` is yours to choose (match `--name` and the filename).

```toml
version = 1                          # config version, fixed at 1

[daemon]                             # daemon-level (shared by this file); paths relative to this file's dir
state_path = "state-codex.json"      # session state store
log_dir    = "logs-codex"            # log dir (<name>.stdout.log / .stderr.log)

# ── bridge (connect to the gateway) ──
[accounts.codex.bridge]
control_url           = "ws://localhost:8000/ws/agent-bridge/control"
data_url              = "ws://localhost:8000/ws/agent-bridge/data"
bot_token_file        = "secrets/codex.token"   # or bot_token_env = "VAR"; exactly one
heartbeat_interval_ms = 25000
ack_timeout_ms        = 600000
[accounts.codex.bridge.reconnect]
base_ms = 500
max_ms  = 30000

# ── ACP agent child process ──
[accounts.codex.adapter]
type    = "stdio"                    # stdio only for now
command = "/opt/homebrew/bin/codex-acp"
args    = []

# ── policy ──
[accounts.codex.policy.sessions]     # allowed session controls
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
allow_images = true                  # AND-ed with the agent's promptCapabilities.image; else downgraded to a text summary
allow_local_file_refs = false

[accounts.codex.policy.workspace]
default_cwd = "~/.cheers/workspace"
allowed_roots = ["~/.cheers/workspace"]   # cwd must be under these
backend_may_set_cwd = true

[accounts.codex.policy.env]
inherit = false                      # false = don't inherit the full env, only allow these
allow = ["HOME", "PATH", "OPENAI_API_KEY"]
# set = { FOO = "bar" }              # optional: extra env vars to inject

[accounts.codex.policy.config]
backend_may_set_model = false
backend_may_set_native_options = false
allowed_config_options = []

[accounts.codex.policy.permission]
forward_to_backend = true            # true = route tool-permission requests to the channel approval card
wait_timeout_ms = 900000
on_timeout = "cancel"                # timeout action: only "cancel" or "deny"
auto_allow = false                   # true = auto-approve locally, never reaches the channel

[accounts.codex.policy.send]
allow = true
max_text_bytes = 200000
max_files = 10

[accounts.codex.policy.mcp]
inject_cheers = true                 # inject the cheers stdio MCP (baseline transport, no capability needed)
backend_may_inject_extra_servers = false
allowed_servers = ["cheers"]
# servers = [ ... ]                   # optional: extra MCP servers (http/sse require the agent's matching mcpCapabilities)

[accounts.codex.policy.loopback]
request_timeout_ms = 30000

# ── optional / advanced: capability signing ──
# [accounts.codex.security.acp_capability]
# private_key_env = "..."   # or private_key_file; exactly one
```

---

## 7. Operations

```bash
BIN=~/.cheers/bin/cce-acp-connector   # release binary from §1.1 (or a source build)
$BIN status  --name codex
$BIN logs    --name codex --lines 120
$BIN restart --name codex        # restarts only codex; no export needed with file-based token
$BIN stop    --name codex
$BIN run     --config <file>     # run in the foreground (debugging, not daemonized)
```

- **Rotate a token:** re-issue (§3.2) over `secrets/<name>.token`, then `restart --name <name>`.
- **Auto-start on login:** write a launchd plist (one per bot, or one that runs `cheers-bots.sh start`). Ask if you want one.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `start` exits immediately / log mentions token | token source missing or empty | `bridge` must set one of `bot_token_env` / `bot_token_file`; check the file exists and is non-empty |
| `bot_token_env ... is not set` | using env but didn't export | switch to `bot_token_file`, or export before starting |
| log `ACP agent ... command not found` | wrong agent binary path | `command -v codex-acp`, put the absolute path in `adapter.command` |
| agent starts but no reply / child auth fails | child can't reach auth | `policy.env.allow` must include `HOME` (subscription auth) or the API-key var (and export it) |
| can't connect / endless reconnect | gateway down or wrong URL | `curl :8000/health`; point `control_url/data_url` at `ws://localhost:8000/ws/agent-bridge/...` |
| `unsupported protocolVersion ... Closing` | agent's ACP major version differs from the connector | upgrade/downgrade the agent to a compatible version |
| gateway panics on start (JWT) | missing RS256 keys | use `server/.dev/run-dev.sh` (injects the PEMs); don't `docker compose up` the stale compose |
| port conflict bringing up the stack | accidentally ran the repo `docker-compose.yml` | reuse your existing Postgres/Redis/RustFS; **don't** `up` the repo file (5432/6379/9000 collide) |
| tool action hangs waiting for approval | `auto_allow=false` | approve via the channel card; or set `auto_allow=true` temporarily |

---

## 9. References

- [Agent Bridge Integration Guide](AgentBridge接入指南.md): concepts, creating a bot in the UI, the Docker OpenCode bot, OpenClaw (legacy)
- [Installation Guide](安装部署说明.md): overall deployment, `.env`, migrations
- [Troubleshooting Q&A](技术排查Q&A.md): health checks, logs, bot no-response
- Connector source: `packages/cheers-acp-connector-rs/` (editable templates under `examples/`)
- Run the gateway from source: `server/.dev/run-dev.sh`
