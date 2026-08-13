#!/usr/bin/env node

/**
 * ACP stdio probe for the direct HTTP MCP OAuth spike.
 *
 * The probe intentionally gives the Agent only an HTTP MCP URL and an empty
 * header list. Supplying a pre-minted Bearer token would test static headers,
 * not the Agent's OAuth discovery and refresh implementation.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const SECRET_KEY = /(authorization|token|secret|credential|code|verifier)/i;
const OAUTH_URL = /https?:\/\/[^\s"'<>]+/g;

/** Replace credentials in strings and structured evidence before it reaches disk. */
export function redact(value, key = "") {
  if (key === "code" && typeof value === "number") return value;
  if (SECRET_KEY.test(key) && value !== undefined && value !== null) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/agbi_[A-Za-z0-9_-]+/g, "agbi_[REDACTED]")
    .replace(/(^|[?&\s])((?:code|access_token|refresh_token|client_secret|code_verifier|state)=)[^&\s]+/gi, "$1$2[REDACTED]")
    .replace(/(\"(?:access_token|refresh_token|client_secret|credential)\"\s*:\s*\")[^\"]+/gi, "$1[REDACTED]");
}

/** Collect candidate authorization URLs without persisting sensitive query values. */
export function oauthUrls(text) {
  const urls = text.match(OAUTH_URL) ?? [];
  return [...new Set(urls.map((url) => redact(url)))].filter((url) =>
    /oauth|authorize|login|consent/i.test(url),
  );
}

/** Map probe evidence to a stable matrix failure category. */
export function classifyFailure(evidence) {
  const detail = `${evidence.failure ?? ""} ${JSON.stringify(evidence.session_updates ?? [])} ${JSON.stringify(evidence.logs ?? [])}`.toLowerCase();
  if (!evidence.http_capability && /http mcp capability/.test(detail)) return "missing_http_capability";
  if (/cimd|client id metadata|client metadata/.test(detail) && /https|public|private|localhost|ssrf/.test(detail)) {
    return "cimd_incompatible";
  }
  if (/not logged in|authentication required|authenticate|api key|model.*auth/.test(detail)) {
    return "agent_model_auth_unavailable";
  }
  if (/permission denied|eacces|sqlite|enoent|command not found|spawn .* error/.test(detail)) {
    return "harness_environment_failure";
  }
  if (evidence.http_capability && !evidence.session_created) return "oauth_discovery_not_started";
  if (evidence.session_created && (evidence.oauth_urls?.length ?? 0) === 0) return "no_user_authorization_surface";
  return "unclassified_agent_failure";
}

/** Resolve the registry-pinned command used by the spike. */
export function agentCommand(agentId) {
  const profiles = {
    codex: ["npx", "-y", "@agentclientprotocol/codex-acp@1.2.0"],
    claude: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.66.0"],
    gemini: ["npx", "-y", "@google/gemini-cli@0.55.1", "--acp"],
    opencode: ["npx", "-y", "opencode-ai@1.18.18", "acp"],
  };
  const command = profiles[agentId];
  if (!command) throw new Error(`unsupported Agent: ${agentId}`);
  return command;
}

/** Read and validate an optional JSON argv override. */
export function parseCommand(agentId, raw) {
  if (!raw) return agentCommand(agentId);
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("CHEERS_SPIKE_AGENT_COMMAND_JSON must be a non-empty string array");
  }
  return value;
}

class AcpPeer {
  /** Bind JSON-line ACP framing and redacted stderr capture to one child. */
  constructor(child, evidence, timeoutMs) {
    this.child = child;
    this.evidence = evidence;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stdout = createInterface({ input: child.stdout });
    this.stdout.on("line", (line) => this.onLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.recordText("stderr", chunk));
    child.once("error", (error) => {
      this.recordText("process-error", error.message);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  /** Append bounded, redacted diagnostic text to the evidence record. */
  recordText(source, text) {
    const clean = redact(String(text)).trim();
    if (!clean) return;
    this.evidence.oauth_urls.push(...oauthUrls(String(text)));
    this.evidence.logs.push({ source, text: clean.slice(0, 8_192) });
  }

  /** Write one JSON-RPC message using ACP stdio line framing. */
  send(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /** Send a request and correlate its response with a bounded timeout. */
  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
  }

  /** Route one decoded Agent message to a pending request or client handler. */
  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.recordText("stdout-non-json", line);
      return;
    }
    this.evidence.oauth_urls.push(...oauthUrls(JSON.stringify(message)));
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${JSON.stringify(redact(message.error))}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleClientRequest(message);
      return;
    }
    if (message.method === "session/update") {
      const update = redact(message.params?.update ?? {});
      this.evidence.session_updates.push(update);
      if (this.evidence.session_updates.length > 500) this.evidence.session_updates.shift();
    }
  }

  /** Serve only the client methods that the spike explicitly advertises. */
  handleClientRequest(message) {
    if (message.method === "session/request_permission") {
      const options = message.params?.options ?? [];
      const selected =
        options.find((option) => option.kind === "allow_always") ??
        options.find((option) => option.kind === "allow_once");
      if (process.env.CHEERS_SPIKE_AUTO_APPROVE === "1" && selected?.optionId) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { outcome: { outcome: "selected", optionId: selected.optionId } },
        });
        return;
      }
      this.send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    if (message.method === "elicitation/create") {
      const params = message.params ?? {};
      this.evidence.elicitations.push(redact(params));
      if (params.mode !== "url") {
        this.send({ jsonrpc: "2.0", id: message.id, result: { action: "cancel" } });
        return;
      }
      if (typeof params.url === "string") {
        this.evidence.oauth_urls.push(...oauthUrls(params.url));
        // stderr is outside the ACP stdout framing and lets the operator review
        // the host before deciding whether to open the URL.
        process.stderr.write(`ACP URL elicitation (${params.message ?? "authorization requested"}): ${redact(params.url)}\n`);
      }
      const action = process.env.CHEERS_SPIKE_ACCEPT_ELICITATION_URL === "1" ? "accept" : "cancel";
      this.send({ jsonrpc: "2.0", id: message.id, result: { action } });
      return;
    }
    this.send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Spike client does not implement ${message.method}` },
    });
  }

  /** Reject pending requests and close the ACP stdout reader. */
  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ACP process closed"));
    }
    this.pending.clear();
    this.stdout.close();
  }
}

/** Read the stable-v1 HTTP MCP capability without assuming adapter extensions. */
function supportsHttp(capabilities) {
  return capabilities?.mcpCapabilities?.http === true ||
    capabilities?.session?.mcp?.http != null ||
    capabilities?.sessionCapabilities?.mcpCapabilities?.http === true;
}

/** Await a non-negative delay without blocking the Node event loop. */
async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Execute one Agent process and produce a redacted JSON evidence record. */
export async function runProbe(env = process.env) {
  const agentId = env.CHEERS_SPIKE_AGENT_ID;
  if (!agentId) throw new Error("CHEERS_SPIKE_AGENT_ID is required");
  const mcpUrl = env.CHEERS_SPIKE_MCP_URL;
  const phase = env.CHEERS_SPIKE_PHASE ?? "capability";
  if (phase !== "capability" && !mcpUrl) throw new Error("CHEERS_SPIKE_MCP_URL is required");
  const command = parseCommand(agentId, env.CHEERS_SPIKE_AGENT_COMMAND_JSON);
  const cwd = env.CHEERS_SPIKE_CWD ?? process.cwd();
  const timeoutMs = Number(env.CHEERS_SPIKE_TIMEOUT_MS ?? "180000");
  const evidence = {
    schema_version: 1,
    agent: agentId,
    command,
    phase,
    started_at: new Date().toISOString(),
    http_capability: false,
    session_created: false,
    prompts: [],
    oauth_urls: [],
    elicitations: [],
    session_updates: [],
    logs: [],
    result: "failed",
    failure: null,
    failure_class: null,
  };
  const childEnv = { ...process.env };
  // Harness-only secrets must never be inherited accidentally. A client-
  // credentials case may expose them only through the Agent's documented,
  // explicit credential interface encoded in CHEERS_SPIKE_AGENT_ENV_JSON.
  for (const key of Object.keys(childEnv)) {
    if (
      key.startsWith("CHEERS_SPIKE_") ||
      key.startsWith("JWT_") ||
      key.startsWith("S3_") ||
      [
        "ADMIN_USERNAME",
        "ADMIN_PASSWORD",
        "DATABASE_URL",
        "MCP_PUBLIC_URL",
        "CORS_ALLOWED_ORIGINS",
        "PORT",
      ].includes(key)
    ) delete childEnv[key];
  }
  if (env.CHEERS_SPIKE_AGENT_ENV_JSON) {
    const agentEnv = JSON.parse(env.CHEERS_SPIKE_AGENT_ENV_JSON);
    if (!agentEnv || Array.isArray(agentEnv) || typeof agentEnv !== "object") {
      throw new Error("CHEERS_SPIKE_AGENT_ENV_JSON must be a JSON object");
    }
    for (const [key, value] of Object.entries(agentEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") {
        throw new Error("CHEERS_SPIKE_AGENT_ENV_JSON must map environment names to strings");
      }
      childEnv[key] = value;
    }
  }
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peer = new AcpPeer(child, evidence, timeoutMs);
  try {
    const initialize = await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { url: {} },
      },
      clientInfo: { name: "cheers-mcp-oauth-spike", title: "Cheers MCP OAuth Spike", version: "0.1.0" },
    });
    evidence.initialize = redact(initialize);
    evidence.http_capability = supportsHttp(initialize?.agentCapabilities);
    if (!evidence.http_capability) throw new Error("Agent does not advertise HTTP MCP capability");
    if (phase === "capability") {
      evidence.result = "passed";
      return evidence;
    }
    const session = await peer.request("session/new", {
      cwd,
      additionalDirectories: [],
      mcpServers: [{ type: "http", name: "cheers", url: mcpUrl, headers: [] }],
    });
    evidence.session = redact(session);
    evidence.session_created = typeof session?.sessionId === "string";
    if (!evidence.session_created) throw new Error("session/new did not return sessionId");
    if (phase === "session") {
      evidence.result = "passed";
      return evidence;
    }
    const promptText = env.CHEERS_SPIKE_PROMPT;
    if (!promptText) throw new Error("CHEERS_SPIKE_PROMPT is required for full phase");
    const promptOnce = async (label) => {
      const result = await peer.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: promptText }],
      }, Number(env.CHEERS_SPIKE_PROMPT_TIMEOUT_MS ?? "600000"));
      evidence.prompts.push({ label, result: redact(result), completed_at: new Date().toISOString() });
    };
    await promptOnce("initial");
    const holdMs = Number(env.CHEERS_SPIKE_HOLD_MS ?? "0");
    if (holdMs > 0) {
      await sleep(holdMs);
      await promptOnce("after_token_expiry");
    }
    evidence.result = "passed";
    return evidence;
  } catch (error) {
    evidence.failure = redact(error instanceof Error ? error.message : String(error));
    return evidence;
  } finally {
    evidence.oauth_urls = [...new Set(evidence.oauth_urls)];
    evidence.finished_at = new Date().toISOString();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(2_000).then(() => child.kill("SIGKILL")),
    ]);
    peer.close();
    if (evidence.result !== "passed") evidence.failure_class = classifyFailure(evidence);
  }
}

/** Run the CLI probe, optionally persist evidence, and expose pass/fail by exit. */
async function main() {
  const evidence = await runProbe();
  const output = `${JSON.stringify(redact(evidence), null, 2)}\n`;
  if (process.env.CHEERS_SPIKE_RESULT_FILE) {
    await writeFile(process.env.CHEERS_SPIKE_RESULT_FILE, output, { mode: 0o600 });
  }
  process.stdout.write(output);
  process.exitCode = evidence.result === "passed" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(redact(error instanceof Error ? error.stack : String(error)));
    process.exitCode = 2;
  });
}
