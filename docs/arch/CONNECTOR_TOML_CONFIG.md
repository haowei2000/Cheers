# ACP Connector `config.toml` — Full Reference

> **Language**: English | [中文](CONNECTOR_TOML_CONFIG.zh-CN.md)

Field-by-field reference for the local TOML config that the Cheers ACP connector
(`cce-acp-connector`) reads. This file is a **human-audited security policy**: it
declares what the remote Cheers Backend is allowed to make *your machine* do. It
is TOML (not JSON) on purpose so it is easy to read and review; protocol frames
and state files stay JSON.

Related: [Agent Bridge Integration Guide](../help/AgentBridge接入指南.md) ·
[Bot Config Governance](BOT_CONFIG_GOVERNANCE.md) ·
[Bot Config Layering (L0/L1/L2)](BOT_CONFIG_LAYERING.md) ·
[ACP Approval Flow](ACP_APPROVAL_FLOW.md).

You normally get a ready-to-edit config from the onboarding flow
(**Settings → Bots → your bot → connector config**, or
`GET /api/v1/bots/{bot_id}/connector-config`). This page explains **every key** so
you can hand-tune or audit it.

---

## How it is parsed (read this first)

- **`version` must be `1`.** Any other value is a hard error.
- **Unknown keys are rejected.** Every table uses `deny_unknown_fields`, so a typo
  like `command_line =` or a stray key fails the whole load with a clear message —
  it never silently ignores it. If the daemon won't start, check for typos first.
- **Relative paths resolve against the config file's directory**, not your shell's
  CWD. `~` expands to your home directory.
- **One file can host many bots.** Each `[accounts.<id>...]` block is one bot; `<id>`
  is a local label (letters, digits, `_`, `-`). A single daemon runs **every** account
  in its config file — `--name` labels the *daemon instance* (its state/log/pid dir at
  `~/.cheers/acp-connector/<name>/`), it does **not** select one account, and `<id>`
  need not match it.
- This is **L0** in the config layering model: the connector always re-clamps
  anything the Backend pushes (model, mode, config options) against these ceilings.
  A permissive Backend can never exceed what L0 allows here.

---

## Top level

```toml
version = 1
```

| Key       | Type | Default | Meaning |
|-----------|------|---------|---------|
| `version` | int  | —       | Config schema version. **Must be `1`.** |

### `[daemon]` — daemon-wide (optional)

Applies to the whole daemon process, not a single bot.

| Key          | Type   | Default | Meaning |
|--------------|--------|---------|---------|
| `name`       | string | none    | Reserved; currently accepted but not read. |
| `home_dir`   | string | —       | Reserved; the daemon home is set by `--home` / `CHEERS_ACP_HOME` (default `~/.cheers/acp-connector`), **not** by this key. |
| `state_path` | string | `state.json` | Where the daemon persists runtime state (relative to the config file's directory). |
| `log_dir`    | string | `~/.cheers/acp-connector/<name>/` | Where the daemon writes its `stdout`/`stderr` logs. When set, they become `<log_dir>/<name>.stdout.log` / `.stderr.log`. |

---

## Per-bot: `[accounts.<id>]`

Everything below lives under one account id. Replace `<id>` with your bot's local
label (e.g. `haowei_codex`).

### `[accounts.<id>.bridge]` — how to reach the Backend

| Key                     | Type   | Default  | Meaning |
|-------------------------|--------|----------|---------|
| `control_url`           | string | required | Agent Bridge **control** WebSocket, e.g. `wss://cheers.example.com/ws/agent-bridge/control`. |
| `data_url`              | string | required | Agent Bridge **data** WebSocket (`…/ws/agent-bridge/data`). |
| `bot_token_env`         | string | —        | Name of the env var holding the bot token. |
| `bot_token_file`        | string | —        | Path to a file holding the bot token (`chmod 600`). |
| `heartbeat_interval_ms` | int    | `25000`  | Control-WS heartbeat cadence. |
| `ack_timeout_ms`        | int    | `600000` | How long to wait for the Backend to ack a data-frame before treating the send as failed. |

**Provide exactly one of `bot_token_env` / `bot_token_file`.** The token is the
credential the connector authenticates with (the same one you mint via
`POST /api/v1/bots/{bot_id}/token`). Prefer `bot_token_file` for daemons, `…_env`
for shells/containers.

#### `[accounts.<id>.bridge.reconnect]`

| Key       | Type | Default  | Meaning |
|-----------|------|----------|---------|
| `base_ms` | int  | `500`    | Initial reconnect backoff. |
| `max_ms`  | int  | `30000`  | Backoff ceiling (exponential in between). |

### `[accounts.<id>.adapter]` — how to launch the local ACP agent

This is the **only** section that describes starting your agent binary. Filesystem
and terminal access belong to that spawned process (bounded by the OS user, cwd,
container/sandbox) — the connector does **not** proxy ACP client-side fs/terminal.

| Key               | Type     | Default  | Meaning |
|-------------------|----------|----------|---------|
| `type`            | string   | required | Must be `"stdio"` (the connector speaks ACP over the agent's stdio). |
| `command`         | string   | required | The ACP agent binary — absolute path or a name on `PATH` (e.g. `codex-acp`, `claude-agent-acp`, `opencode-acp`). |
| `args`            | string[] | `[]`     | Extra CLI args passed to the agent. |
| `permission_mode` | string   | none     | **Stopgap**: force the agent's ACP session mode on start via `session/set_mode` (e.g. `"default"` so it asks for permission). Omit unless you know the agent's mode ids. |

> ⚠ For a **Codex** bot, `command = "codex-acp"` must resolve on this machine
> (`which codex-acp`) and Codex itself must be authenticated. A missing binary is
> the #1 reason a bot never goes **online**.

### Policy sections — the security envelope (`[accounts.<id>.policy.*]`)

All policy tables are optional; each key falls back to the default below.

#### `.policy.sessions`

| Key                  | Type | Default  | Meaning |
|----------------------|------|----------|---------|
| `create`             | bool | `true`   | Backend may open new ACP sessions. |
| `load`               | bool | `true`   | Backend may resume/load a prior session. |
| `cancel`             | bool | `true`   | Backend may cancel a running turn. |
| `terminate`          | bool | `true`   | Backend may terminate a session. |
| `request_timeout_ms` | int  | `120000` | Per session RPC timeout. |

#### `.policy.prompt`

| Key                     | Type | Default  | Meaning |
|-------------------------|------|----------|---------|
| `allow`                 | bool | `true`   | Master switch: accept prompt turns at all. |
| `max_concurrent`        | int  | `1`      | Concurrent turns per bot (keep at 1 unless the agent is reentrant). |
| `max_prompt_bytes`      | int  | `200000` | Reject prompts larger than this. |
| `max_duration_ms`       | int  | `900000` | Kill a turn that runs longer than this (15 min). |
| `allow_attachments`     | bool | `true`   | Allow non-image file attachments in prompts. |
| `allow_images`          | bool | `true`   | Allow inline image content blocks. |
| `allow_audio`           | bool | `true`   | Allow inline audio content blocks. |
| `allow_local_file_refs` | bool | `false`  | Allow prompts to reference local paths directly. Off by default. |

#### `.policy.workspace`

| Key                   | Type     | Default | Meaning |
|-----------------------|----------|---------|---------|
| `default_cwd`         | string   | none    | CWD the agent starts in when the Backend doesn't set one. |
| `backend_may_set_cwd` | bool     | `false` | May the Backend pick the session cwd (from `allowed_roots`)? |
| `allowed_roots`       | string[] | `[]`    | The only directories the session cwd + additional dirs may live under. |
| `git_ops`             | string   | `"read"`| `"read"` = expose read-only `git_status`/`git_diff`/`git_log`; `"off"` = no git resources. |

#### `.policy.env`

| Key       | Type       | Default | Meaning |
|-----------|------------|---------|---------|
| `inherit` | bool       | `false` | Inherit the daemon's whole environment. Leave `false`. |
| `allow`   | string[]   | `[]`    | Env var names to pass through (e.g. `["HOME", "PATH"]`). |
| `set`     | table      | `{}`    | Explicit `KEY = "value"` pairs to inject. |

#### `.policy.config` — model & native options ceiling (L0)

| Key                              | Type     | Default | Meaning |
|----------------------------------|----------|---------|---------|
| `backend_may_set_model`          | bool     | `false` | May the Backend switch the agent's model at runtime? |
| `backend_may_set_native_options` | bool     | `false` | May the Backend set agent-native options? |
| `allowed_config_options`         | string[] | `[]`    | Allow-list of ACP `configOptions` ids the Backend may set (empty = none). |

> **Why your "config option" won't set** (common gotcha): config options are
> advertised **live by the running agent** over ACP, and the connector re-clamps
> them against `allowed_config_options`. If this list is empty, the Backend can't
> set any — add the option's id here. See [ACP Approval Flow](ACP_APPROVAL_FLOW.md).

#### `.policy.permission` — tool-permission handling + mode (L0)

| Key                    | Type     | Default    | Meaning |
|------------------------|----------|------------|---------|
| `forward_to_backend`   | bool     | `true`     | Route each ACP tool-permission request to the channel so a human decides. |
| `wait_timeout_ms`      | int      | `900000`   | How long to wait for the human answer (15 min). |
| `on_timeout`           | string   | `"cancel"` | On timeout: `"cancel"` or `"deny"`. |
| `auto_allow`           | bool     | `false`    | `true` approves every tool locally and skips the cards. **Powerful — leave `false`** unless the agent runs fully sandboxed. |
| `backend_may_set_mode` | bool     | `true`     | May the Backend switch the ACP permission mode at runtime (`session/set_mode`)? |
| `allowed_modes`        | string[] | `[]`       | Allow-list of opaque ACP mode ids the Backend may select (empty = any mode the agent advertises). |

> Do **not** hard-code `permission_mode = "ask"` here expecting local prompts —
> ACP permission requests are forwarded to the Backend as `permission_request`
> frames; the human answers in the channel. This section only controls *whether*
> forwarding happens and how long it waits.

#### `.policy.send`

| Key              | Type | Default  | Meaning |
|------------------|------|----------|---------|
| `allow`          | bool | `true`   | May the agent post messages back to channels? |
| `max_text_bytes` | int  | `200000` | Cap on a single outbound message. |
| `max_files`      | int  | `10`     | Cap on attachments per outbound message. |

#### `.policy.file_upload`

| Key                     | Type     | Default    | Meaning |
|-------------------------|----------|------------|---------|
| `allow`                 | bool     | `false`    | May the agent upload files to the Backend? |
| `max_bytes`             | int      | `26214400` | Per-file size cap (25 MiB). |
| `allowed_content_types` | string[] | `[]`       | MIME allow-list (empty = any, when `allow=true`). |

#### `.policy.trace`

| Key                 | Type | Default | Meaning |
|---------------------|------|---------|---------|
| `allow`             | bool | `true`  | Emit agent-trace timeline events to the Backend. |
| `max_message_bytes` | int  | `32000` | Truncate a single trace payload beyond this. |

#### `.policy.session_update`

| Key                | Type | Default | Meaning |
|--------------------|------|---------|---------|
| `allow`            | bool | `true`  | Forward ACP `session/update` notifications (streaming). |
| `include_metadata` | bool | `true`  | Include the update's metadata block. |

#### `.policy.mcp` — MCP server injection

| Key                                | Type     | Default | Meaning |
|------------------------------------|----------|---------|---------|
| `inject_cheers`                    | bool     | `true`  | Inject the `cheers` MCP server (desk/inbox/channel tools). Keep `true` or the bot has no Cheers tools. |
| `backend_may_inject_extra_servers` | bool     | `false` | May the Backend add more MCP servers at runtime? |
| `allowed_servers`                  | string[] | `[]`    | Allow-list of server names the Backend may inject (e.g. `["cheers"]`). |
| `servers`                          | array of tables | `[]` | Extra MCP servers *you* define locally. |

#### `.policy.loopback`

| Key                  | Type | Default  | Meaning |
|----------------------|------|----------|---------|
| `request_timeout_ms` | int  | `600000` | Timeout for the connector's loopback resource IPC (the `cheers` MCP server calls this). |

### `[accounts.<id>.security.acp_capability]` — signed capability (optional)

Only needed when the Backend requires a signed ACP capability delegation
(`acp_security.require_capability`).

| Key                | Type   | Default    | Meaning |
|--------------------|--------|------------|---------|
| `delegation_id`    | string | required   | The delegation id issued by the Backend. |
| `private_key`      | string | —          | Inline private key (prefer the env/file variants). |
| `private_key_env`  | string | —          | Env var holding the private key. |
| `private_key_file` | string | —          | File holding the private key. |
| `algorithm`        | string | `"ed25519"`| Signature algorithm. |
| `kid`              | string | none       | Key id hint. |
| `request_id_prefix`| string | none       | Prefix for signed request ids (traceability). |

Provide exactly one of `private_key` / `private_key_env` / `private_key_file`.

---

## Minimal Codex example

Smallest config to bring a **Codex** bot online (relies on defaults for everything
omitted):

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
command = "codex-acp"                     # must be on PATH; `which codex-acp`
args    = []

[accounts.haowei_codex.policy.workspace]
default_cwd   = "~/.cheers/workspace"
allowed_roots = ["~/.cheers/workspace"]

[accounts.haowei_codex.policy.config]
# Let the Backend set these Codex-advertised options from the UI:
allowed_config_options = ["model", "reasoning_effort"]

[accounts.haowei_codex.policy.permission]
# Route tool prompts to the channel for a human to approve (recommended).
forward_to_backend = true
allowed_modes      = []                   # [] = any mode Codex advertises
```

Start / inspect it:

```bash
cce-acp-connector start  --config ./cheers-codex.toml --name haowei_codex
cce-acp-connector status --name haowei_codex
cce-acp-connector logs   --name haowei_codex --lines 120
cce-acp-connector stop   --name haowei_codex
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Daemon won't start, "unknown field" | typo / stray key (`deny_unknown_fields`) | fix the exact key it names |
| Daemon won't start, "unsupported config version" | `version` ≠ `1` | set `version = 1` |
| Bot never goes **online** | `command` not found, or token missing/unwritten | `which <command>`; write the token to `bot_token_file`; check `logs` |
| Can't set a **config option** from the UI | option not in `allowed_config_options`, or bot offline | add the id to `allowed_config_options`; bring the bot online |
| Can't set a **mode** | mode not in `allowed_modes`, or `backend_may_set_mode = false` | add the mode id (or `[]` for any); enable `backend_may_set_mode` |
| Agent can't read an uploaded file | it tried to HTTP the gateway | agents read attachments via the `cheers` MCP `inbox_open` tool, never HTTP |
| Bot has no Cheers tools | `inject_cheers = false` | set `inject_cheers = true` |
