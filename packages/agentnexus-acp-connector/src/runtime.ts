import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BotSession, type AttachmentInfo, type InboundMessage } from "@haowei0520/bridge-client";

import { AcpStdioAgent } from "./acp-agent.js";
import { SessionStateStore } from "./state.js";
import type { AccountConfig, AcpSessionUpdate, ContentBlock, Logger } from "./types.js";

interface ExtractedFile {
  key: string;
  filename: string;
  contentType?: string;
  data: Uint8Array;
}

interface PromptBuildOptions {
  httpBase: string;
  botToken: string;
  supportsImages: boolean;
  supportsEmbeddedContext: boolean;
  logger: Logger;
}

interface BridgeTextFile {
  filename: string;
  contentType: string;
  sizeBytes?: number;
  summary?: string;
  content: string;
  truncated: boolean;
}

interface BridgeBinaryFile {
  filename: string;
  contentType: string;
  sizeBytes?: number;
  dataB64: string;
}

interface RunContext {
  source: InboundMessage;
  providerSessionKey: string;
  acpSessionId: string;
  msgId: string;
  startedAtMs: number;
  deltaSeq: number;
  traceSeq: number;
  text: string;
  sentDelta: boolean;
  fileIds: string[];
  seenFileKeys: Set<string>;
  pendingFileUploads: Promise<void>[];
}

function textOfContent(content: unknown): string {
  if (Array.isArray(content)) return content.map(textOfContent).filter(Boolean).join("");
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (c.type === "content") return textOfContent(c.content);
  if (Array.isArray(c.content)) return textOfContent(c.content);
  return "";
}

function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()\[\]\u4e00-\u9fff]/g, "_");
  return base && base !== "." && base !== ".." ? base : "acp-output.bin";
}

function filenameFromUri(uri: string): string {
  if (uri.startsWith("file://")) return safeFilename(fileURLToPath(uri));
  try {
    const parsed = new URL(uri);
    return safeFilename(decodeURIComponent(path.basename(parsed.pathname)));
  } catch {
    return safeFilename(uri);
  }
}

function guessContentType(filename: string, fallback?: string): string | undefined {
  const cleanFallback = fallback?.split(";")[0]?.trim();
  if (cleanFallback) return cleanFallback;
  const ext = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".zip": "application/zip",
  };
  return types[ext] ?? undefined;
}

function bytesFromBase64(value: string): Uint8Array {
  const match = value.match(/^data:([^;,]+)?;base64,(.*)$/s);
  return Buffer.from(match ? match[2] : value, "base64");
}

function isInsideDir(filePath: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function filenameFromRecord(record: Record<string, unknown>, fallback: string): string {
  const direct = record.filename ?? record.name ?? record.title ?? record.path ?? record.filePath ?? record.uri;
  return typeof direct === "string" && direct.trim() ? safeFilename(direct) : fallback;
}

function inlineFileFromRecord(record: Record<string, unknown>, fallbackName: string): ExtractedFile | null {
  const filename = filenameFromRecord(record, fallbackName);
  const contentType = guessContentType(
    filename,
    typeof record.mimeType === "string"
      ? record.mimeType
      : typeof record.contentType === "string"
        ? record.contentType
        : undefined,
  );
  const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : null;
  if (text !== null) {
    return {
      key: `text:${filename}:${text.length}:${text.slice(0, 128)}`,
      filename,
      contentType: contentType ?? "text/plain",
      data: Buffer.from(text, "utf8"),
    };
  }
  const blob = typeof record.blob === "string"
    ? record.blob
    : typeof record.data_b64 === "string"
      ? record.data_b64
      : typeof record.data === "string"
        ? record.data
        : null;
  if (blob !== null) {
    const data = bytesFromBase64(blob);
    return {
      key: `blob:${filename}:${data.byteLength}:${blob.slice(0, 128)}`,
      filename,
      contentType,
      data,
    };
  }
  return null;
}

async function fileFromUri(uri: string, cwd: string | undefined, resource: Record<string, unknown>): Promise<ExtractedFile | null> {
  if (!uri.startsWith("file://")) return null;
  return fileFromPath(fileURLToPath(uri), cwd, resource);
}

async function fileFromPath(
  filePath: string,
  cwd: string | undefined,
  resource: Record<string, unknown>,
  options: { minMtimeMs?: number } = {},
): Promise<ExtractedFile | null> {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  if (!isInsideDir(filePath, root)) return null;
  const info = await stat(filePath);
  if (!info.isFile()) return null;
  if (options.minMtimeMs !== undefined && info.mtimeMs + 1000 < options.minMtimeMs) return null;
  const filename = filenameFromRecord(resource, safeFilename(filePath));
  return {
    key: `file:${path.resolve(filePath)}:${info.mtimeMs}:${info.size}`,
    filename,
    contentType: guessContentType(
      filename,
      typeof resource.mimeType === "string" ? resource.mimeType : undefined,
    ),
    data: await readFile(filePath),
  };
}

function filePathFromTextReference(ref: string): string | null {
  const value = ref.trim().replace(/^<|>$/g, "");
  if (!value) return null;
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(value)) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function localFileReferencesFromText(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const filePath = filePathFromTextReference(raw);
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    refs.push(resolved);
  };

  const markdownLinkRe = /\[[^\]\n]*\]\((file:\/\/[^)\n]+|\/[^)\n]+)\)/g;
  for (const match of text.matchAll(markdownLinkRe)) add(match[1] ?? "");

  const bareFileUriRe = /file:\/\/[^\s)\]]+/g;
  for (const match of text.matchAll(bareFileUriRe)) add(match[0] ?? "");

  return refs;
}

async function extractFilesFromTextLinks(
  text: string,
  cwd: string | undefined,
  minMtimeMs: number,
): Promise<ExtractedFile[]> {
  const files: ExtractedFile[] = [];
  for (const filePath of localFileReferencesFromText(text)) {
    const file = await fileFromPath(filePath, cwd, {}, { minMtimeMs });
    if (file) files.push(file);
  }
  return files;
}

async function extractFilesFromContent(
  content: unknown,
  cwd: string | undefined,
  fallbackName = "acp-output.bin",
): Promise<ExtractedFile[]> {
  if (Array.isArray(content)) {
    const nested = await Promise.all(content.map((item) => extractFilesFromContent(item, cwd, fallbackName)));
    return nested.flat();
  }
  if (!content || typeof content !== "object") return [];
  const block = content as Record<string, unknown>;
  const files: ExtractedFile[] = [];
  if (block.resource && typeof block.resource === "object") {
    const resource = block.resource as Record<string, unknown>;
    const inline = inlineFileFromRecord(resource, fallbackName);
    if (inline) files.push(inline);
    const uri = typeof resource.uri === "string" ? resource.uri : "";
    const fromUri = uri && !inline ? await fileFromUri(uri, cwd, resource) : null;
    if (fromUri) files.push(fromUri);
  }
  const inline = (
    block.type === "file"
    || block.type === "resource"
    || typeof block.blob === "string"
    || typeof block.data_b64 === "string"
    || (typeof block.text === "string" && (typeof block.filename === "string" || typeof block.name === "string"))
  )
    ? inlineFileFromRecord(block, fallbackName)
    : null;
  if (inline) files.push(inline);
  const uri = typeof block.uri === "string" ? block.uri : "";
  const fromUri = uri && !inline ? await fileFromUri(uri, cwd, block) : null;
  if (fromUri) files.push(fromUri);
  if (block.content && typeof block.content !== "string") {
    files.push(...await extractFilesFromContent(block.content, cwd, fallbackName));
  }
  return files;
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

function deriveHttpBase(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function isImageAttachment(attachment: AttachmentInfo): boolean {
  return String(attachment.content_type || "").toLowerCase().startsWith("image/");
}

function attachmentUri(attachment: AttachmentInfo): string {
  const id = attachment.file_id || "unknown";
  const name = attachment.filename ? `/${encodeURIComponent(attachment.filename)}` : "";
  return `agentnexus://file/${encodeURIComponent(id)}${name}`;
}

async function fetchBridgeJson(
  url: string,
  botToken: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const body = await response.json() as { data?: unknown };
  return body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : null;
}

async function fetchBridgeTextFile(
  httpBase: string,
  botToken: string,
  attachment: AttachmentInfo,
): Promise<BridgeTextFile | null> {
  if (!httpBase || !attachment.file_id) return null;
  const url = `${httpBase}/api/v1/agent-bridge/files/${encodeURIComponent(attachment.file_id)}/content`;
  const data = await fetchBridgeJson(url, botToken);
  if (!data || typeof data.content !== "string") return null;
  return {
    filename: typeof data.filename === "string" ? data.filename : attachment.filename || attachment.file_id,
    contentType: typeof data.content_type === "string" ? data.content_type : attachment.content_type || "text/markdown",
    sizeBytes: typeof data.size_bytes === "number" ? data.size_bytes : attachment.size_bytes ?? undefined,
    summary: typeof data.summary === "string" ? data.summary : attachment.summary ?? undefined,
    content: data.content,
    truncated: data.truncated === true,
  };
}

async function fetchBridgeBinaryFile(
  httpBase: string,
  botToken: string,
  attachment: AttachmentInfo,
): Promise<BridgeBinaryFile | null> {
  if (!httpBase || !attachment.file_id) return null;
  const url = `${httpBase}/api/v1/agent-bridge/files/${encodeURIComponent(attachment.file_id)}/binary`;
  const data = await fetchBridgeJson(url, botToken);
  if (!data || typeof data.data_b64 !== "string") return null;
  return {
    filename: typeof data.filename === "string" ? data.filename : attachment.filename || attachment.file_id,
    contentType: typeof data.content_type === "string" ? data.content_type : attachment.content_type || "application/octet-stream",
    sizeBytes: typeof data.size_bytes === "number" ? data.size_bytes : attachment.size_bytes ?? undefined,
    dataB64: data.data_b64,
  };
}

function attachmentSummaryLine(attachment: AttachmentInfo): string {
  const name = attachment.filename || attachment.file_id || "attachment";
  const details = [attachment.content_type, attachment.size_bytes ? `${attachment.size_bytes} bytes` : null]
    .filter(Boolean)
    .join(", ");
  return `- ${name}${details ? ` (${details})` : ""}${attachment.summary ? `: ${attachment.summary}` : ""}`;
}

async function attachmentToPromptBlocks(
  attachment: AttachmentInfo,
  options: PromptBuildOptions,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  if (!attachment.file_id) return blocks;

  if (isImageAttachment(attachment)) {
    if (options.supportsImages) {
      try {
        const image = await fetchBridgeBinaryFile(options.httpBase, options.botToken, attachment);
        if (image?.dataB64) {
          blocks.push({
            type: "image",
            mimeType: image.contentType,
            data: image.dataB64,
            uri: attachmentUri(attachment),
          });
          return blocks;
        }
      } catch (err) {
        options.logger.warn("acp attachment image hydration failed file_id=%s: %s", attachment.file_id, String(err));
      }
    }
    if (attachment.summary) {
      blocks.push({ type: "text", text: `[Image attachment unavailable: ${attachment.filename || attachment.file_id}]\n${attachment.summary}` });
    }
    return blocks;
  }

  try {
    const textFile = await fetchBridgeTextFile(options.httpBase, options.botToken, attachment);
    if (textFile?.content) {
      const text = textFile.truncated
        ? `${textFile.content}\n\n[AgentNexus note: file content was truncated before sending to ACP.]`
        : textFile.content;
      if (options.supportsEmbeddedContext) {
        blocks.push({
          type: "resource",
          resource: {
            uri: attachmentUri(attachment),
            mimeType: "text/markdown",
            text,
          },
        });
      } else {
        blocks.push({ type: "text", text: `--- Attachment: ${textFile.filename} ---\n${text}\n--- End attachment ---` });
      }
      return blocks;
    }
  } catch (err) {
    options.logger.warn("acp attachment resource hydration failed file_id=%s: %s", attachment.file_id, String(err));
  }

  if (attachment.summary) {
    blocks.push({
      type: "text",
      text: `--- Attachment summary: ${attachment.filename || attachment.file_id} ---\n${attachment.summary}\n--- End attachment summary ---`,
    });
  }
  return blocks;
}

async function buildPrompt(message: InboundMessage, options: PromptBuildOptions): Promise<ContentBlock[]> {
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
        ...message.attachments.map(attachmentSummaryLine),
      ].join("\n"),
    );
  }
  const blocks: ContentBlock[] = [{ type: "text", text: parts.join("\n\n") || message.text || " " }];
  for (const attachment of message.attachments) {
    blocks.push(...await attachmentToPromptBlocks(attachment, options));
  }
  return blocks;
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
      startedAtMs: Date.now(),
      deltaSeq: 0,
      traceSeq: 0,
      text: "",
      sentDelta: false,
      fileIds: [],
      seenFileKeys: new Set<string>(),
      pendingFileUploads: [],
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
      const capabilities = this.agent.initializeResponse?.agentCapabilities?.promptCapabilities ?? {};
      const result = await this.agent.prompt(acpSessionId, await buildPrompt(message, {
        httpBase: deriveHttpBase(this.config.dataUrl),
        botToken: this.config.botToken,
        supportsImages: capabilities.image === true,
        supportsEmbeddedContext: capabilities.embeddedContext === true,
        logger: this.logger,
      }));
      await this.uploadTextLinkedFiles(ctx);
      await Promise.allSettled(ctx.pendingFileUploads);
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
        this.bridge.streamDone({ msgId, fileIds: ctx.fileIds });
      } else {
        await this.bridge.reply({
          source: message,
          text: ctx.text || `[ACP completed: ${result.stopReason ?? "end_turn"}]`,
          fileIds: ctx.fileIds,
        });
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
      if (text) {
        ctx.text += text;
        ctx.sentDelta = true;
        this.bridge.streamDelta({ msgId: ctx.msgId, seq: ++ctx.deltaSeq, delta: text });
      }
      const upload = this.uploadAcpFiles(ctx, update.content);
      ctx.pendingFileUploads.push(upload);
      await upload;
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

  private async uploadAcpFiles(ctx: RunContext, content: unknown): Promise<void> {
    const files = await extractFilesFromContent(content, this.config.agent.cwd);
    await this.uploadFiles(ctx, files);
  }

  private async uploadTextLinkedFiles(ctx: RunContext): Promise<void> {
    const files = await extractFilesFromTextLinks(ctx.text, this.config.agent.cwd, ctx.startedAtMs - 5000);
    await this.uploadFiles(ctx, files);
  }

  private async uploadFiles(ctx: RunContext, files: ExtractedFile[]): Promise<void> {
    for (const file of files) {
      if (ctx.seenFileKeys.has(file.key)) continue;
      ctx.seenFileKeys.add(file.key);
      const ack = await this.bridge.uploadFile({
        channelId: ctx.source.channelId,
        filename: file.filename,
        data: file.data,
        contentType: file.contentType,
      });
      if (ack.ok) {
        ctx.fileIds.push(ack.file_id);
        this.bridge.trace({
          msg_id: ctx.msgId,
          task_id: ctx.source.event.task_id,
          channel_id: ctx.source.channelId,
          run_id: ctx.acpSessionId,
          session_key: ctx.providerSessionKey,
          stream: "acp",
          seq: ++ctx.traceSeq,
          phase: "file_uploaded",
          status: "completed",
          title: "ACP file uploaded",
          message: ack.filename,
          data: {
            file_id: ack.file_id,
            filename: ack.filename,
            content_type: ack.content_type,
            size_bytes: ack.size_bytes,
          },
        });
      } else {
        this.logger.warn(
          "acp account=%s file upload failed filename=%s code=%s error=%s",
          this.accountId,
          file.filename,
          ack.code,
          ack.error,
        );
      }
    }
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
