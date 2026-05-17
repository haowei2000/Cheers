/**
 * agentnexus channel plugin using the official OpenClaw SDK contract
 * (channel-core).
 *
 * Built with the createChatChannelPlugin + createChannelPluginBase pattern from
 * docs.openclaw.ai/plugins/sdk-channel-plugins. The entry file registers an
 * HTTP route in registerFull. WebSocket inbound messages loop back to that route
 * to enter gateway-request-scope, where api.runtime.subagent.run is allowed.
 * Agent output returns through outbound.sendText and session.reply finalizes the
 * AgentNexus placeholder message in place.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type ConversationRef,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";

import { BotSession, type InboundMessage } from "./session.js";
import type { TraceFrame } from "./types.js";

const PLUGIN_ID = "agentnexus";
const INBOUND_CACHE_MAX = 1000;
const DEFAULT_OPENCLAW_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================================
// Attachment body hydration: use the bot token to read Markdown from the
// AgentNexus bridge and prepend it to the subagent.run message so agents are not
// limited to short attachment summaries.
// ============================================================================

function deriveHttpBase(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${u.host}`;
  } catch {
    return "";
  }
}

interface FileContentFetchResult {
  filename: string;
  content: string;
  truncated: boolean;
}

/** Bound bridge fetches so backend stalls do not block WebSocket message handling. */
const BRIDGE_FETCH_TIMEOUT_MS = 10_000;

async function fetchFileContentForBot(
  httpBase: string, botToken: string, fileId: string,
  log?: { warn?: (...a: unknown[]) => void; debug?: (...a: unknown[]) => void },
): Promise<FileContentFetchResult | null> {
  if (!httpBase) {
    log?.warn?.(`agentnexus: fetchFileContent no httpBase fileId=${fileId}`);
    return null;
  }
  const url = `${httpBase}/api/v1/agent-bridge/files/${encodeURIComponent(fileId)}/content`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "<unreadable>");
      log?.warn?.(`agentnexus: fetchFileContent HTTP ${resp.status} fileId=${fileId} body=${detail.slice(0, 200)}`);
      return null;
    }
    const body = await resp.json() as {
      data?: { filename?: string; content?: string; truncated?: boolean };
    };
    const data = body.data;
    if (!data || typeof data.content !== "string") {
      log?.warn?.(`agentnexus: fetchFileContent malformed response fileId=${fileId}`);
      return null;
    }
    log?.debug?.(`agentnexus: fetchFileContent ok fileId=${fileId} len=${data.content.length} truncated=${data.truncated ?? false}`);
    return {
      filename: data.filename || fileId,
      content: data.content,
      truncated: data.truncated ?? false,
    };
  } catch (err) {
    log?.warn?.(`agentnexus: fetchFileContent threw fileId=${fileId} err=${String(err)}`);
    return null;
  }
}

/** Auto-upload long agent replies as .md attachments above this threshold. */
const AUTO_ATTACH_THRESHOLD_CHARS = 4000;

interface OutputFallbackConfig {
  enabled: boolean;
  outputDirs: string[];
  delayMs: number;
  pollMs: number;
  stableMs: number;
  postStreamWatchMs: number;
  maxWatchMs: number;
  maxFiles: number;
  minBytes: number;
  maxBytes: number;
}

type RawOutputFallbackConfig = Partial<OutputFallbackConfig>;

const DEFAULT_OUTPUT_FALLBACK: OutputFallbackConfig = {
  enabled: true,
  outputDirs: [],
  // Keep OpenClaw's fallback aligned with AgentNexus's background handoff threshold.
  delayMs: DEFAULT_OPENCLAW_TIMEOUT_MS,
  pollMs: 2_000,
  stableMs: 6_000,
  postStreamWatchMs: 15_000,
  maxWatchMs: 60 * 60 * 1000,
  maxFiles: 80,
  minBytes: 16,
  maxBytes: 25 * 1024 * 1024,
};

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function resolveOutputFallbackConfig(raw?: RawOutputFallbackConfig): OutputFallbackConfig {
  const base = DEFAULT_OUTPUT_FALLBACK;
  return {
    enabled: raw?.enabled ?? base.enabled,
    outputDirs: Array.isArray(raw?.outputDirs)
      ? raw.outputDirs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : base.outputDirs,
    delayMs: normalizePositiveInt(raw?.delayMs, base.delayMs),
    pollMs: normalizePositiveInt(raw?.pollMs, base.pollMs),
    stableMs: normalizePositiveInt(raw?.stableMs, base.stableMs),
    postStreamWatchMs: normalizePositiveInt(raw?.postStreamWatchMs, base.postStreamWatchMs),
    maxWatchMs: normalizePositiveInt(raw?.maxWatchMs, base.maxWatchMs),
    maxFiles: normalizePositiveInt(raw?.maxFiles, base.maxFiles),
    minBytes: normalizePositiveInt(raw?.minBytes, base.minBytes),
    maxBytes: normalizePositiveInt(raw?.maxBytes, base.maxBytes),
  };
}

/** Delivery contract prepended before inbound OpenClaw agent calls. */
const AGENTNEXUS_RESPONSE_CONTRACT = `

<agentnexus_response_contract>
  <final_output_required>true</final_output_required>
  <rules>
    <rule>不要把“正在生成/我将生成/Let me generate/Now I have enough info”等进度句作为最终回复。</rule>
    <rule>如果任务要求报告、HTML、Markdown、附件或文件，请实际创建可交付文件，并用 MEDIA:/absolute/path 返回，或直接输出完整正文。</rule>
    <rule>本契约优先于 skill 中关于 HTML 报告的默认建议；除非用户原话明确要求 HTML/网页/可视化页面，否则“报告”默认创建 Markdown 文件。</rule>
    <rule>不要在 assistant 正文或隐藏思考中起草超长 HTML；需要文件时先写入磁盘，再用 MEDIA:/absolute/path 返回。</rule>
    <rule>使用 write 工具时每次调用都必须包含 path 和 content；不要用缺少 path 的 write 续写。</rule>
    <rule>创建文件后，最终回复必须包含 MEDIA:/absolute/path，便于 AgentNexus 自动上传附件；不要停在 write 成功后的继续思考。</rule>
    <rule>最终回复必须包含完整可见结果或 MEDIA 文件；不能只说明接下来要做什么。</rule>
    <rule>如果无法生成完整产物，请明确说明失败原因，不要返回进度占位句。</rule>
  </rules>
</agentnexus_response_contract>`;

function appendAgentNexusResponseContract(message: string): string {
  if (message.includes("<agentnexus_response_contract>")) return message;
  return `${message.trimEnd()}${AGENTNEXUS_RESPONSE_CONTRACT}`;
}

async function uploadBotMarkdownFile(
  session: BotSession,
  channelId: string,
  filename: string,
  content: string,
): Promise<string | null> {
  // Reuse the same file_upload frame by sending Markdown text as binary with contentType=text/markdown.
  try {
    const safeName = filename.endsWith(".md") ? filename : `${filename}.md`;
    const ack = await session.uploadFile({
      channelId,
      filename: safeName,
      data: Buffer.from(content, "utf8"),
      contentType: "text/markdown; charset=utf-8",
    });
    return ack.ok ? ack.file_id : null;
  } catch {
    return null;
  }
}

type PluginLogger = {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  debug?: (...a: unknown[]) => void;
};

async function buildMessageWithAttachments(
  base: string, botToken: string, m: InboundMessage, log?: PluginLogger,
): Promise<string> {
  if (!m.attachments || m.attachments.length === 0) return m.text;
  log?.info?.(`agentnexus: hydrating ${m.attachments.length} attachment(s) base=${base} task=${m.event.task_id}`);

  const hydrations = await Promise.all(
    m.attachments.map(async (att): Promise<string | null> => {
      if (!att.file_id) return null;
      if (att.content_type && att.content_type.startsWith("image/")) {
        log?.debug?.(`agentnexus: skipping image attachment fileId=${att.file_id} ct=${att.content_type}`);
        return null;
      }
      const fetched = await fetchFileContentForBot(base, botToken, att.file_id, log);
      if (fetched && fetched.content) {
        return `\n\n--- 附件: ${fetched.filename} ---\n${fetched.content}${fetched.truncated ? "\n...(内容已截断)" : ""}\n--- 附件结束 ---`;
      }
      const filename = att.filename || att.file_id;
      if (att.summary) {
        log?.warn?.(`agentnexus: attachment fallback to summary fileId=${att.file_id} filename=${filename}`);
        return `\n\n--- 附件: ${filename} (读取失败，仅存摘要) ---\n${att.summary}\n--- 附件结束 ---`;
      }
      log?.warn?.(`agentnexus: attachment no content and no summary fileId=${att.file_id} filename=${filename}`);
      return null;
    }),
  );

  return [m.text, ...hydrations.filter((s): s is string => s !== null)].join("");
}

// ============================================================================
// ResolvedAccount is derived from config and used by gateway / outbound adapters.
// ============================================================================

export interface ResolvedAccount {
  accountId: string | null;
  enabled: boolean;
  botToken: string;
  controlUrl: string;
  dataUrl: string;
  advanced: {
    reconnectBaseMs: number;
    reconnectMaxMs: number;
    heartbeatIntervalMs: number;
    sendAckTimeoutMs: number;
  };
  dmPolicy?: string;
  allowFrom: string[];
  outputFallback: OutputFallbackConfig;
}

interface RawAccount {
  enabled?: boolean;
  botToken: string;
  controlUrl: string;
  dataUrl: string;
  advanced?: Partial<ResolvedAccount["advanced"]>;
  allowFrom?: string[];
  dmSecurity?: string;
  outputFallback?: RawOutputFallbackConfig;
}

function getAccountsFromCfg(cfg: OpenClawConfig): Record<string, RawAccount> {
  const section = (cfg.channels as Record<string, unknown> | undefined)?.[PLUGIN_ID] as
    | { accounts?: Record<string, RawAccount> }
    | undefined;
  return section?.accounts ?? {};
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  const accounts = getAccountsFromCfg(cfg);
  const id = accountId ?? Object.keys(accounts)[0] ?? null;
  const raw = (id && accounts[id]) || undefined;
  if (!raw) {
    // Return a placeholder account when none is found; the SDK checks configured via inspectAccount.
    return {
      accountId: id,
      enabled: false,
      botToken: "",
      controlUrl: "",
      dataUrl: "",
      advanced: {
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30000,
        heartbeatIntervalMs: 30000,
        sendAckTimeoutMs: DEFAULT_OPENCLAW_TIMEOUT_MS,
      },
      allowFrom: [],
      outputFallback: resolveOutputFallbackConfig(),
    };
  }
  return {
    accountId: id,
    enabled: raw.enabled ?? true,
    botToken: raw.botToken,
    controlUrl: raw.controlUrl,
    dataUrl: raw.dataUrl,
    advanced: {
      reconnectBaseMs: raw.advanced?.reconnectBaseMs ?? 1000,
      reconnectMaxMs: raw.advanced?.reconnectMaxMs ?? 30000,
      heartbeatIntervalMs: raw.advanced?.heartbeatIntervalMs ?? 30000,
      sendAckTimeoutMs: raw.advanced?.sendAckTimeoutMs ?? DEFAULT_OPENCLAW_TIMEOUT_MS,
    },
    dmPolicy: raw.dmSecurity,
    allowFrom: raw.allowFrom ?? [],
    outputFallback: resolveOutputFallbackConfig(raw.outputFallback),
  };
}

function inspectAccount(cfg: OpenClawConfig, accountId?: string | null): unknown {
  const account = resolveAccount(cfg, accountId);
  return {
    enabled: account.enabled && Boolean(account.botToken),
    configured: Boolean(account.botToken && account.controlUrl && account.dataUrl),
    tokenStatus: account.botToken ? "available" : "missing",
  };
}

// ============================================================================
// SessionRegistry stores the BotSession and inbound message cache for each live account.
// ============================================================================

interface AccountRuntime {
  session: BotSession;
  account: ResolvedAccount;
  /** sessionKey -> latest inbound message, still useful in standalone/debug mode. */
  lastInboundBySessionKey: Map<string, InboundMessage>;
  /** taskId -> inbound. Session binding maps conversationId=taskId to sessionKey;
   *  when deliver returns with ctx.to === taskId, this recovers the source for session.reply. */
  lastInboundByTaskId: Map<string, InboundMessage>;
  /** conversation/task/child id → AgentNexus reply target.
   *
   * OpenClaw child runs may deliver outbound chunks with ctx.to equal to a
   * child conversation id rather than the original AgentNexus task_id. This
   * map keeps all of those aliases pinned to the original placeholder. */
  replyTargets: Map<string, ReplyTarget>;
  /** In-memory store for SessionBindingAdapter: sessionKey -> records. */
  bindingStore: Map<string, SessionBindingRecord[]>;
  /** Kept so stopAccount can unregister it. */
  bindingAdapter: SessionBindingAdapter;
}

interface ReplyTarget {
  taskId: string;
  placeholderMsgId: string | null;
  channelId: string;
  sessionKey?: string;
  source?: InboundMessage;
}

const sessionRegistry = new Map<string, AccountRuntime>();

function rememberInbound(cache: Map<string, InboundMessage>, key: string, m: InboundMessage): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, m);
  while (cache.size > INBOUND_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function rememberReplyTarget(cache: Map<string, ReplyTarget>, key: string | null | undefined, target: ReplyTarget): void {
  if (!key) return;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, target);
  while (cache.size > INBOUND_CACHE_MAX * 3) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function sessionKeyFor(accountId: string, channelId: string): string {
  return `agentnexus:${accountId}:${channelId}`;
}

function sessionKeyFromInbound(accountId: string, m: InboundMessage): string {
  const direct = m.event.provider_session_key;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = m.event.session?.provider_session_key;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  return sessionKeyFor(accountId, m.channelId);
}

function forgetInboundBySessionKey(
  cache: Map<string, InboundMessage>, accountId: string, source: InboundMessage,
): void {
  cache.delete(sessionKeyFromInbound(accountId, source));
  cache.delete(sessionKeyFor(accountId, source.channelId));
}

function replyTargetFromInbound(accountId: string, m: InboundMessage): ReplyTarget {
  return {
    taskId: m.event.task_id,
    placeholderMsgId: m.event.placeholder_msg_id ?? null,
    channelId: m.channelId,
    sessionKey: sessionKeyFromInbound(accountId, m),
    source: m,
  };
}

function readReplyTargetMetadata(value: unknown): Omit<ReplyTarget, "source"> | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const taskId = data.agentnexusTaskId ?? data.taskId;
  const placeholderMsgId = data.placeholderMsgId ?? data.placeholder_msg_id;
  const channelId = data.channelId ?? data.channel_id;
  const sessionKey = data.sessionKey ?? data.provider_session_key;
  if (typeof taskId !== "string" || !taskId) return null;
  if (typeof channelId !== "string" || !channelId) return null;
  return {
    taskId,
    placeholderMsgId: typeof placeholderMsgId === "string" && placeholderMsgId ? placeholderMsgId : null,
    channelId,
    ...(typeof sessionKey === "string" && sessionKey ? { sessionKey } : {}),
  };
}

function completeReplyTarget(
  target: Omit<ReplyTarget, "source">,
  parent: ReplyTarget | null,
  source: InboundMessage | undefined,
): ReplyTarget {
  const out: ReplyTarget = {
    ...target,
    placeholderMsgId: target.placeholderMsgId ?? parent?.placeholderMsgId ?? null,
    ...(target.sessionKey ? {} : parent?.sessionKey ? { sessionKey: parent.sessionKey } : {}),
  };
  const resolvedSource = source ?? parent?.source;
  if (resolvedSource) out.source = resolvedSource;
  return out;
}

function replyTargetFromBindingRecord(entry: AccountRuntime, rec: SessionBindingRecord): ReplyTarget | null {
  const own = readReplyTargetMetadata(rec.metadata);
  const parentId = rec.conversation.parentConversationId;
  const parent = parentId ? entry.replyTargets.get(parentId) ?? null : null;
  if (own) {
    return completeReplyTarget(
      own,
      parent,
      entry.lastInboundByTaskId.get(own.taskId) ?? entry.replyTargets.get(own.taskId)?.source,
    );
  }
  if (parent) return parent;
  return null;
}

function findBindingReplyTarget(entry: AccountRuntime, conversationId: string): ReplyTarget | null {
  for (const arr of entry.bindingStore.values()) {
    for (const rec of arr) {
      if (rec.conversation.conversationId !== conversationId) continue;
      const target = replyTargetFromBindingRecord(entry, rec);
      if (target) {
        rememberReplyTarget(entry.replyTargets, conversationId, target);
        return target;
      }
    }
  }
  return null;
}

function resolveReplyTarget(entry: AccountRuntime, to: string): ReplyTarget | null {
  const direct = entry.replyTargets.get(to);
  if (direct) return direct;

  const byTask = entry.lastInboundByTaskId.get(to);
  if (byTask) {
    const accountId = entry.account.accountId ?? "";
    const target = replyTargetFromInbound(accountId, byTask);
    rememberReplyTarget(entry.replyTargets, to, target);
    return target;
  }

  const bySession = entry.lastInboundBySessionKey.get(to);
  if (bySession) {
    const accountId = entry.account.accountId ?? "";
    const target = replyTargetFromInbound(accountId, bySession);
    rememberReplyTarget(entry.replyTargets, to, target);
    return target;
  }

  return findBindingReplyTarget(entry, to);
}

function sourceForReplyTarget(entry: AccountRuntime, target: ReplyTarget | null, to: string): InboundMessage | undefined {
  return entry.lastInboundByTaskId.get(to)
    ?? entry.lastInboundBySessionKey.get(to)
    ?? (target?.taskId ? entry.lastInboundByTaskId.get(target.taskId) : undefined)
    ?? target?.source;
}

// ============================================================================
// OpenClaw agent event forwarding —— runtime.events.onAgentEvent → bridge trace
// ============================================================================

type OpenClawAgentEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

type RunTraceTarget = {
  accountId: string;
  sessionKey: string;
  channelId: string;
  taskId: string;
  placeholderMsgId: string | null;
  registeredAt: number;
};

const RUN_TRACE_TTL_MS = 2 * 60 * 60 * 1000;
const runTraceByRunId = new Map<string, RunTraceTarget>();
let agentEventUnsubscribe: (() => void) | null = null;

function truncateTraceText(value: string, limit = 240): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function readTraceString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeTraceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = [
    "phase",
    "status",
    "kind",
    "title",
    "name",
    "summary",
    "progressText",
    "message",
    "error",
    "toolCallId",
    "approvalId",
    "approvalSlug",
    "command",
    "cwd",
    "exitCode",
    "durationMs",
    "provider",
    "model",
  ];
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") out[key] = truncateTraceText(value);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
  }
  const text = readTraceString(data, "text") ?? readTraceString(data, "output");
  if (text) out.preview = truncateTraceText(text, 160);
  return out;
}

function summarizeTraceEvent(stream: string, data: Record<string, unknown>): {
  phase?: string;
  status?: string;
  title?: string;
  message?: string;
} {
  const phase = readTraceString(data, "phase");
  const status = readTraceString(data, "status");
  const title = readTraceString(data, "title")
    ?? readTraceString(data, "name")
    ?? readTraceString(data, "toolName");
  const message = readTraceString(data, "progressText")
    ?? readTraceString(data, "summary")
    ?? readTraceString(data, "message")
    ?? readTraceString(data, "error")
    ?? readTraceString(data, "command")
    ?? readTraceString(data, "text")
    ?? readTraceString(data, "output");
  return {
    phase,
    status,
    title: title ? truncateTraceText(title, 120) : stream,
    message: message ? truncateTraceText(message, 180) : undefined,
  };
}

function isTerminalAgentEvent(evt: OpenClawAgentEvent): boolean {
  if (evt.stream === "lifecycle") {
    const phase = readTraceString(evt.data, "phase");
    const status = readTraceString(evt.data, "status");
    return phase === "end" || phase === "error" || status === "completed" || status === "failed";
  }
  return evt.stream === "error";
}

function sweepRunTraceTargets(): void {
  const cutoff = Date.now() - RUN_TRACE_TTL_MS;
  for (const [runId, target] of runTraceByRunId) {
    if (target.registeredAt < cutoff) runTraceByRunId.delete(runId);
  }
}

function clearRunTraceTargetsForAccount(accountId: string): void {
  for (const [runId, target] of runTraceByRunId) {
    if (target.accountId === accountId) runTraceByRunId.delete(runId);
  }
}

function inferRunTraceTarget(evt: OpenClawAgentEvent): RunTraceTarget | null {
  const byRun = runTraceByRunId.get(evt.runId);
  if (byRun) return byRun;

  const sessionKey = typeof evt.sessionKey === "string" ? evt.sessionKey : undefined;
  if (!sessionKey) return null;

  let newest: RunTraceTarget | null = null;
  for (const target of runTraceByRunId.values()) {
    if (target.sessionKey !== sessionKey) continue;
    if (!newest || target.registeredAt > newest.registeredAt) newest = target;
  }
  if (newest) {
    registerOpenClawRunTrace({
      runId: evt.runId,
      accountId: newest.accountId,
      sessionKey: newest.sessionKey,
      channelId: newest.channelId,
      taskId: newest.taskId,
      placeholderMsgId: newest.placeholderMsgId,
    });
    return runTraceByRunId.get(evt.runId) ?? newest;
  }
  return null;
}

export function registerOpenClawRunTrace(target: Omit<RunTraceTarget, "registeredAt"> & { runId: string }): void {
  sweepRunTraceTargets();
  runTraceByRunId.set(target.runId, {
    accountId: target.accountId,
    sessionKey: target.sessionKey,
    channelId: target.channelId,
    taskId: target.taskId,
    placeholderMsgId: target.placeholderMsgId,
    registeredAt: Date.now(),
  });
}

export function emitRunTrace(runId: string, trace: {
  stream: string;
  seq?: number;
  ts?: number;
  phase?: string;
  status?: string;
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
}): boolean {
  const target = runTraceByRunId.get(runId);
  if (!target?.placeholderMsgId) return false;
  const entry = sessionRegistry.get(target.accountId);
  if (!entry) return false;
  const frame: Omit<TraceFrame, "type"> = {
    msg_id: target.placeholderMsgId,
    task_id: target.taskId,
    channel_id: target.channelId,
    run_id: runId,
    session_key: target.sessionKey,
    stream: trace.stream,
    ...(trace.seq !== undefined ? { seq: trace.seq } : {}),
    ...(trace.ts !== undefined ? { ts: trace.ts } : {}),
    ...(trace.phase ? { phase: trace.phase } : {}),
    ...(trace.status ? { status: trace.status } : {}),
    ...(trace.title ? { title: trace.title } : {}),
    ...(trace.message ? { message: trace.message } : {}),
    ...(trace.data ? { data: trace.data } : {}),
  };
  return entry.session.trace(frame);
}

function forwardOpenClawAgentEvent(evt: OpenClawAgentEvent): void {
  if (!evt || typeof evt.runId !== "string" || !evt.runId) return;
  const target = inferRunTraceTarget(evt);
  if (!target) return;
  const summary = summarizeTraceEvent(evt.stream, evt.data);
  emitRunTrace(evt.runId, {
    stream: evt.stream,
    seq: typeof evt.seq === "number" ? evt.seq : undefined,
    ts: typeof evt.ts === "number" ? evt.ts : Date.now(),
    ...summary,
    data: sanitizeTraceData(evt.data),
  });
  if (isTerminalAgentEvent(evt)) runTraceByRunId.delete(evt.runId);
}

function noDeliverableMessage(status: string, error?: string | null): string {
  if (status === "error") {
    return `OpenClaw 运行失败，未生成可交付正文或附件：${error || "unknown error"}`;
  }
  return "OpenClaw 运行已结束，但没有生成可交付正文或附件；最后输出仅为进度句，已停止该后台任务。";
}

function hasVisibleStreamPayload(slot: PendingStreamSlot): boolean {
  return slot.hasDeltas || slot.fileIds.length > 0;
}

function terminalSettleMsForOutputFallback(accountId: string | null | undefined, taskId: string): number {
  if (!accountId || !taskId) return STREAM_DONE_DEBOUNCE_MS;
  const watcher = outputFallbackWatchers.get(outputFallbackKey(accountId, taskId));
  if (!watcher) return STREAM_DONE_DEBOUNCE_MS;
  const now = Date.now();
  const settleMs = outputFallbackSettleMs(watcher.cfg);
  watcher.finishAfter = watcher.finishAfter
    ? Math.min(watcher.finishAfter, now + settleMs)
    : now + settleMs;
  return Math.max(0, watcher.finishAfter - now) + watcher.cfg.pollMs + 50;
}

function finalizeHeldStatusOnlyStream(
  entry: AccountRuntime,
  taskId: string,
  message: string,
  log?: PluginLogger,
): boolean {
  const slot = pendingStreamByTo.get(taskId);
  if (!slot || slot.cancelled || !slot.placeholderMsgId) return false;
  if (!slot.heldStatusText || hasVisibleStreamPayload(slot)) return false;
  if (slot.doneTimer) {
    clearTimeout(slot.doneTimer);
    slot.doneTimer = null;
  }

  pendingStreamByTo.delete(taskId);
  taskByPlaceholder.delete(slot.placeholderMsgId);
  stopOutputFallbackWatcher(entry.account.accountId, slot.source.event.task_id);

  slot.seq += 1;
  const wroteDelta = entry.session.streamDelta({
    msgId: slot.placeholderMsgId,
    seq: slot.seq,
    delta: message,
  });
  const wroteError = entry.session.streamError({
    msgId: slot.placeholderMsgId,
    message,
  });
  log?.warn?.(`agentnexus: finalized held status-only run task=${taskId} wroteDelta=${wroteDelta} wroteError=${wroteError}`);
  return wroteDelta || wroteError;
}

function finalizeUndeliveredRun(
  target: RunTraceTarget,
  status: string,
  error?: string | null,
  log?: PluginLogger,
): boolean {
  const entry = sessionRegistry.get(target.accountId);
  if (!entry) return false;
  const message = noDeliverableMessage(status, error);
  if (finalizeHeldStatusOnlyStream(entry, target.taskId, message, log)) return true;

  const source = entry.lastInboundByTaskId.get(target.taskId)
    ?? entry.replyTargets.get(target.taskId)?.source;
  if (!source) return false;
  void entry.session.reply({ source, text: message }).catch((err) => {
    log?.warn?.(`agentnexus: failed to finalize undelivered run task=${target.taskId}: ${String(err)}`);
  });
  stopOutputFallbackWatcher(target.accountId, target.taskId);
  return true;
}

export function notifyOpenClawRunTerminal(args: {
  runId: string;
  accountId: string;
  taskId: string;
  status: "ok" | "error" | "timeout" | string;
  error?: string | null;
}, log?: PluginLogger): void {
  const target = runTraceByRunId.get(args.runId)
    ?? Array.from(runTraceByRunId.values()).find((item) => (
      item.accountId === args.accountId && item.taskId === args.taskId
    ));
  if (!target) return;
  if (args.status === "timeout") return;

  const delayMs = terminalSettleMsForOutputFallback(target.accountId, target.taskId);
  setTimeout(() => {
    finalizeUndeliveredRun(target, args.status, args.error, log);
    runTraceByRunId.delete(args.runId);
  }, delayMs);
}

export function installAgentEventForwarder(api: OpenClawPluginApi): void {
  if (agentEventUnsubscribe) {
    agentEventUnsubscribe();
    agentEventUnsubscribe = null;
  }
  const onAgentEvent = api.runtime?.events?.onAgentEvent;
  if (typeof onAgentEvent !== "function") {
    api.logger.warn("agentnexus: OpenClaw runtime.events.onAgentEvent is unavailable; trace forwarding disabled");
    return;
  }
  agentEventUnsubscribe = onAgentEvent((evt) => {
    forwardOpenClawAgentEvent(evt as OpenClawAgentEvent);
  });
  api.logger.info("agentnexus: OpenClaw agent event forwarding enabled");
}

function emitInboundTrace(
  session: BotSession,
  accountId: string,
  sessionKey: string,
  m: InboundMessage,
  trace: {
    phase: string;
    title: string;
    message?: string;
    status?: string;
    data?: Record<string, unknown>;
  },
): boolean {
  const msgId = m.event.placeholder_msg_id;
  if (!msgId) return false;
  return session.trace({
    msg_id: msgId,
    task_id: m.event.task_id,
    channel_id: m.channelId,
    run_id: m.event.task_id,
    session_key: sessionKey,
    stream: "agentnexus_plugin",
    ts: Date.now(),
    phase: trace.phase,
    title: trace.title,
    ...(trace.status ? { status: trace.status } : {}),
    ...(trace.message ? { message: trace.message } : {}),
    data: {
      accountId,
      ...trace.data,
    },
  });
}

// ============================================================================
// Shared plugin API. registerFull stores api here; onMessage bounces messages
// through fetch into the api.registerHttpRoute route to enter request scope.
// ============================================================================

interface SharedApiRef {
  api: OpenClawPluginApi | null;
  gatewayPort: number | null;
  internalToken: string | null;  // Protection token for self-loopback requests.
  gatewayToken: string | null;   // Outer OpenClaw gateway token auth.
}

const sharedApi: SharedApiRef = {
  api: null, gatewayPort: null, internalToken: null, gatewayToken: null,
};

export function setSharedApi(
  api: OpenClawPluginApi, gatewayPort: number, token: string, gatewayToken: string | null,
): void {
  sharedApi.api = api;
  sharedApi.gatewayPort = gatewayPort;
  sharedApi.internalToken = token;
  sharedApi.gatewayToken = gatewayToken;
}

export function getSharedApi(): SharedApiRef {
  return sharedApi;
}

// ============================================================================
// Gateway adapter: startAccount/stopAccount
// ============================================================================

interface GatewayCtx {
  account: ResolvedAccount;
  accountId: string;
  abortSignal?: AbortSignal;
  log?: {
    info?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
    error?: (...a: unknown[]) => void;
  };
  setStatus?: (next: unknown) => void;
}

async function startAccount(rawCtx: unknown): Promise<void> {
  const ctx = rawCtx as GatewayCtx;
  const { account, accountId } = ctx;
  const log = ctx.log ?? console;

  const existing = sessionRegistry.get(accountId);
  if (existing) {
    log.warn?.(`agentnexus: startAccount called twice for ${accountId}; stopping old session first`);
    await existing.session.stop();
  }

  const lastInboundBySessionKey = new Map<string, InboundMessage>();
  const lastInboundByTaskId = new Map<string, InboundMessage>();
  const replyTargets = new Map<string, ReplyTarget>();
  const bindingStore = new Map<string, SessionBindingRecord[]>();

  // Register SessionBindingAdapter. deliver:true uses this to route sessionKey to
  // {channel, accountId, conversationId}. We use taskId as conversationId so each
  // inbound message owns one conversation and outbound.sendText receives ctx.to as taskId.
  const bindingAdapter: SessionBindingAdapter = {
    channel: PLUGIN_ID,
    accountId,
    capabilities: {
      placements: ["current"],
      bindSupported: true,
      unbindSupported: true,
    },
    bind: async (input) => {
      const rec: SessionBindingRecord = {
        bindingId: randomUUID(),
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active",
        boundAt: Date.now(),
        expiresAt: input.ttlMs ? Date.now() + input.ttlMs : undefined,
        metadata: input.metadata,
      };
      const arr = bindingStore.get(input.targetSessionKey) ?? [];
      arr.push(rec);
      bindingStore.set(input.targetSessionKey, arr);

      const metadataTarget = readReplyTargetMetadata(input.metadata);
      const parentTarget = input.conversation.parentConversationId
        ? replyTargets.get(input.conversation.parentConversationId) ?? null
        : null;
      const target = metadataTarget
        ? completeReplyTarget(
          metadataTarget,
          parentTarget,
          lastInboundByTaskId.get(metadataTarget.taskId) ?? replyTargets.get(metadataTarget.taskId)?.source,
        )
        : parentTarget;
      if (target) {
        const fullTarget: ReplyTarget = {
          ...target,
          source: lastInboundByTaskId.get(target.taskId)
            ?? replyTargets.get(target.taskId)?.source,
        };
        rememberReplyTarget(replyTargets, input.conversation.conversationId, fullTarget);
        rememberReplyTarget(replyTargets, target.taskId, fullTarget);
        if (target.sessionKey) rememberReplyTarget(replyTargets, target.sessionKey, fullTarget);
      }
      return rec;
    },
    listBySession: (key) => bindingStore.get(key) ?? [],
    resolveByConversation: (ref: ConversationRef) => {
      for (const arr of bindingStore.values()) {
        for (const r of arr) {
          if (
            r.conversation.channel === ref.channel
            && r.conversation.accountId === ref.accountId
            && r.conversation.conversationId === ref.conversationId
          ) return r;
        }
      }
      return null;
    },
    unbind: async (input) => {
      const removed: SessionBindingRecord[] = [];
      if (input.targetSessionKey) {
        const arr = bindingStore.get(input.targetSessionKey) ?? [];
        const rest: SessionBindingRecord[] = [];
        for (const r of arr) {
          if (!input.bindingId || r.bindingId === input.bindingId) removed.push(r);
          else rest.push(r);
        }
        if (rest.length === 0) bindingStore.delete(input.targetSessionKey);
        else bindingStore.set(input.targetSessionKey, rest);
      } else if (input.bindingId) {
        for (const [key, arr] of bindingStore) {
          const rest = arr.filter((r) => {
            if (r.bindingId === input.bindingId) { removed.push(r); return false; }
            return true;
          });
          if (rest.length === 0) bindingStore.delete(key);
          else bindingStore.set(key, rest);
        }
      }
      return removed;
    },
  };
  registerSessionBindingAdapter(bindingAdapter);

  const session = new BotSession(
    {
      botToken: account.botToken,
      controlUrl: account.controlUrl,
      dataUrl: account.dataUrl,
      advanced: account.advanced,
    },
    {
      onReady: () => {
        log.info?.(`agentnexus: ${accountId} ready bot_id=${session.botId} memberships=${session.membership.channelIds.size}`);
        // ChannelAccountSnapshot shape; the gateway health monitor uses these fields for restart decisions.
        ctx.setStatus?.({
          accountId,
          enabled: true,
          configured: true,
          running: true,
          connected: true,
          lastConnectedAt: Date.now(),
        });
      },
      onChannelJoined: (ch, invitedBy) => {
        log.info?.(`agentnexus: ${accountId} joined ${ch.channel_id} invited_by=${invitedBy ?? "?"}`);
      },
      onChannelLeft: (cid, reason) => {
        log.info?.(`agentnexus: ${accountId} left ${cid} reason=${reason}`);
      },
      onMessage: async (m) => {
        const sk = sessionKeyFromInbound(accountId, m);
        const target = replyTargetFromInbound(accountId, m);
        rememberInbound(lastInboundBySessionKey, sk, m);
        rememberInbound(lastInboundByTaskId, m.event.task_id, m);
        rememberReplyTarget(replyTargets, m.event.task_id, target);
        rememberReplyTarget(replyTargets, sk, target);
        if (m.event.session?.task_scope_id) {
          rememberReplyTarget(replyTargets, String(m.event.session.task_scope_id), target);
        }
        const runtimeEntry = sessionRegistry.get(accountId);
        if (runtimeEntry) void startOutputFallbackWatcher(runtimeEntry, accountId, m, sk, log);
        log.info?.(
          `agentnexus: ${accountId} inbound channel=${m.channelId} task=${m.event.task_id} attachments=${m.attachments.length} text=${JSON.stringify(m.text).slice(0, 80)}`,
        );
        emitInboundTrace(session, accountId, sk, m, {
          phase: "received",
          title: "AgentNexus plugin received message",
          message: m.attachments.length > 0 ? `attachments=${m.attachments.length}` : undefined,
          data: { attachments: m.attachments.length },
        });

        // Self-loopback into the api.registerHttpRoute route. That handler runs
        // in gateway-request-scope and may legally call api.runtime.subagent.run.
        const ref = getSharedApi();
        if (!ref.api || !ref.gatewayPort || !ref.internalToken) {
          log.warn?.(
            `agentnexus: ${accountId} plugin api not registered yet; falling back to diagnostic reply`,
          );
          await session.reply({
            source: m,
            text: "[agentnexus plugin] 尚未注册 HTTP 路由，无法启动 agent turn。",
          }).catch(() => { /* ignore */ });
          return;
        }

        // Attachment body hydration: append each document body before subagent.run.
        const httpBase = deriveHttpBase(account.dataUrl);
        if (m.attachments.length > 0) {
          emitInboundTrace(session, accountId, sk, m, {
            phase: "hydrating_attachments",
            title: "Reading attachments",
            message: `${m.attachments.length} attachment(s)`,
            data: { attachments: m.attachments.length },
          });
        }
        const hydratedText = await buildMessageWithAttachments(httpBase, account.botToken, m, log);
        const agentPromptText = appendAgentNexusResponseContract(hydratedText);
        if (m.attachments.length > 0) {
          emitInboundTrace(session, accountId, sk, m, {
            phase: "attachments_ready",
            title: "Attachments ready",
            message: `prompt chars=${agentPromptText.length}`,
            data: { promptChars: agentPromptText.length },
          });
        }

        const url = `http://127.0.0.1:${ref.gatewayPort}/plugins/agentnexus/inbound`;
        try {
          emitInboundTrace(session, accountId, sk, m, {
            phase: "loopback_start",
            title: "Starting OpenClaw run",
          });
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "X-Agentnexus-Internal-Token": ref.internalToken,
          };
          if (ref.gatewayToken) {
            headers["Authorization"] = `Bearer ${ref.gatewayToken}`;
          }
          const resp = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              accountId,
              sessionKey: sk,
              channelId: m.channelId,
              taskId: m.event.task_id,
              placeholderMsgId: m.event.placeholder_msg_id,
              text: agentPromptText,
            }),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => "<unreadable>");
            log.warn?.(`agentnexus: ${accountId} inbound loopback failed HTTP ${resp.status}: ${body.slice(0, 200)}`);
            emitInboundTrace(session, accountId, sk, m, {
              phase: "loopback_error",
              status: "failed",
              title: "OpenClaw route failed",
              message: `HTTP ${resp.status}`,
            });
            await session.reply({
              source: m,
              text: `[agentnexus plugin] 内部路由 HTTP ${resp.status}: ${body.slice(0, 120)}`,
            }).catch(() => { /* ignore */ });
          } else {
            const accepted = await resp.json().catch(() => null) as { runId?: unknown } | null;
            const runId = typeof accepted?.runId === "string" ? accepted.runId : undefined;
            if (runId) {
              session.reportProviderSession({
                provider_session_key: sk,
                provider_session_id: runId,
                metadata: { provider: "openclaw", last_run_id: runId, task_id: m.event.task_id },
              });
            }
            emitInboundTrace(session, accountId, sk, m, {
              phase: "loopback_accepted",
              status: "running",
              title: "OpenClaw run accepted",
            });
          }
        } catch (err) {
          log.error?.(`agentnexus: ${accountId} inbound loopback error: ${String(err)}`);
          emitInboundTrace(session, accountId, sk, m, {
            phase: "loopback_error",
            status: "failed",
            title: "OpenClaw route error",
            message: String(err),
          });
          await session.reply({
            source: m,
            text: `[agentnexus plugin] 内部路由错误: ${String(err)}`,
          }).catch(() => { /* ignore */ });
        }
      },
      onCancel: (msgId, reason) => {
        // Frontend ⏹: server already finalized the placeholder with whatever
        // deltas had landed before the cancel. We just stop pushing more.
        const to = taskByPlaceholder.get(msgId);
        const slot = to ? pendingStreamByTo.get(to) : undefined;
      if (!to || !slot) {
        log.info?.(`agentnexus: ${accountId} cancel for unknown msg=${msgId} (already done?)`);
        return;
      }
        slot.cancelled = true;
        if (slot.doneTimer) {
          clearTimeout(slot.doneTimer);
          slot.doneTimer = null;
        }
        stopOutputFallbackWatcher(accountId, to);
        log.info?.(
          `agentnexus: ${accountId} cancel msg=${msgId} task=${to} reason=${reason ?? ""} chars=${slot.totalChars}`,
        );
        // NOTE: we don't currently abort the underlying subagent run — the
        // SDK doesn't expose a runId-based abort here, and the user-visible
        // effect is identical: further deltas / sendText calls are silently
        // dropped. Reclaiming that wasted compute is a follow-up.
      },
      onConnectionChange: (stream, state) => {
        log.info?.(`agentnexus: ${accountId} ${stream} ${state}`);
      },
      onFatal: (reason) => {
        log.error?.(`agentnexus: ${accountId} fatal: ${reason}`);
        ctx.setStatus?.({
          accountId,
          enabled: true,
          configured: true,
          running: false,
          connected: false,
          lastError: reason,
        });
      },
    },
  );

  sessionRegistry.set(accountId, {
    session,
    account,
    lastInboundBySessionKey,
    lastInboundByTaskId,
    replyTargets,
    bindingStore,
    bindingAdapter,
  });

  // The gateway treats the startAccount promise as the account lifecycle. If it
  // resolves or rejects, the account is considered stopped and auto-restarts
  // with exponential backoff. Keep awaiting until ctx.abortSignal fires, which
  // means stopAccount was called or the gateway is closing.
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      log.info?.(`agentnexus: ${accountId} abortSignal; stopping`);
      void session.stop();
      sessionRegistry.delete(accountId);
      clearRunTraceTargetsForAccount(accountId);
      clearOutputFallbackWatchersForAccount(accountId);
      resolve();
    };
    if (ctx.abortSignal?.aborted) {
      onAbort();
    } else {
      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }
    session.start();
  });
}

async function stopAccount(rawCtx: unknown): Promise<void> {
  const ctx = rawCtx as GatewayCtx;
  const entry = sessionRegistry.get(ctx.accountId);
  if (!entry) return;
  sessionRegistry.delete(ctx.accountId);
  clearRunTraceTargetsForAccount(ctx.accountId);
  clearOutputFallbackWatchersForAccount(ctx.accountId);
  try {
    unregisterSessionBindingAdapter({
      channel: PLUGIN_ID,
      accountId: ctx.accountId,
      adapter: entry.bindingAdapter,
    });
  } catch { /* ignore */ }
  await entry.session.stop();
}

// ============================================================================
// Outbound: OpenClaw agent → sendText / sendMedia → session.reply / send
// ============================================================================
//
// The OpenClaw gateway handles the MEDIA: protocol by extracting MEDIA lines,
// then serially calling handler.sendMedia(caption, mediaUrl, overrides). caption
// is non-empty only for the first call at index=0; later calls use caption="".
// Plain text payloads are sent as chunks through handler.sendText(text), not sendMedia.
//
// Key contract: the gateway reads delivery.messageId. sendMedia / sendText must
// return { channel, messageId, chatId? }; returning undefined makes the gateway
// throw "Cannot read properties of undefined".
//
// Strategy:
//   - sendMedia uploads to the AgentNexus bridge to obtain file_id, accumulates
//     files by `to` (= taskId) in pendingMediaByTo, and records the first caption.
//   - Each sendMedia arms a short debounce (500ms); after the last sendMedia,
//     the debounce flushes one session.reply/send(text=caption, fileIds=all).
//   - The gateway await chain does not wait for the debounce, so each call
//     immediately returns a synthetic messageId. The real msg_id is generated by
//     the bridge broadcast.

interface SendTextCtx {
  to: string;
  text: string;
  accountId?: string | null;
  cfg?: OpenClawConfig;
  [k: string]: unknown;
}

interface SendMediaCtx {
  to: string;
  /** Gateway runtime passes mediaUrl; older docs use filePath, so support both. */
  mediaUrl?: string;
  filePath?: string;
  /** sendMediaWithLeadingCaption passes caption at i=0 and undefined/"" for i>0. */
  text?: string;
  caption?: string;
  contentType?: string;
  filename?: string;
  accountId?: string | null;
  cfg?: OpenClawConfig;
  [k: string]: unknown;
}

interface SendTextResult {
  channel: string;
  messageId: string;
  chatId?: string;
}

/** sendMedia debounce delay before flushing accumulated media into one reply. */
const PENDING_MEDIA_DEBOUNCE_MS = 500;

/** Maximum media attachments per logical reply to prevent noisy bursts. */
const PENDING_MEDIA_CAP = 20;

/** sendText streaming debounce before done after the last chunk.
 *  Gateway sendText calls are synchronous and serial, usually less than 50ms
 *  apart. 500ms covers network jitter while still closing promptly after a
 *  natural LLM pause. */
const STREAM_DONE_DEBOUNCE_MS = 500;

/** Maximum characters per streaming reply before forced done and truncation. */
const STREAM_TEXT_CAP_CHARS = 200_000;

function latestRequestTail(text: string): string {
  return text.slice(Math.max(0, text.length - 2500));
}

function expectsConcreteDeliverable(sourceText: string): boolean {
  const tail = latestRequestTail(sourceText);
  return /Use the ["'][^"']+["'] skill/i.test(tail)
    || /(报告|调研|诊断|HTML|Markdown|附件|文件|请创建|生成.*报告|返回文件|deliverable|diagnostic report|research report|attachment|file)/i.test(tail);
}

function isLikelyProgressOnlyText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 320) return false;
  if (/MEDIA:\s*\S+/i.test(normalized)) return false;
  if (/<(?:!doctype|html|body|article|section|table)\b/i.test(normalized)) return false;
  if (/^\s{0,3}#{1,6}\s+\S/m.test(text) || /\|.+\|.+\|/.test(text)) return false;

  const startsLikeProgress = /^(正在|开始|准备|即将|接下来|我将|我会|让我|已经收集|已收集|已获取|已完成信息收集|报告已生成|已生成|Now I|Let me|I will|I'll|I'm going to|I have enough|Generating|Creating|Preparing)/i
    .test(normalized);
  const talksAboutWork = /(生成|创建|整理|分析|调研|诊断|报告|附件|文件|查找|收集|generate|create|prepare|diagnostic|report|attachment|file|collect|analy[sz]e)/i
    .test(normalized);
  return startsLikeProgress && talksAboutWork;
}

function shouldHoldStatusOnlyOutput(sourceText: string, outputText: string): boolean {
  return expectsConcreteDeliverable(sourceText) && isLikelyProgressOnlyText(outputText);
}

const OUTPUT_FALLBACK_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".json",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

const OUTPUT_FALLBACK_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

interface OutputFileInfo {
  path: string;
  filename: string;
  ext: string;
  size: number;
  mtimeMs: number;
}

interface OutputFileSeen {
  size: number;
  mtimeMs: number;
  stableSince: number;
}

interface OutputFallbackWatcher {
  accountId: string;
  taskId: string;
  sessionKey: string;
  source: InboundMessage;
  outputDirs: string[];
  startedAt: number;
  cfg: OutputFallbackConfig;
  baseline: Map<string, { size: number; mtimeMs: number }>;
  seen: Map<string, OutputFileSeen>;
  deliveredPaths: Set<string>;
  finishAfter?: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const outputFallbackWatchers = new Map<string, OutputFallbackWatcher>();

function outputFallbackKey(accountId: string, taskId: string): string {
  return `${accountId}:${taskId}`;
}

function agentIdFromSessionKey(sessionKey: string): string | null {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || null;
}

function candidateOutputDirs(cfg: OutputFallbackConfig, sessionKey: string): string[] {
  const dirs: string[] = [];
  for (const dir of cfg.outputDirs) {
    const trimmed = dir.trim();
    if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed);
  }
  const workspaceRoot = join(homedir(), ".openclaw", "workspace");
  const rootOutputDir = join(workspaceRoot, "output");
  if (!dirs.includes(rootOutputDir)) dirs.push(rootOutputDir);
  if (!dirs.includes(workspaceRoot)) dirs.push(workspaceRoot);
  const agentId = agentIdFromSessionKey(sessionKey);
  if (agentId) {
    const workspaceDir = join(workspaceRoot, agentId);
    const defaultDir = join(workspaceDir, "output");
    if (!dirs.includes(defaultDir)) dirs.push(defaultDir);
    if (!dirs.includes(workspaceDir)) dirs.push(workspaceDir);
  }
  return dirs;
}

function shouldIgnoreOutputName(name: string): boolean {
  return !name
    || name.startsWith(".")
    || name.endsWith(".tmp")
    || name.endsWith(".part")
    || name.endsWith(".crdownload")
    || name.endsWith("~");
}

async function collectOutputFiles(
  dirs: string[],
  cfg: OutputFallbackConfig,
  depth = 0,
): Promise<OutputFileInfo[]> {
  const out: OutputFileInfo[] = [];
  for (const dir of dirs) {
    if (out.length >= cfg.maxFiles) break;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= cfg.maxFiles) break;
      if (shouldIgnoreOutputName(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2 && !["node_modules", ".git", ".openclaw"].includes(entry.name)) {
          out.push(...await collectOutputFiles([fullPath], cfg, depth + 1));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!OUTPUT_FALLBACK_EXTENSIONS.has(ext)) continue;
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(fullPath);
      } catch {
        continue;
      }
      if (st.size < cfg.minBytes || st.size > cfg.maxBytes) continue;
      out.push({
        path: fullPath,
        filename: basename(fullPath),
        ext,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  const unique = Array.from(new Map(out.map((file) => [file.path, file])).values());
  unique.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return unique.slice(0, cfg.maxFiles);
}

async function buildOutputBaseline(
  dirs: string[],
  cfg: OutputFallbackConfig,
): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const baseline = new Map<string, { size: number; mtimeMs: number }>();
  for (const file of await collectOutputFiles(dirs, cfg)) {
    baseline.set(file.path, { size: file.size, mtimeMs: file.mtimeMs });
  }
  return baseline;
}

function isNewOutputFile(watcher: OutputFallbackWatcher, file: OutputFileInfo): boolean {
  if (file.mtimeMs < watcher.startedAt - 5_000) return false;
  const baseline = watcher.baseline.get(file.path);
  if (!baseline) return true;
  return file.size !== baseline.size || file.mtimeMs > baseline.mtimeMs + 1;
}

async function isCompleteOutputFile(file: OutputFileInfo): Promise<boolean> {
  if (file.ext === ".html" || file.ext === ".htm") {
    try {
      const text = await readFile(file.path, "utf8");
      return /<\/(?:body|html)>\s*$/i.test(text.trim());
    } catch {
      return false;
    }
  }
  if (file.ext === ".json") {
    try {
      JSON.parse(await readFile(file.path, "utf8"));
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

async function attachOutputFallbackFile(
  watcher: OutputFallbackWatcher,
  entry: AccountRuntime,
  file: OutputFileInfo,
  log?: PluginLogger,
): Promise<boolean> {
  const contentType = OUTPUT_FALLBACK_CONTENT_TYPES[file.ext] ?? "application/octet-stream";
  const result = await sendMedia({
    to: watcher.taskId,
    text: `已生成文件，请查收附件：${file.filename}`,
    mediaUrl: file.path,
    filename: file.filename,
    contentType,
    accountId: watcher.accountId,
  });
  if (!result.messageId) return false;
  log?.info?.(
    `agentnexus: output fallback attached task=${watcher.taskId} file=${file.path} size=${file.size}`,
  );
  emitRunTrace(watcher.taskId, {
    stream: "agentnexus_plugin",
    ts: Date.now(),
    phase: "output_fallback_attached",
    status: "completed",
    title: "Output file attached",
    message: file.filename,
    data: { path: file.path, size: file.size },
  });
  return true;
}

function scheduleOutputFallbackPoll(
  key: string,
  entry: AccountRuntime,
  log?: PluginLogger,
): void {
  const watcher = outputFallbackWatchers.get(key);
  if (!watcher) return;
  if (watcher.timer) clearTimeout(watcher.timer);
  watcher.timer = setTimeout(() => {
    pollOutputFallbackWatcher(key, entry, log).catch((err) => {
      log?.warn?.(`agentnexus: output fallback watcher failed task=${watcher.taskId}: ${String(err)}`);
      scheduleOutputFallbackPoll(key, entry, log);
    });
  }, watcher.cfg.pollMs);
}

async function pollOutputFallbackWatcher(
  key: string,
  entry: AccountRuntime,
  log?: PluginLogger,
): Promise<void> {
  const watcher = outputFallbackWatchers.get(key);
  if (!watcher) return;
  const now = Date.now();
  if (now - watcher.startedAt > watcher.cfg.maxWatchMs) {
    stopOutputFallbackWatcher(watcher.accountId, watcher.taskId);
    return;
  }
  if (watcher.finishAfter && now > watcher.finishAfter) {
    stopOutputFallbackWatcher(watcher.accountId, watcher.taskId);
    return;
  }

  const files = await collectOutputFiles(watcher.outputDirs, watcher.cfg);
  for (const file of files) {
    if (watcher.deliveredPaths.has(file.path) || !isNewOutputFile(watcher, file)) continue;
    const previous = watcher.seen.get(file.path);
    const stableSince = previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs
      ? previous.stableSince
      : now;
    watcher.seen.set(file.path, {
      size: file.size,
      mtimeMs: file.mtimeMs,
      stableSince,
    });
    const streamStillOpen = pendingStreamByTo.has(watcher.taskId);
    if (!streamStillOpen && now - watcher.startedAt < watcher.cfg.delayMs) continue;
    if (now - stableSince < watcher.cfg.stableMs) continue;
    if (!await isCompleteOutputFile(file)) continue;

    watcher.deliveredPaths.add(file.path);
    if (await attachOutputFallbackFile(watcher, entry, file, log)) {
      stopOutputFallbackWatcher(watcher.accountId, watcher.taskId);
      return;
    }
  }
  scheduleOutputFallbackPoll(key, entry, log);
}

async function startOutputFallbackWatcher(
  entry: AccountRuntime,
  accountId: string,
  source: InboundMessage,
  sessionKey: string,
  log?: PluginLogger,
): Promise<void> {
  if (!source.event.placeholder_msg_id) return;
  if (!expectsConcreteDeliverable(source.text)) return;
  const cfg = entry.account.outputFallback ?? resolveOutputFallbackConfig();
  if (!cfg.enabled) return;
  const outputDirs = candidateOutputDirs(cfg, sessionKey);
  if (outputDirs.length === 0) return;

  const key = outputFallbackKey(accountId, source.event.task_id);
  stopOutputFallbackWatcher(accountId, source.event.task_id);
  const watcher: OutputFallbackWatcher = {
    accountId,
    taskId: source.event.task_id,
    sessionKey,
    source,
    outputDirs,
    startedAt: Date.now(),
    cfg,
    baseline: new Map(),
    seen: new Map(),
    deliveredPaths: new Set(),
    timer: null,
  };
  outputFallbackWatchers.set(key, watcher);
  try {
    watcher.baseline = await buildOutputBaseline(outputDirs, cfg);
  } catch (err) {
    log?.warn?.(`agentnexus: output fallback baseline failed task=${source.event.task_id}: ${String(err)}`);
  }
  const current = outputFallbackWatchers.get(key);
  if (!current) return;
  log?.debug?.(
    `agentnexus: output fallback watching task=${current.taskId} dirs=${outputDirs.join(",")}`,
  );
  scheduleOutputFallbackPoll(key, entry, log);
}

function stopOutputFallbackWatcher(accountId: string | null | undefined, taskId: string): void {
  if (!accountId || !taskId) return;
  const key = outputFallbackKey(accountId, taskId);
  const watcher = outputFallbackWatchers.get(key);
  if (!watcher) return;
  if (watcher.timer) clearTimeout(watcher.timer);
  outputFallbackWatchers.delete(key);
}

function outputFallbackSettleMs(cfg: OutputFallbackConfig): number {
  return Math.max(cfg.postStreamWatchMs, cfg.stableMs + cfg.pollMs);
}

function deferStreamDoneForOutputFallback(
  accountId: string | null | undefined,
  taskId: string,
): number | null {
  if (!accountId || !taskId) return null;
  const watcher = outputFallbackWatchers.get(outputFallbackKey(accountId, taskId));
  if (!watcher) return null;
  const now = Date.now();
  if (!watcher.finishAfter) {
    watcher.finishAfter = now + outputFallbackSettleMs(watcher.cfg);
  }
  return now < watcher.finishAfter ? watcher.finishAfter - now : null;
}

function clearOutputFallbackWatchersForAccount(accountId: string): void {
  for (const watcher of Array.from(outputFallbackWatchers.values())) {
    if (watcher.accountId === accountId) stopOutputFallbackWatcher(accountId, watcher.taskId);
  }
}

interface PendingStreamSlot {
  /** Inbound message that triggered this stream; used for fallback to session.reply. */
  source: InboundMessage;
  /** Placeholder msg_id required by the server; null means stream is unavailable. */
  placeholderMsgId: string | null;
  /** Accumulated character count; forces done at STREAM_TEXT_CAP_CHARS. */
  totalChars: number;
  /** Monotonically increasing delta seq. */
  seq: number;
  /** User has canceled; later sendText calls push no delta and no done. */
  cancelled: boolean;
  /** Whether at least one delta was pushed. This controls done debounce startup
   *  and edge cases such as sending done for all-empty sendText calls. */
  hasDeltas: boolean;
  /** file_ids accumulated during sendMedia. The done frame sends them to the
   *  server so finalize_stream merges them into the placeholder file_ids. */
  fileIds: string[];
  /** First progress-like status text held until real body text or files appear. */
  heldStatusText: string;
  doneTimer: ReturnType<typeof setTimeout> | null;
}

/** key = ctx.to, which equals taskId on the deliver path. Used for stream aggregation and cancel lookup. */
const pendingStreamByTo = new Map<string, PendingStreamSlot>();

/** key = placeholderMsgId -> ctx.to. Control WS cancel frames only know msg_id, so this maps back to the stream slot. */
const taskByPlaceholder = new Map<string, string>();

interface PendingMediaSlot {
  fileIds: string[];
  /** Payload text captured from the first sendMedia call with non-empty caption. */
  caption: string;
  /** channelId resolved during upload and reused during flush. */
  channelId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** key = ctx.to, which equals taskId on the deliver path. AccountRuntime does not
 *  carry this field, so it lives at module scope. `to` (= taskId) is globally unique across accounts. */
const pendingMediaByTo = new Map<string, PendingMediaSlot>();

async function uploadBotBinaryFile(
  session: BotSession,
  channelId: string,
  filename: string,
  data: Uint8Array,
  contentType?: string,
): Promise<string | null> {
  // Use embedded file_upload frames on data WS instead of HTTP /files/upload-binary.
  try {
    const ack = await session.uploadFile({
      channelId, filename, data, contentType,
    });
    if (ack.ok) return ack.file_id;
    return null;
  } catch {
    return null;
  }
}

/** Read filePath as a local path or http(s) URL. Return bytes, filename, and contentType, or null on failure. */
async function readMediaSource(
  filePath: string, explicitFilename?: string, explicitContentType?: string,
): Promise<{ bytes: Uint8Array; filename: string; contentType: string } | null> {
  const isUrl = /^https?:\/\//i.test(filePath);
  if (isUrl) {
    try {
      const resp = await fetch(filePath, {
        signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      const urlObj = new URL(filePath);
      const urlName = urlObj.pathname.split("/").filter(Boolean).pop() || "download";
      return {
        bytes: buf,
        filename: explicitFilename || urlName,
        contentType: explicitContentType
          || (resp.headers.get("content-type") || "").split(";")[0].trim()
          || "application/octet-stream",
      };
    } catch {
      return null;
    }
  }
  // Local path.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    const bytes = await fs.readFile(filePath);
    return {
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      filename: explicitFilename || path.basename(filePath) || "media",
      contentType: explicitContentType || "application/octet-stream",
    };
  } catch {
    return null;
  }
}

async function maybeAutoAttachReplyAsFile(
  entry: AccountRuntime, channelId: string, text: string,
): Promise<string[] | undefined> {
  if (text.length < AUTO_ATTACH_THRESHOLD_CHARS) return undefined;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileId = await uploadBotMarkdownFile(
    entry.session, channelId, `reply-${ts}.md`, text,
  );
  return fileId ? [fileId] : undefined;
}

function resolveActiveEntry(accountId?: string | null): { accountId: string; entry: AccountRuntime } {
  const resolvedId = accountId ?? Array.from(sessionRegistry.keys())[0];
  if (!resolvedId) throw new Error("agentnexus: no active account");
  const entry = sessionRegistry.get(resolvedId);
  if (!entry) throw new Error(`agentnexus: no running session for account ${resolvedId}`);
  return { accountId: resolvedId, entry };
}

/** Debounced flush that sends accumulated fileIds + caption for `to` as one reply/send. */
async function flushPendingMedia(to: string, entry: AccountRuntime): Promise<void> {
  const slot = pendingMediaByTo.get(to);
  if (!slot) return;
  if (slot.timer) clearTimeout(slot.timer);
  pendingMediaByTo.delete(to);
  if (slot.fileIds.length === 0) return;

  const { session, lastInboundByTaskId, lastInboundBySessionKey } = entry;
  const target = resolveReplyTarget(entry, to);
  const source = sourceForReplyTarget(entry, target, to);
  if (source) {
    lastInboundByTaskId.delete(source.event.task_id);
    forgetInboundBySessionKey(lastInboundBySessionKey, entry.account.accountId ?? "", source);
    await session.reply({ source, text: slot.caption, fileIds: slot.fileIds });
    return;
  }
  // Source was consumed by another flow; try proactive send to the resolved channel if the bot is a member.
  if (session.membership.channelIds.has(slot.channelId)) {
    await session.send({ channelId: slot.channelId, text: slot.caption, fileIds: slot.fileIds });
  }
}

async function sendMedia(ctx: SendMediaCtx): Promise<SendTextResult> {
  const { accountId, entry } = resolveActiveEntry(ctx.accountId);
  const { session, lastInboundByTaskId, lastInboundBySessionKey } = entry;
  const target = resolveReplyTarget(entry, ctx.to);
  const streamKey = target?.taskId ?? ctx.to;

  // Gateway runtime passes mediaUrl; older docs use filePath, so support both.
  const mediaUrl = ctx.mediaUrl || ctx.filePath || "";
  // sendMediaWithLeadingCaption passes caption (= payload text) at index=0 and
  // undefined/"" after that. Capture the first non-empty caption as final reply text.
  const caption = ((ctx.text ?? ctx.caption) ?? "").toString();

  // Resolve channelId without consuming inbound source. Upload may fail, and
  // losing source would prevent later sendText/sendMedia from using streaming.
  const existingSlot = pendingStreamByTo.get(streamKey);
  const peekedSource = existingSlot ? null : sourceForReplyTarget(entry, target, ctx.to);
  const channelId = existingSlot?.source.channelId
    ?? target?.channelId
    ?? peekedSource?.channelId
    ?? (session.membership.channelIds.has(ctx.to) ? ctx.to : null);
  if (!channelId || !mediaUrl) {
    return { channel: PLUGIN_ID, messageId: "", chatId: channelId ?? "" };
  }

  const media = await readMediaSource(mediaUrl, ctx.filename, ctx.contentType);
  if (!media) {
    return { channel: PLUGIN_ID, messageId: "", chatId: channelId };
  }

  const fileId = await uploadBotBinaryFile(
    session,
    channelId,
    media.filename,
    media.bytes,
    media.contentType,
  );
  if (!fileId) {
    return { channel: PLUGIN_ID, messageId: "", chatId: channelId };
  }

  // Upload succeeded — *now* it's safe to consume the inbound source and
  // promote it into a stream slot.
  let slot = existingSlot;
  if (!slot && peekedSource) {
    lastInboundByTaskId.delete(peekedSource.event.task_id);
    forgetInboundBySessionKey(lastInboundBySessionKey, accountId, peekedSource);
    const placeholder = target?.placeholderMsgId ?? peekedSource.event.placeholder_msg_id ?? null;
    slot = {
      source: peekedSource,
      placeholderMsgId: placeholder,
      totalChars: 0,
      seq: 0,
      cancelled: false,
      hasDeltas: false,
      fileIds: [],
      heldStatusText: "",
      doneTimer: null,
    };
    pendingStreamByTo.set(streamKey, slot);
    if (placeholder) taskByPlaceholder.set(placeholder, streamKey);
  }

  // Main path: add fileId to the stream slot and share one done with sendText deltas.
  if (slot && slot.placeholderMsgId && !slot.cancelled) {
    if (slot.fileIds.length < PENDING_MEDIA_CAP) slot.fileIds.push(fileId);
    // First sendMedia caption (= full text): if no sendText delta has streamed,
    // push it as one delta so the frontend can show text before adding files.
    // Do not duplicate it after sendText has already streamed; gateway caption
    // would duplicate the sendText total.
    if (caption && !slot.hasDeltas) {
      slot.seq += 1;
      slot.totalChars += caption.length;
      slot.hasDeltas = true;
      session.streamDelta({ msgId: slot.placeholderMsgId, seq: slot.seq, delta: caption });
    }
    armStreamDoneTimer(streamKey, entry, slot);
    return {
      channel: PLUGIN_ID,
      messageId: `${slot.placeholderMsgId}-f${slot.fileIds.length}`,
      chatId: channelId,
    };
  }

  // Fallback: source-less broadcast or unavailable stream slot -> old pendingMediaByTo debounce.
  let mslot = pendingMediaByTo.get(ctx.to);
  if (!mslot) {
    mslot = { fileIds: [], caption: "", channelId, timer: null };
    pendingMediaByTo.set(ctx.to, mslot);
  }
  if (mslot.fileIds.length < PENDING_MEDIA_CAP) mslot.fileIds.push(fileId);
  if (caption && !mslot.caption) mslot.caption = caption;

  if (mslot.timer) clearTimeout(mslot.timer);
  mslot.timer = setTimeout(() => {
    flushPendingMedia(ctx.to, entry).catch(() => { /* swallow */ });
  }, PENDING_MEDIA_DEBOUNCE_MS);

  return {
    channel: PLUGIN_ID,
    messageId: `pending-media-${ctx.to}-${fileId.slice(0, 8)}`,
    chatId: channelId,
  };
}

/** Schedule (or reschedule) the `done` frame for a stream. Called after every
 *  delta — whichever sendText is the *last* one will be the one that fires. */
function armStreamDoneTimer(
  to: string,
  entry: AccountRuntime,
  slot: PendingStreamSlot,
  delayMs = STREAM_DONE_DEBOUNCE_MS,
): void {
  if (slot.doneTimer) clearTimeout(slot.doneTimer);
  slot.doneTimer = setTimeout(() => {
    flushStreamDone(to, entry).catch(() => { /* swallow */ });
  }, delayMs);
}

/** Send `done` and clean up. Idempotent; safe to call after cancel. */
async function flushStreamDone(to: string, entry: AccountRuntime): Promise<void> {
  const slot = pendingStreamByTo.get(to);
  if (!slot) return;
  if (slot.doneTimer) {
    clearTimeout(slot.doneTimer);
    slot.doneTimer = null;
  }

  const accountId = entry.account.accountId;
  if (!slot.cancelled && slot.fileIds.length === 0) {
    const deferredMs = deferStreamDoneForOutputFallback(accountId, slot.source.event.task_id);
    if (deferredMs !== null) {
      armStreamDoneTimer(to, entry, slot, Math.max(50, deferredMs));
      return;
    }
  }

  pendingStreamByTo.delete(to);
  if (slot.placeholderMsgId) taskByPlaceholder.delete(slot.placeholderMsgId);

  // Cancelled streams: server already finalized partial when it pushed the
  // cancel frame to us. We deliberately do NOT send `done` again; the server
  // would no-op on it but skipping the round-trip is cleaner.
  if (slot.cancelled) {
    stopOutputFallbackWatcher(accountId, slot.source.event.task_id);
    return;
  }

  if (slot.placeholderMsgId && (slot.hasDeltas || slot.fileIds.length > 0)) {
    entry.session.streamDone({
      msgId: slot.placeholderMsgId,
      fileIds: slot.fileIds.length > 0 ? slot.fileIds : undefined,
    });
    stopOutputFallbackWatcher(accountId, slot.source.event.task_id);
    return;
  }

  // No deltas and no files — agent produced nothing for this `to`. Drop the
  // stream silently; the placeholder will be finalized by orchestrator timeout.
  stopOutputFallbackWatcher(accountId, slot.source.event.task_id);
}

/** Main sendText path: push each call as one delta and send done after debounce.
 *
 *  Why this works: gateway deliver:true calls sendText repeatedly with agent
 *  output chunks, typically less than 50ms apart. Compared with one-shot reply:
 *    - Users see token-by-token rendering in the browser.
 *    - When the user clicks stop, control WS pushes cancel and we stop deltas.
 *    - The server finalizes the partial reply from the current buffer at cancel
 *      time, so a still-running agent no longer affects the frontend.
 *
 *  Fallback: if inbound source / placeholderMsgId is unavailable or data WS is
 *  not writable, fall back to the old one-shot session.reply path. */
async function sendText(ctx: SendTextCtx): Promise<SendTextResult> {
  const { accountId, entry } = resolveActiveEntry(ctx.accountId);
  const { session, lastInboundBySessionKey, lastInboundByTaskId } = entry;
  const target = resolveReplyTarget(entry, ctx.to);
  const streamKey = target?.taskId ?? ctx.to;

  let slot = pendingStreamByTo.get(streamKey);

  if (!slot) {
    // First chunk for this `to`. Locate the inbound source so we have a
    // placeholder to stream against (and a fallback target if streaming
    // turns out to be unusable).
    const source = sourceForReplyTarget(entry, target, ctx.to);
    if (!source) {
      // Non-reactive send: keep the previous proactive channel send behavior instead of streaming.
      const channelId = ctx.to;
      if (!session.membership.channelIds.has(channelId)) {
        throw new Error(`agentnexus: bot not in channel ${channelId} (to=${ctx.to})`);
      }
      const fileIds = await maybeAutoAttachReplyAsFile(entry, channelId, ctx.text);
      const r = await session.send({ channelId, text: ctx.text, fileIds });
      if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, chatId: channelId };
      throw new Error(`agentnexus: session.send failed (${r.code ?? "?"} ${r.error ?? ""})`);
    }

    // Consume the inbound source so subsequent sendText calls won't try to
    // restart the stream — once the slot exists we keep accumulating into it.
    lastInboundByTaskId.delete(source.event.task_id);
    forgetInboundBySessionKey(lastInboundBySessionKey, accountId, source);

    const placeholder = target?.placeholderMsgId ?? source.event.placeholder_msg_id ?? null;
    slot = {
      source,
      placeholderMsgId: placeholder,
      totalChars: 0,
      seq: 0,
      cancelled: false,
      hasDeltas: false,
      fileIds: [],
      heldStatusText: "",
      doneTimer: null,
    };
    pendingStreamByTo.set(streamKey, slot);
    if (placeholder) taskByPlaceholder.set(placeholder, streamKey);
  }

  // Cancelled mid-stream: drop further deltas silently. Returning a
  // "messageId" keeps the gateway happy.
  if (slot.cancelled) {
    return {
      channel: PLUGIN_ID,
      messageId: `cancelled-${streamKey}`,
      chatId: slot.source.channelId,
    };
  }

  // No placeholder available → can't stream. Degrade to one-shot reply on the
  // first chunk, and turn the slot into a "no-op" sink so subsequent chunks
  // are dropped (gateway will keep calling sendText, but we already replied).
  if (!slot.placeholderMsgId) {
    if (slot.hasDeltas) {
      // Already replied once for this `to`; ignore subsequent chunks.
      return {
        channel: PLUGIN_ID,
        messageId: `dup-${streamKey}`,
        chatId: slot.source.channelId,
      };
    }
    slot.hasDeltas = true;
    const fileIds = await maybeAutoAttachReplyAsFile(entry, slot.source.channelId, ctx.text);
    const r = await session.reply({ source: slot.source, text: ctx.text, fileIds });
    pendingStreamByTo.delete(streamKey);
    stopOutputFallbackWatcher(accountId, slot.source.event.task_id);
    if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, chatId: slot.source.channelId };
    throw new Error(`agentnexus: session.reply failed (${r.code ?? "?"} ${r.error ?? ""})`);
  }

  const incoming = ctx.text || "";
  if (!slot.hasDeltas && slot.fileIds.length === 0) {
    const heldCandidate = `${slot.heldStatusText}${incoming}`;
    if (shouldHoldStatusOnlyOutput(slot.source.text, heldCandidate)) {
      slot.heldStatusText = heldCandidate.slice(0, 2000);
      // Status text is not a final reply. Hold silently so the AgentNexus
      // foreground wait timer can turn the placeholder into a background task.
      // Later OpenClaw body text or MEDIA still writes to the same stream slot
      // and eventually updates that task message.
      return {
        channel: PLUGIN_ID,
        messageId: `${slot.placeholderMsgId}-held-status`,
        chatId: slot.source.channelId,
      };
    }
    if (slot.heldStatusText) slot.heldStatusText = "";
  }

  // Cap protection: once we've streamed enough, force a done and refuse more.
  if (slot.totalChars >= STREAM_TEXT_CAP_CHARS) {
    if (slot.placeholderMsgId) {
      session.streamDone({ msgId: slot.placeholderMsgId });
    }
    pendingStreamByTo.delete(streamKey);
    if (slot.placeholderMsgId) taskByPlaceholder.delete(slot.placeholderMsgId);
    stopOutputFallbackWatcher(accountId, slot.source.event.task_id);
    return {
      channel: PLUGIN_ID,
      messageId: `truncated-${streamKey}`,
      chatId: slot.source.channelId,
    };
  }

  // Happy path: push the delta, arm the done timer.
  slot.seq += 1;
  slot.totalChars += incoming.length;
  slot.hasDeltas = true;
  const ok = session.streamDelta({
    msgId: slot.placeholderMsgId,
    seq: slot.seq,
    delta: incoming,
  });
  if (!ok) {
    // data WS dropped between chunks — abandon the stream and fall back to a
    // single reply with everything we have. We don't have the prior chunks
    // (they went out as deltas), so just send this one as a reply and stop.
    pendingStreamByTo.delete(streamKey);
    if (slot.placeholderMsgId) taskByPlaceholder.delete(slot.placeholderMsgId);
    stopOutputFallbackWatcher(accountId, slot.source.event.task_id);
    const fileIds = await maybeAutoAttachReplyAsFile(entry, slot.source.channelId, incoming);
    const r = await session.reply({ source: slot.source, text: incoming, fileIds });
    if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, chatId: slot.source.channelId };
    throw new Error(`agentnexus: session.reply failed (${r.code ?? "?"} ${r.error ?? ""})`);
  }
  armStreamDoneTimer(streamKey, entry, slot);
  return {
    channel: PLUGIN_ID,
    messageId: `${slot.placeholderMsgId}-d${slot.seq}`,
    chatId: slot.source.channelId,
  };
}

// ============================================================================
// Plugin object.
// ============================================================================

const base = createChannelPluginBase<ResolvedAccount>({
  id: PLUGIN_ID,
  meta: {
    id: PLUGIN_ID,
    label: "AgentNexus",
    selectionLabel: "AgentNexus (per-bot WebSocket bridge)",
    blurb: "Slack-like multi-channel chat with bots.",
    docsPath: "/channels/agentnexus",
  },
  capabilities: {
    chatTypes: ["group"],
    threads: true,
    reply: true,
    media: true,
  },
  setup: {
    resolveAccount,
    inspectAccount,
  },
  config: {
    listAccountIds: (cfg) => Object.keys(getAccountsFromCfg(cfg)),
    resolveAccount,
    inspectAccount,
  },
});

// base does not connect to gateway directly, so spread it back in here.
const baseWithGateway: ChannelPlugin<ResolvedAccount> = {
  ...base,
  gateway: {
    startAccount,
    stopAccount,
    // resolveGatewayAuthBypassPaths only applies to bundled plugins. External
    // linked plugins use api.config.gateway.auth.token for self-loopback gateway
    // auth, then the handler's internalToken provides forgery protection.
  },
};

const chatPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: baseWithGateway,
  security: {
    dm: {
      channelKey: PLUGIN_ID,
      resolvePolicy: (account: ResolvedAccount) => account.dmPolicy,
      resolveAllowFrom: (account: ResolvedAccount) => account.allowFrom,
      defaultPolicy: "open",
    },
  },
  threading: { topLevelReplyToMode: "reply" },
  outbound: {
    // Follow official channel plugins such as @openclaw/synology-chat: put
    // sendText directly at outbound top level with deliveryMode="gateway".
    // attachedResults in official docs is a higher-level API for returning
    // messageId to attachment binding, not the deliver path.
    deliveryMode: "gateway",
    sendText,
    sendMedia,
    // Official sdk-channel-plugins examples place sendMedia under outbound.base.
    // Declare it both at top level and under base for gateway lookup compatibility.
    base: { sendMedia },
  },
});

// Add a status adapter used by the gateway health monitor for auto-restart
// decisions. The default implementation treats self-managed long-lived WS
// connections as stale sockets, so opt out directly.
(chatPlugin as { status?: unknown }).status = {
  skipStaleSocketHealthCheck: true,
  defaultRuntime: {
    accountId: "",
    enabled: true,
    configured: true,
    running: true,
    connected: true,
  },
};

export const agentnexusPlugin: ChannelPlugin<ResolvedAccount> = chatPlugin;

// test hooks
export const __testonly = {
  sessionRegistry,
  sendText,
  sendMedia,
  pendingMediaByTo,
  flushPendingMedia,
  pendingStreamByTo,
  taskByPlaceholder,
  flushStreamDone,
  STREAM_DONE_DEBOUNCE_MS,
  STREAM_TEXT_CAP_CHARS,
  appendAgentNexusResponseContract,
  shouldHoldStatusOnlyOutput,
  startOutputFallbackWatcher,
  stopOutputFallbackWatcher,
  pollOutputFallbackWatcher,
  outputFallbackWatchers,
  resolveOutputFallbackConfig,
  isCompleteOutputFile,
  notifyOpenClawRunTerminal,
  registerOpenClawRunTrace,
};
