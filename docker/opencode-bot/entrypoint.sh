#!/bin/sh
set -eu

CONFIG_PATH="${OPENCODE_BOT_CONFIG_PATH:-/app/config/agentnexus-acp.json}"
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

const configPath = env("OPENCODE_BOT_CONFIG_PATH", "/app/config/agentnexus-acp.json");
const stateDir = env("OPENCODE_STATE_DIR", "/app/state");
const username = env("OPENCODE_BOT_USERNAME", "opencode").trim() || "opencode";
const botToken = requireEnv("OPENCODE_BOT_TOKEN");
const apiKey = requireEnv("OPENCODE_OPENAI_API_KEY");
const wsBase = env("AGENTNEXUS_WS_BASE", "ws://backend:8000").replace(/\/+$/, "");
const controlUrl = env("OPENCODE_BOT_CONTROL_URL", `${wsBase}/ws/agent-bridge/control`);
const dataUrl = env("OPENCODE_BOT_DATA_URL", `${wsBase}/ws/agent-bridge/data`);
const cwd = path.resolve(env("OPENCODE_WORKSPACE_DIR", "/workspace"));
const promptTimeoutMs = intEnv("OPENCODE_PROMPT_TIMEOUT_MS", 660000);
const requestTimeoutMsRaw = env("OPENCODE_REQUEST_TIMEOUT_MS", "").trim();
const legacyPermissionMode = env("OPENCODE_PERMISSION_MODE", "").trim();
const agentnexusApprovalMode = (
  env("OPENCODE_AGENTNEXUS_APPROVAL_MODE", "").trim() ||
  legacyPermissionMode ||
  "ask"
);
const agentNativePermissionMode = env("OPENCODE_NATIVE_PERMISSION_MODE", "ask").trim() || "ask";
const model = env("OPENCODE_MODEL", "").trim();
const baseUrl = env("OPENCODE_OPENAI_BASE_URL", "https://api.deepseek.com").trim();
const provider = env("OPENCODE_PROVIDER", "deepseek").trim() || "deepseek";
const opencodeCommand = env("OPENCODE_ACP_COMMAND", "opencode").trim() || "opencode";
const opencodeModelName = opencodeModel(provider, model);

if (!["ask", "reject", "allow", "cancel"].includes(agentnexusApprovalMode)) {
  throw new Error("OPENCODE_AGENTNEXUS_APPROVAL_MODE must be ask, reject, allow, or cancel");
}
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

const agent = {
  transport: "stdio",
  command: opencodeCommand,
  args: ["acp", "--cwd", cwd],
  cwd,
  promptTimeoutMs,
  agentnexusApprovalMode,
  agentNativePermissionMode,
  env: {
    OPENCODE_OPENAI_API_KEY: "$OPENCODE_OPENAI_API_KEY",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
  },
};

if (requestTimeoutMsRaw) {
  agent.requestTimeoutMs = intEnv("OPENCODE_REQUEST_TIMEOUT_MS", 300000);
}

const config = {
  accounts: {
    [username]: {
      botToken,
      controlUrl,
      dataUrl,
      agent,
    },
  },
  statePath: path.join(stateDir, "agentnexus-acp-state.json"),
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.info(
  "generated OpenCode ACP connector config account=%s control=%s data=%s cwd=%s model=%s approval_mode=%s native_permission=%s base_url=%s api_key_set=%s image_support=true embedded_context=true",
  username,
  controlUrl,
  dataUrl,
  cwd,
  opencodeModelName,
  agentnexusApprovalMode,
  agentNativePermissionMode,
  baseUrl,
  apiKey ? "true" : "false",
);
NODE

exec agentnexus-acp-connector run --config "$CONFIG_PATH"
