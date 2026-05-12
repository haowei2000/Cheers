import { BotSession, type InboundMessage } from "@agentnexus/bridge-client";

import { AcpStdioAgent } from "./acp-agent.js";
import { SessionStateStore } from "./state.js";
import type { AccountConfig, AcpSessionUpdate, ContentBlock, Logger } from "./types.js";

interface RunContext {
  source: InboundMessage;
  providerSessionKey: string;
  acpSessionId: string;
  msgId: string;
  deltaSeq: number;
  traceSeq: number;
  text: string;
  sentDelta: boolean;
}

function textOfContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (c.type === "content") return textOfContent(c.content);
  return "";
}

function summarizeUpdate(update: Record<string, unknown>): string {
  const kind = String(update.sessionUpdate ?? "update");
  if (kind === "plan" && Array.isArray(update.entries)) {
    return update.entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const e = entry as Record<string, unknown>;
        return `${e.status ?? "pending"}: ${e.content ?? ""}`.trim();
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof update.title === "string") return update.title;
  if (typeof update.message === "string") return update.message;
  return kind;
}

function providerSessionKeyOf(message: InboundMessage): string {
  const event = message.event;
  const fromEvent = event.provider_session_key;
  const fromSession = event.session?.provider_session_key;
  if (typeof fromEvent === "string" && fromEvent) return fromEvent;
  if (typeof fromSession === "string" && fromSession) return fromSession;
  return `channel:${message.channelId}`;
}

function buildPrompt(message: InboundMessage): ContentBlock[] {
  const parts: string[] = [];
  if (message.text.trim()) parts.push(message.text.trim());
  const memory = message.event.memory_context ?? {};
  if (Object.keys(memory).length > 0) {
    parts.push(
      [
        "<agentnexus_memory>",
        ...Object.entries(memory).map(([key, value]) => `<${key}>\n${value}\n</${key}>`),
        "</agentnexus_memory>",
      ].join("\n"),
    );
  }
  if (message.attachments.length > 0) {
    parts.push(
      [
        "AgentNexus attachments:",
        ...message.attachments.map((a) => {
          const name = a.filename || a.file_id || "attachment";
          const details = [a.content_type, a.size_bytes ? `${a.size_bytes} bytes` : null]
            .filter(Boolean)
            .join(", ");
          return `- ${name}${details ? ` (${details})` : ""}${a.summary ? `: ${a.summary}` : ""}`;
        }),
      ].join("\n"),
    );
  }
  return [{ type: "text", text: parts.join("\n\n") || message.text }];
}

export class AcpBridgeAccount {
  private readonly bridge: BotSession;
  private readonly agent: AcpStdioAgent;
  private readonly activeProviderSessions = new Map<string, string>();
  private readonly activeRunsBySession = new Map<string, RunContext>();
  private readonly activeRunsByMsg = new Map<string, RunContext>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly accountId: string,
    private readonly config: AccountConfig,
    private readonly state: SessionStateStore,
    private readonly logger: Logger,
  ) {
    this.agent = new AcpStdioAgent(accountId, config.agent, logger);
    this.agent.onSessionUpdate((update) => this.handleAcpUpdate(update));
    this.bridge = new BotSession(
      {
        botToken: config.botToken,
        controlUrl: config.controlUrl,
        dataUrl: config.dataUrl,
        advanced: config.advanced,
      },
      {
        onReady: () => this.logger.info("bridge account=%s ready", this.accountId),
        onMessage: (message) => {
          this.queue = this.queue
            .then(() => this.handleMessage(message))
            .catch((err) => this.logger.error("account=%s message failed: %s", this.accountId, String(err)));
        },
        onCancel: (msgId, reason) => this.handleCancel(msgId, reason),
        onFatal: (reason) => this.logger.error("bridge account=%s fatal: %s", this.accountId, reason),
        onError: (err) => this.logger.error("bridge account=%s error: %s", this.accountId, String(err)),
        onConnectionChange: (stream, state) => this.logger.info(
          "bridge account=%s %s=%s",
          this.accountId,
          stream,
          state,
        ),
      },
    );
  }

  async start(): Promise<void> {
    await this.agent.start();
    this.bridge.start();
    await this.bridge.waitReady(15_000);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.bridge.stop(), this.agent.stop()]);
  }

  private async ensureAcpSession(providerSessionKey: string): Promise<string> {
    const active = this.activeProviderSessions.get(providerSessionKey);
    if (active) return active;
    const saved = this.state.get(this.accountId, providerSessionKey);
    if (saved && this.agent.supportsLoadSession()) {
      try {
        await this.agent.loadSession(saved);
        this.activeProviderSessions.set(providerSessionKey, saved);
        this.logger.info("acp account=%s loaded session %s", this.accountId, saved);
        return saved;
      } catch (err) {
        this.logger.warn(
          "acp account=%s failed to load session %s: %s",
          this.accountId,
          saved,
          String(err),
        );
      }
    }
    const created = await this.agent.newSession();
    this.activeProviderSessions.set(providerSessionKey, created);
    await this.state.set(this.accountId, providerSessionKey, created);
    this.logger.info("acp account=%s created session %s for %s", this.accountId, created, providerSessionKey);
    return created;
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const providerSessionKey = providerSessionKeyOf(message);
    const acpSessionId = await this.ensureAcpSession(providerSessionKey);
    const msgId = message.event.placeholder_msg_id || `${message.event.task_id}`;
    const ctx: RunContext = {
      source: message,
      providerSessionKey,
      acpSessionId,
      msgId,
      deltaSeq: 0,
      traceSeq: 0,
      text: "",
      sentDelta: false,
    };
    this.activeRunsBySession.set(acpSessionId, ctx);
    this.activeRunsByMsg.set(msgId, ctx);
    this.bridge.trace({
      msg_id: msgId,
      task_id: message.event.task_id,
      channel_id: message.channelId,
      run_id: acpSessionId,
      session_key: providerSessionKey,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: "prompt_started",
      status: "running",
      title: "ACP prompt started",
      message: this.config.agent.command,
    });
    try {
      const result = await this.agent.prompt(acpSessionId, buildPrompt(message));
      this.bridge.trace({
        msg_id: msgId,
        task_id: message.event.task_id,
        channel_id: message.channelId,
        run_id: acpSessionId,
        session_key: providerSessionKey,
        stream: "acp",
        seq: ++ctx.traceSeq,
        phase: "prompt_finished",
        status: result.stopReason === "cancelled" ? "cancelled" : "completed",
        title: "ACP prompt finished",
        message: result.stopReason ?? "end_turn",
      });
      if (message.event.placeholder_msg_id) {
        this.bridge.streamDone({ msgId });
      } else {
        await this.bridge.reply({ source: message, text: ctx.text || `[ACP completed: ${result.stopReason ?? "end_turn"}]` });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (message.event.placeholder_msg_id) {
        this.bridge.streamError({ msgId, message: detail });
      } else {
        await this.bridge.reply({ source: message, text: `ACP agent error: ${detail}` });
      }
      throw err;
    } finally {
      this.activeRunsBySession.delete(acpSessionId);
      this.activeRunsByMsg.delete(msgId);
    }
  }

  private handleCancel(msgId: string, reason?: string): void {
    const ctx = this.activeRunsByMsg.get(msgId);
    if (!ctx) return;
    this.logger.warn("acp account=%s cancelling session=%s reason=%s", this.accountId, ctx.acpSessionId, reason ?? "");
    this.agent.cancel(ctx.acpSessionId);
  }

  private async handleAcpUpdate(notification: AcpSessionUpdate): Promise<void> {
    const ctx = this.activeRunsBySession.get(notification.sessionId);
    if (!ctx) return;
    const update = notification.update;
    const kind = String(update.sessionUpdate ?? "unknown");
    if (kind === "agent_message_chunk") {
      const text = textOfContent(update.content);
      if (!text) return;
      ctx.text += text;
      ctx.sentDelta = true;
      this.bridge.streamDelta({ msgId: ctx.msgId, seq: ++ctx.deltaSeq, delta: text });
      return;
    }
    const message = kind === "agent_thought_chunk"
      ? textOfContent(update.content)
      : summarizeUpdate(update);
    this.bridge.trace({
      msg_id: ctx.msgId,
      task_id: ctx.source.event.task_id,
      channel_id: ctx.source.channelId,
      run_id: ctx.acpSessionId,
      session_key: ctx.providerSessionKey,
      stream: "acp",
      seq: ++ctx.traceSeq,
      phase: kind,
      status: String(update.status ?? "running"),
      title: String(update.title ?? kind),
      message,
      data: update,
    });
  }
}

export class ConnectorRuntime {
  private accounts: AcpBridgeAccount[];

  constructor(
    configs: Record<string, AccountConfig>,
    private readonly state: SessionStateStore,
    private readonly logger: Logger = console,
  ) {
    this.accounts = Object.entries(configs).map(
      ([id, config]) => new AcpBridgeAccount(id, config, state, logger),
    );
  }

  async start(): Promise<void> {
    await this.state.load();
    await Promise.all(this.accounts.map((account) => account.start()));
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.accounts.map((account) => account.stop()));
  }
}
