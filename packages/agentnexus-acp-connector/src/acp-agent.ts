import { JsonRpcError, JsonRpcStdioPeer } from "./acp-jsonrpc.js";
import type {
  AcpInitializeResponse,
  AcpSessionLoadResult,
  AcpSessionStartResult,
  AcpSessionUpdate,
  ContentBlock,
  Logger,
  PermissionMode,
  RemoteConnectorSettings,
  StdioAgentConfig,
} from "./types.js";

type SessionUpdateHandler = (update: AcpSessionUpdate) => void | Promise<void>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickPermissionOption(params: unknown, mode: PermissionMode): string | null {
  if (!isObject(params) || !Array.isArray(params.options)) return null;
  const options = params.options.filter(isObject);
  if (mode === "allow") {
    return String(options.find((o) => String(o.kind).startsWith("allow"))?.optionId ?? "");
  }
  if (mode === "reject") {
    return String(options.find((o) => String(o.kind).startsWith("reject"))?.optionId ?? "");
  }
  return null;
}

export class AcpStdioAgent {
  private peer: JsonRpcStdioPeer;
  private handlers = new Set<SessionUpdateHandler>();
  private initialized = false;
  public initializeResponse: AcpInitializeResponse | null = null;

  constructor(
    private readonly accountId: string,
    private readonly config: StdioAgentConfig,
    private readonly logger: Logger,
  ) {
    this.peer = this.createPeer();
  }

  private createPeer(): JsonRpcStdioPeer {
    return new JsonRpcStdioPeer({
      command: this.config.command,
      args: this.config.args ?? [],
      cwd: this.config.cwd,
      env: this.config.env,
      requestTimeoutMs: this.config.requestTimeoutMs,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
      onStderr: (line) => this.logger.info("[acp:%s stderr] %s", this.accountId, line),
    });
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    this.peer.start();
    this.initializeResponse = await this.peer.request<AcpInitializeResponse>("initialize", {
      protocolVersion: 1,
      clientCapabilities: this.config.clientCapabilities ?? {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: {
        name: "agentnexus-acp-connector",
        title: "AgentNexus ACP Connector",
        version: "0.1.0",
      },
    });
    this.initialized = true;
    this.logger.info(
      "acp account=%s initialized agent=%s protocol=%s loadSession=%s",
      this.accountId,
      this.initializeResponse.agentInfo?.name ?? "unknown",
      this.initializeResponse.protocolVersion ?? "unknown",
      Boolean(this.initializeResponse.agentCapabilities?.loadSession),
    );
  }

  async stop(): Promise<void> {
    await this.peer.stop();
    this.initialized = false;
    this.initializeResponse = null;
  }

  async restart(): Promise<void> {
    await this.peer.stop();
    this.peer = this.createPeer();
    this.initialized = false;
    this.initializeResponse = null;
    await this.start();
  }

  supportsLoadSession(): boolean {
    return Boolean(this.initializeResponse?.agentCapabilities?.loadSession);
  }

  updateRuntimeSettings(settings: RemoteConnectorSettings): string[] {
    const applied: string[] = [];
    if (settings.permissionMode) {
      this.config.permissionMode = settings.permissionMode;
      applied.push("permissionMode");
    }
    if (typeof settings.requestTimeoutMs === "number") {
      this.config.requestTimeoutMs = settings.requestTimeoutMs;
      this.peer.setRequestTimeoutMs(settings.requestTimeoutMs);
      applied.push("requestTimeoutMs");
    }
    if (typeof settings.promptTimeoutMs === "number") {
      this.config.promptTimeoutMs = settings.promptTimeoutMs;
      applied.push("promptTimeoutMs");
    }
    return applied;
  }

  onSessionUpdate(handler: SessionUpdateHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async newSession(): Promise<AcpSessionStartResult> {
    const result = await this.peer.request<AcpSessionStartResult>("session/new", {
      cwd: this.config.cwd,
      mcpServers: this.config.mcpServers ?? [],
    });
    if (!result.sessionId) throw new Error("ACP session/new did not return sessionId");
    return result;
  }

  async loadSession(sessionId: string): Promise<AcpSessionLoadResult> {
    const result = await this.peer.request<AcpSessionLoadResult | null>("session/load", {
      sessionId,
      cwd: this.config.cwd,
      mcpServers: this.config.mcpServers ?? [],
    });
    return result ?? {};
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    const result = await this.peer.request<{ configOptions?: unknown }>("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
    return result.configOptions;
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<{ stopReason?: string }> {
    return this.peer.request<{ stopReason?: string }>("session/prompt", {
      sessionId,
      prompt,
    }, this.config.promptTimeoutMs ?? this.config.requestTimeoutMs ?? 900_000);
  }

  cancel(sessionId: string): void {
    this.peer.notify("session/cancel", { sessionId });
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method !== "session/update" || !isObject(params)) return;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const update = isObject(params.update) ? params.update : {};
    if (!sessionId) return;
    for (const handler of this.handlers) {
      await handler({ sessionId, update });
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      const mode = this.config.permissionMode ?? "reject";
      const optionId = pickPermissionOption(params, mode);
      if (mode === "cancel" || !optionId) {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId } };
    }
    throw new JsonRpcError(-32601, `ACP client method is not supported: ${method}`);
  }
}
