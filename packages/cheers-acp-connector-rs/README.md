# cce-acp-connector Rust daemon

Rust local daemon for the Cheers ACP connector.

This binary owns daemon lifecycle commands: `start`, `stop`, `restart`,
`status`, and `logs`. Its `run` command validates the local TOML security
config, starts the Rust BridgeRuntime, and connects Agent Bridge to a local ACP
agent through the configured adapter.

The Agent Bridge WebSocket protocol helpers formerly published as the
standalone `@haowei0520/bridge-client` package now live in this Rust crate under
`src/bridge.rs`.

## Config

> 📖 **Full field-by-field reference:**
> [docs/arch/CONNECTOR_TOML_CONFIG.md](../../docs/arch/CONNECTOR_TOML_CONFIG.md)
> ([中文](../../docs/arch/CONNECTOR_TOML_CONFIG.zh-CN.md)) — every key, type,
> default, and a Codex example. The block below is a quick annotated sample.

The local config is TOML because it is a human-audited security policy. It
defines what the remote Agent Bridge Backend may cause this machine to do.
Protocol frames and state files remain JSON.

`adapter` only describes how to start the local ACP runtime. Workspace and env
policy shape the local process launch. Local filesystem and terminal access
belong to that ACP agent process and are bounded by the OS user, cwd/env,
container, or sandbox. The connector does not proxy ACP client-side filesystem
or terminal methods. Channel resource authorization belongs to the Backend.

```toml
version = 1

[daemon]
state_path = "state.json"
log_dir = "logs"

[accounts.haowei_claude.bridge]
control_url = "wss://cheers.example.com/ws/agent-bridge/control"
data_url = "wss://cheers.example.com/ws/agent-bridge/data"
bot_token_env = "CHEERS_CLAUDE_BOT_TOKEN"
heartbeat_interval_ms = 25000
ack_timeout_ms = 600000

[accounts.haowei_claude.bridge.reconnect]
base_ms = 500
max_ms = 30000

[accounts.haowei_claude.adapter]
type = "stdio"
command = "/opt/homebrew/bin/claude-agent-acp"
args = []

[accounts.haowei_claude.policy.sessions]
create = true
load = true
cancel = true
terminate = true
request_timeout_ms = 120000

[accounts.haowei_claude.policy.prompt]
allow = true
max_concurrent = 1
max_prompt_bytes = 200000
max_duration_ms = 900000
allow_attachments = true
allow_images = true
allow_local_file_refs = false

[accounts.haowei_claude.policy.workspace]
default_cwd = "~/.cheers/workspace"
allowed_roots = ["~/.cheers/workspace"]
backend_may_set_cwd = true

[accounts.haowei_claude.policy.env]
inherit = false
allow = ["HOME", "PATH"]

[accounts.haowei_claude.policy.config]
backend_may_set_model = false
backend_may_set_native_options = false
allowed_config_options = []

[accounts.haowei_claude.policy.permission]
forward_to_backend = true
wait_timeout_ms = 900000
on_timeout = "cancel"

[accounts.haowei_claude.policy.send]
allow = true
max_text_bytes = 200000
max_files = 10

[accounts.haowei_claude.policy.file_upload]
allow = false
max_bytes = 26214400
allowed_content_types = []

[accounts.haowei_claude.policy.trace]
allow = true
max_message_bytes = 32000

[accounts.haowei_claude.policy.session_update]
allow = true
include_metadata = true

[accounts.haowei_claude.policy.mcp]
inject_cheers = true
backend_may_inject_extra_servers = false
allowed_servers = ["cheers"]

[accounts.haowei_claude.policy.loopback]
request_timeout_ms = 600000

[accounts.haowei_claude.security.acp_capability]
delegation_id = "capability-id-from-backend"
private_key_env = "CHEERS_ACP_CAPABILITY_KEY"
algorithm = "ed25519"
kid = "local-main"
request_id_prefix = "local-main"
```

The connector advertises ACP `clientCapabilities.fs` and
`clientCapabilities.terminal` as `false`. If the local agent needs to read or
write files or run commands, grant those abilities to the agent process through
its runtime environment rather than through connector resource policy.

Do not put `permissionMode = "ask"` in local config. ACP permission requests are
forwarded to the Backend as Agent Bridge `permission_request` frames, and the
Backend answers with `permission_resolution`. The local daemon only controls
whether forwarding is allowed and how long it waits.

```bash
cd packages/cheers-acp-connector-rs
cargo run --bin cce-acp-connector -- start --config /path/to/cheers-daemon.toml --name haowei-claude
cargo run --bin cce-acp-connector -- status --name haowei-claude
cargo run --bin cce-acp-connector -- logs --name haowei-claude --lines 120
cargo run --bin cce-acp-connector -- stop --name haowei-claude
```

Set `CHEERS_ACP_HOME=/path/to/state` or pass `--home /path/to/state` to
change the daemon metadata and log directory.
