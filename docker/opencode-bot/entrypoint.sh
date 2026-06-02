#!/bin/sh
set -eu

CONFIG_PATH="${OPENCODE_BOT_CONFIG_PATH:-/app/config/agentnexus-daemon.toml}"
STATE_DIR="${OPENCODE_STATE_DIR:-/app/state}"
OPENCODE_HOME="${OPENCODE_HOME:-/app/state/opencode}"
export OPENCODE_HOME

mkdir -p "$(dirname "$CONFIG_PATH")" "$STATE_DIR" "$OPENCODE_HOME"

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

function requireEnv(name) {
  const value = env(name).trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
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

function opencodeModel(provider, model) {
  if (!model) return provider ? `${provider}/deepseek-chat` : "deepseek/deepseek-chat";
  return model.includes("/") ? model : `${provider}/${model}`;
}

const configPath = env("OPENCODE_BOT_CONFIG_PATH", "/app/config/agentnexus-daemon.toml");
const stateDir = env("OPENCODE_STATE_DIR", "/app/state");
const username = env("OPENCODE_BOT_USERNAME", "opencode").trim() || "opencode";
const botToken = requireEnv("OPENCODE_BOT_TOKEN");
const apiKey = requireEnv("OPENCODE_OPENAI_API_KEY");
const wsBase = env("AGENTNEXUS_WS_BASE", "ws://gateway:8000").replace(/\/+$/, "");
const controlUrl = env("OPENCODE_BOT_CONTROL_URL", `${wsBase}/ws/agent-bridge/control`);
const dataUrl = env("OPENCODE_BOT_DATA_URL", `${wsBase}/ws/agent-bridge/data`);
const cwd = path.resolve(env("OPENCODE_WORKSPACE_DIR", "/workspace"));
const promptTimeoutMs = intEnv("OPENCODE_PROMPT_TIMEOUT_MS", 660000);
const requestTimeoutMs = intEnv("OPENCODE_REQUEST_TIMEOUT_MS", 300000);
const agentNativePermissionMode = env("OPENCODE_NATIVE_PERMISSION_MODE", "ask").trim() || "ask";
const model = env("OPENCODE_MODEL", "").trim();
const baseUrl = env("OPENCODE_OPENAI_BASE_URL", "https://api.deepseek.com").trim();
const provider = env("OPENCODE_PROVIDER", "deepseek").trim() || "deepseek";
const opencodeCommand = env("OPENCODE_ACP_COMMAND", "opencode").trim() || "opencode";
const opencodeModelName = opencodeModel(provider, model);

if (!["ask", "allow", "deny", "reject"].includes(agentNativePermissionMode)) {
  throw new Error("OPENCODE_NATIVE_PERMISSION_MODE must be ask, allow, deny, or reject");
}

fs.mkdirSync(cwd, { recursive: true });

const opencodePermission = agentNativePermissionMode === "allow"
  ? { edit: "allow", bash: "allow" }
  : agentNativePermissionMode === "ask"
    ? { edit: "ask", bash: "ask" }
    : { edit: "deny", bash: "deny" };

const opencodeConfig = {
  "$schema": "https://opencode.ai/config.json",
  autoupdate: false,
  model: opencodeModelName,
  provider: {
    [provider]: {
      options: {
        apiKey: "{env:OPENCODE_OPENAI_API_KEY}",
        baseURL: baseUrl,
      },
    },
  },
  permission: opencodePermission,
};

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlKey(value) {
  return tomlString(value);
}

function tomlInlineTable(record) {
  return `{ ${Object.entries(record)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
}

const statePath = path.join(stateDir, "agentnexus-acp-state.json");
const logDir = path.join(stateDir, "logs");
const accountKey = tomlKey(username);
const envSet = {
  OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
};

const configToml = `version = 1

[daemon]
state_path = ${tomlString(statePath)}
log_dir = ${tomlString(logDir)}

[accounts.${accountKey}.bridge]
control_url = ${tomlString(controlUrl)}
data_url = ${tomlString(dataUrl)}
bot_token_env = "OPENCODE_BOT_TOKEN"
heartbeat_interval_ms = 25000
ack_timeout_ms = 600000

[accounts.${accountKey}.bridge.reconnect]
base_ms = 500
max_ms = 30000

[accounts.${accountKey}.adapter]
type = "stdio"
command = ${tomlString(opencodeCommand)}
args = ${tomlArray(["acp", "--cwd", cwd])}

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
backend_may_set_cwd = false

[accounts.${accountKey}.policy.filesystem.read]
allow = true
allowed_roots = ${tomlArray([cwd])}

[accounts.${accountKey}.policy.filesystem.write]
allow = true
allowed_roots = ${tomlArray([cwd])}

[accounts.${accountKey}.policy.terminal]
allow = true

[accounts.${accountKey}.policy.env]
inherit = false
allow = ${tomlArray(["PATH", "HOME", "OPENCODE_HOME", "OPENCODE_OPENAI_API_KEY"])}
set = ${tomlInlineTable(envSet)}

[accounts.${accountKey}.policy.config]
backend_may_set_model = false
backend_may_set_native_options = false
allowed_config_options = []

[accounts.${accountKey}.policy.permission]
forward_to_backend = true
wait_timeout_ms = 900000
on_timeout = "cancel"

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
inject_agentnexus = true
backend_may_inject_extra_servers = false
allowed_servers = ["agentnexus"]

[accounts.${accountKey}.policy.loopback]
allowed_resources = ["channel.messages.context", "channel.files.read"]
deny_resources = ["fs.write"]
request_timeout_ms = 600000
`;

fs.writeFileSync(configPath, configToml, { mode: 0o600 });
console.info(
  "generated OpenCode Rust ACP connector config account=%s control=%s data=%s cwd=%s model=%s native_permission=%s base_url=%s api_key_set=%s image_support=true embedded_context=true",
  username,
  controlUrl,
  dataUrl,
  cwd,
  opencodeModelName,
  agentNativePermissionMode,
  baseUrl,
  apiKey ? "true" : "false",
);
NODE

exec agentnexus-acp-connector run --config "$CONFIG_PATH"
