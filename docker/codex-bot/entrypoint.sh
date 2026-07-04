#!/bin/sh
set -eu

CONFIG_PATH="${CHEERS_BOT_CONFIG_PATH:-/app/config/cheers-daemon.toml}"
STATE_DIR="${CHEERS_BOT_STATE_DIR:-/app/state}"
HOME="${HOME:-/app/state/home}"
export HOME

mkdir -p "$(dirname "$CONFIG_PATH")" "$STATE_DIR" "$HOME"

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

function requireEnv(name) {
  const value = env(name).trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function intEnv(name, fallback) {
  const raw = env(name, String(fallback)).trim();
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function csvEnv(name, fallback = "") {
  return env(name, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlKey(value) {
  return tomlString(value);
}

const configPath = env("CHEERS_BOT_CONFIG_PATH", "/app/config/cheers-daemon.toml");
const stateDir = env("CHEERS_BOT_STATE_DIR", "/app/state");
const username = env("CHEERS_BOT_USERNAME", "codex").trim() || "codex";
requireEnv("CHEERS_BOT_TOKEN");
const wsBase = env("CHEERS_WS_BASE", "ws://cheers-gateway:8000").replace(/\/+$/, "");
const controlUrl = env("CHEERS_BOT_CONTROL_URL", `${wsBase}/ws/agent-bridge/control`);
const dataUrl = env("CHEERS_BOT_DATA_URL", `${wsBase}/ws/agent-bridge/data`);
const cwd = path.resolve(env("CHEERS_BOT_WORKSPACE_DIR", "/workspace"));
const promptTimeoutMs = intEnv("CHEERS_BOT_PROMPT_TIMEOUT_MS", 900000);
const requestTimeoutMs = intEnv("CHEERS_BOT_REQUEST_TIMEOUT_MS", 120000);
const permissionTimeoutMs = intEnv("CHEERS_BOT_PERMISSION_TIMEOUT_MS", 900000);
const codexCommand = env("CODEX_ACP_COMMAND", "codex-acp").trim() || "codex-acp";
const codexArgs = csvEnv("CODEX_ACP_ARGS");
const allowedConfigOptions = csvEnv(
  "CHEERS_BOT_ALLOWED_CONFIG_OPTIONS",
  "model,reasoning_effort,approval_policy,sandbox",
);
const envAllow = ["HOME", "PATH", "OPENAI_API_KEY", ...csvEnv("CHEERS_BOT_EXTRA_ENV_ALLOW")];

fs.mkdirSync(cwd, { recursive: true });

const statePath = path.join(stateDir, "cheers-acp-state.json");
const logDir = path.join(stateDir, "logs");
const accountKey = tomlKey(username);

const configToml = `version = 1

[daemon]
name = ${tomlString(username)}
state_path = ${tomlString(statePath)}
log_dir = ${tomlString(logDir)}

[accounts.${accountKey}.bridge]
control_url = ${tomlString(controlUrl)}
data_url = ${tomlString(dataUrl)}
bot_token_env = "CHEERS_BOT_TOKEN"
heartbeat_interval_ms = 25000
ack_timeout_ms = 600000

[accounts.${accountKey}.bridge.reconnect]
base_ms = 500
max_ms = 30000

[accounts.${accountKey}.adapter]
type = "stdio"
command = ${tomlString(codexCommand)}
args = ${tomlArray(codexArgs)}

[accounts.${accountKey}.policy.sessions]
create = true
load = true
cancel = true
terminate = true
request_timeout_ms = ${requestTimeoutMs}

[accounts.${accountKey}.policy.prompt]
allow = true
max_concurrent = 1
max_prompt_bytes = 200000
max_duration_ms = ${promptTimeoutMs}
allow_attachments = true
allow_images = true
allow_local_file_refs = false

[accounts.${accountKey}.policy.workspace]
default_cwd = ${tomlString(cwd)}
allowed_roots = ${tomlArray([cwd])}
backend_may_set_cwd = true

[accounts.${accountKey}.policy.env]
inherit = false
allow = ${tomlArray([...new Set(envAllow)])}

[accounts.${accountKey}.policy.config]
backend_may_set_model = false
backend_may_set_native_options = false
allowed_config_options = ${tomlArray(allowedConfigOptions)}

[accounts.${accountKey}.policy.permission]
forward_to_backend = true
wait_timeout_ms = ${permissionTimeoutMs}
on_timeout = "cancel"
auto_allow = false
backend_may_set_mode = true
allowed_modes = []

[accounts.${accountKey}.policy.send]
allow = true
max_text_bytes = 200000
max_files = 10

[accounts.${accountKey}.policy.file_upload]
allow = false
max_bytes = 26214400
allowed_content_types = []

[accounts.${accountKey}.policy.trace]
allow = true
max_message_bytes = 32000

[accounts.${accountKey}.policy.session_update]
allow = true
include_metadata = true

[accounts.${accountKey}.policy.mcp]
inject_cheers = true
backend_may_inject_extra_servers = false
allowed_servers = ["cheers"]

[accounts.${accountKey}.policy.loopback]
request_timeout_ms = 600000
`;

fs.writeFileSync(configPath, configToml, { mode: 0o600 });
console.info(
  "generated Codex ACP connector config account=%s control=%s data=%s cwd=%s command=%s openai_api_key_set=%s",
  username,
  controlUrl,
  dataUrl,
  cwd,
  codexCommand,
  env("OPENAI_API_KEY").trim() ? "true" : "false",
);
NODE

exec cce-acp-connector run --config "$CONFIG_PATH"
