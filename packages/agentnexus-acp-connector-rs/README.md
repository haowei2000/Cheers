# agentnexus-acp-connector Rust daemon

Rust local daemon for the AgentNexus ACP connector.

This binary owns daemon lifecycle commands: `start`, `stop`, `restart`,
`status`, and `logs`. Its `run` command validates the local TOML security
config, starts the Rust BridgeRuntime, and connects Agent Bridge to a local ACP
agent through the configured adapter.

The Agent Bridge WebSocket protocol helpers formerly published as the
standalone `@haowei0520/bridge-client` package now live in this Rust crate under
`src/bridge.rs`.

## Config

The local config is TOML because it is a human-audited security policy. It
defines what the remote Agent Bridge Backend may cause this machine to do.
Protocol frames and state files remain JSON.

`adapter` only describes how to start the local ACP runtime. Workspace, env,
filesystem, terminal, permission, resource, file, and message boundaries belong
under `policy.*`.

```toml
version = 1

[daemon]
state_path = "state.json"
log_dir = "logs"

[accounts.haowei_claude.bridge]
control_url = "wss://agentnexus.example.com/ws/agent-bridge/control"
data_url = "wss://agentnexus.example.com/ws/agent-bridge/data"
bot_token_env = "AGENTNEXUS_CLAUDE_BOT_TOKEN"
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
default_cwd = "~/.agentnexus/workspace"
allowed_roots = ["~/.agentnexus/workspace"]
backend_may_set_cwd = true

[accounts.haowei_claude.policy.env]
inherit = false
allow = ["HOME", "PATH"]

[accounts.haowei_claude.policy.filesystem.read]
allow = false
allowed_roots = []

[accounts.haowei_claude.policy.filesystem.write]
allow = false
allowed_roots = []

[accounts.haowei_claude.policy.terminal]
allow = false

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
inject_agentnexus = true
backend_may_inject_extra_servers = false
allowed_servers = ["agentnexus"]

[accounts.haowei_claude.policy.loopback]
allowed_resources = ["channel.messages.context", "channel.files.read"]
deny_resources = ["fs.write"]
request_timeout_ms = 600000

[accounts.haowei_claude.security.acp_capability]
delegation_id = "capability-id-from-backend"
private_key_env = "AGENTNEXUS_ACP_CAPABILITY_KEY"
algorithm = "ed25519"
kid = "local-main"
request_id_prefix = "local-main"
```

Do not put `permissionMode = "ask"` in local config. ACP permission requests are
forwarded to the Backend as Agent Bridge `permission_request` frames, and the
Backend answers with `permission_resolution`. The local daemon only controls
whether forwarding is allowed and how long it waits.

```bash
cd packages/agentnexus-acp-connector-rs
cargo run -- start --config /path/to/agentnexus-daemon.toml --name haowei-claude
cargo run -- status --name haowei-claude
cargo run -- logs --name haowei-claude --lines 120
cargo run -- stop --name haowei-claude
```

Set `AGENTNEXUS_ACP_HOME=/path/to/state` or pass `--home /path/to/state` to
change the daemon metadata and log directory.
