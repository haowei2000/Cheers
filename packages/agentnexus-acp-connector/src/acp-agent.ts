import { JsonRpcError, JsonRpcStdioPeer } from "./acp-jsonrpc.js";
import type {
  AcpInitializeResponse,
  AcpSessionUpdate,
  ContentBlock,
  Logger,
  PermissionMode,
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
    this.peer = new JsonRpcStdioPeer({
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd,
      env: config.env,
      requestTimeoutMs: config.requestTimeoutMs,
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
  }

  supportsLoadSession(): boolean {
    return Boolean(this.initializeResponse?.agentCapabilities?.loadSession);
  }

  onSessionUpdate(handler: SessionUpdateHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async newSession(): Promise<string> {
    const result = await this.peer.request<{ sessionId?: string }>("session/new", {
      cwd: this.config.cwd,
      mcpServers: this.config.mcpServers ?? [],
    });
    if (!result.sessionId) throw new Error("ACP session/new did not return sessionId");
    return result.sessionId;
  }

  async loadSession(sessionId: string): Promise<void> {
    await this.peer.request("session/load", {
      sessionId,
      cwd: this.config.cwd,
      mcpServers: this.config.mcpServers ?? [],
    });
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<{ stopReason?: string }> {
    return this.peer.request<{ stopReason?: string }>("session/prompt", {
      sessionId,
      prompt,
    });
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
