import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AccountConfig, ConnectorConfig } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expandEnvValue(value: string): string {
  if (value.startsWith("$") && /^[A-Z0-9_]+$/i.test(value.slice(1))) {
    return process.env[value.slice(1)] ?? "";
  }
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => process.env[name] ?? "");
}

function expandEnvMap(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = expandEnvValue(String(value));
  }
  return out;
}

function normalizeAccount(id: string, raw: unknown): AccountConfig {
  if (!isObject(raw)) throw new Error(`accounts.${id} must be an object`);
  const agent = raw.agent;
  if (!isObject(agent)) throw new Error(`accounts.${id}.agent must be an object`);
  if (agent.transport !== "stdio") {
    throw new Error(`accounts.${id}.agent.transport must be "stdio"`);
  }
  if (typeof agent.command !== "string" || !agent.command.trim()) {
    throw new Error(`accounts.${id}.agent.command is required`);
  }
  for (const key of ["botToken", "controlUrl", "dataUrl"] as const) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) {
      throw new Error(`accounts.${id}.${key} is required`);
    }
  }
  return {
    botToken: String(raw.botToken),
    controlUrl: String(raw.controlUrl),
    dataUrl: String(raw.dataUrl),
    advanced: isObject(raw.advanced) ? raw.advanced : undefined,
    agent: {
      transport: "stdio",
      command: String(agent.command),
      args: Array.isArray(agent.args) ? agent.args.map(String) : [],
      cwd: typeof agent.cwd === "string" ? agent.cwd : undefined,
      env: expandEnvMap(isObject(agent.env) ? Object.fromEntries(
        Object.entries(agent.env).map(([k, v]) => [k, String(v)]),
      ) : undefined),
      requestTimeoutMs: typeof agent.requestTimeoutMs === "number" ? agent.requestTimeoutMs : undefined,
      permissionMode: agent.permissionMode === "allow" || agent.permissionMode === "cancel"
        ? agent.permissionMode
        : "reject",
      mcpServers: Array.isArray(agent.mcpServers) ? agent.mcpServers : [],
      clientCapabilities: isObject(agent.clientCapabilities) ? agent.clientCapabilities : undefined,
    },
  };
}

export async function loadConfig(configPath: string): Promise<ConnectorConfig> {
  const abs = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(abs, "utf8")) as unknown;
  if (!isObject(parsed)) throw new Error("config must be a JSON object");
  if (!isObject(parsed.accounts)) throw new Error("config.accounts is required");
  const accounts: Record<string, AccountConfig> = {};
  for (const [id, raw] of Object.entries(parsed.accounts)) {
    accounts[id] = normalizeAccount(id, raw);
  }
  if (Object.keys(accounts).length === 0) {
    throw new Error("config.accounts must include at least one account");
  }
  return {
    accounts,
    statePath: typeof parsed.statePath === "string"
      ? path.resolve(path.dirname(abs), parsed.statePath)
      : path.join(path.dirname(abs), ".agentnexus-acp-state.json"),
  };
}
