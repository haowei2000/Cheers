import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AccountConfig, ConnectorConfig } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePermissionMode(value: unknown, fallback: "ask" | "reject" | "allow" | "cancel"): "ask" | "reject" | "allow" | "cancel" {
  return value === "ask" || value === "allow" || value === "cancel" || value === "reject"
    ? value
    : fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandEnvValue(
  value: string,
  options: { missing?: "empty" | "throw"; pwdFallback?: boolean } = {},
): string {
  const missing = options.missing ?? "empty";
  const lookup = (name: string): string => {
    const found = process.env[name];
    if (found !== undefined) return found;
    if (options.pwdFallback && name === "PWD") return process.cwd();
    if (missing === "throw") {
      throw new Error(`environment variable ${name} is not set`);
    }
    return "";
  };
  if (value.startsWith("$") && /^[A-Z0-9_]+$/i.test(value.slice(1))) {
    return lookup(value.slice(1));
  }
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => lookup(name));
}

function expandEnvMap(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = expandEnvValue(String(value));
  }
  return out;
}

function expandPathValue(value: string, baseDir: string): string {
  let expanded = expandEnvValue(value, { missing: "throw", pwdFallback: true });
  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

async function normalizeCwd(id: string, cwd: unknown, baseDir: string): Promise<string | undefined> {
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  let resolved: string;
  try {
    resolved = expandPathValue(cwd.trim(), baseDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`accounts.${id}.agent.cwd is invalid: ${detail}`);
  }
  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`accounts.${id}.agent.cwd does not exist: ${resolved}`);
    }
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`accounts.${id}.agent.cwd is not a directory: ${resolved}`);
  }
  return resolved;
}

async function normalizeAccount(id: string, raw: unknown, baseDir: string): Promise<AccountConfig> {
  if (!isObject(raw)) throw new Error(`accounts.${id} must be an object`);
  const agent = raw.agent;
  if (!isObject(agent)) throw new Error(`accounts.${id}.agent must be an object`);
  if (agent.transport !== "stdio") {
    throw new Error(`accounts.${id}.agent.transport must be "stdio"`);
  }
  if (typeof agent.command !== "string" || !agent.command.trim()) {
    throw new Error(`accounts.${id}.agent.command is required`);
  }
  const agentnexusApprovalMode = normalizePermissionMode(
    agent.agentnexusApprovalMode ?? agent.permissionMode,
    "ask",
  );
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
      model: typeof agent.model === "string" && agent.model.trim() ? agent.model.trim() : undefined,
      cwd: await normalizeCwd(id, agent.cwd, baseDir),
      env: expandEnvMap(isObject(agent.env) ? Object.fromEntries(
        Object.entries(agent.env).map(([k, v]) => [k, String(v)]),
      ) : undefined),
      requestTimeoutMs: typeof agent.requestTimeoutMs === "number" ? agent.requestTimeoutMs : undefined,
      promptTimeoutMs: typeof agent.promptTimeoutMs === "number" ? agent.promptTimeoutMs : undefined,
      agentnexusApprovalMode,
      agentNativePermissionMode: normalizeOptionalString(agent.agentNativePermissionMode),
      mcpServers: Array.isArray(agent.mcpServers) ? agent.mcpServers : [],
      clientCapabilities: isObject(agent.clientCapabilities) ? agent.clientCapabilities : undefined,
    },
  };
}

export async function loadConfig(configPath: string): Promise<ConnectorConfig> {
  const abs = path.resolve(configPath);
  const baseDir = path.dirname(abs);
  const parsed = JSON.parse(await readFile(abs, "utf8")) as unknown;
  if (!isObject(parsed)) throw new Error("config must be a JSON object");
  if (!isObject(parsed.accounts)) throw new Error("config.accounts is required");
  const accounts: Record<string, AccountConfig> = {};
  for (const [id, raw] of Object.entries(parsed.accounts)) {
    accounts[id] = await normalizeAccount(id, raw, baseDir);
  }
  if (Object.keys(accounts).length === 0) {
    throw new Error("config.accounts must include at least one account");
  }
  return {
    accounts,
    statePath: typeof parsed.statePath === "string"
      ? path.resolve(baseDir, parsed.statePath)
      : path.join(baseDir, ".agentnexus-acp-state.json"),
  };
}
