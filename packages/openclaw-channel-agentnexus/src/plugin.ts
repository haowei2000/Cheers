/**
 * agentnexus channel plugin —— OpenClaw 官方 SDK 契约版（channel-core）
 *
 * 按 docs.openclaw.ai/plugins/sdk-channel-plugins 的 createChatChannelPlugin
 * + createChannelPluginBase 模式构建；entry 文件里 registerFull 注册 HTTP 路由，
 * WS 入站时自 loopback 到该路由进入 gateway-request-scope，合法调用
 * api.runtime.subagent.run。agent 产出经 outbound.sendText 回推 → session.reply
 * 原地 finalize AgentNexus 侧占位消息。
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

// ============================================================================
// 附件正文 hydration —— 用 bot token 向 AgentNexus 的 bridge 读出 markdown，
// 注入到 subagent.run 的 message 前置，解决 "agent 只能看 3 行摘要" 的问题
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

/** backend 卡住不应把 WS 消息环节顶住，设一个上限超时。 */
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

/** agent 回复超过此字符阈值时，自动把正文上传为 .md 附件挂到 reply 上。 */
const AUTO_ATTACH_THRESHOLD_CHARS = 4000;

interface OutputFallbackConfig {
  enabled: boolean;
  outputDirs: string[];
  delayMs: number;
  pollMs: number;
  stableMs: number;
  maxWatchMs: number;
  maxFiles: number;
  minBytes: number;
  maxBytes: number;
}

type RawOutputFallbackConfig = Partial<OutputFallbackConfig>;

const DEFAULT_OUTPUT_FALLBACK: OutputFallbackConfig = {
  enabled: true,
  outputDirs: [],
  // AgentNexus defaults to converting Agent Bridge placeholders after 60s.
  // Wait a touch longer so this fallback only speaks once the reply is a task.
  delayMs: 65_000,
  pollMs: 2_000,
  stableMs: 6_000,
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
    maxWatchMs: normalizePositiveInt(raw?.maxWatchMs, base.maxWatchMs),
    maxFiles: normalizePositiveInt(raw?.maxFiles, base.maxFiles),
    minBytes: normalizePositiveInt(raw?.minBytes, base.minBytes),
    maxBytes: normalizePositiveInt(raw?.maxBytes, base.maxBytes),
  };
}

/** 入站到 OpenClaw agent 前追加的交付契约：防止模型只回“正在生成…”。 */
const AGENTNEXUS_RESPONSE_CONTRACT = `

<agentnexus_response_contract>
  <final_output_required>true</final_output_required>
  <rules>
    <rule>不要把“正在生成/我将生成/Let me generate/Now I have enough info”等进度句作为最终回复。</rule>
    <rule>如果任务要求报告、HTML、Markdown、附件或文件，请实际创建可交付文件，并用 MEDIA:/absolute/path 返回，或直接输出完整正文。</rule>
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
  // 复用同一条 file_upload 帧：把 markdown 文本当二进制发，contentType=text/markdown。
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
// ResolvedAccount —— 由 config 解析得出，供 gateway / outbound 等 adapter 使用
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
    // 找不到账号时返回一个"占位"账号；SDK 会按 inspectAccount 去校验是否 configured
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
        sendAckTimeoutMs: 10000,
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
      sendAckTimeoutMs: raw.advanced?.sendAckTimeoutMs ?? 10000,
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
// SessionRegistry —— 每个 live account 的 BotSession + inbound 消息缓存
// ============================================================================

interface AccountRuntime {
  session: BotSession;
  account: ResolvedAccount;
  /** sessionKey → 最近一次 inbound（独立模式 / 调试时仍可用） */
  lastInboundBySessionKey: Map<string, InboundMessage>;
  /** taskId → inbound。session-binding 把 conversationId=taskId 绑到 sessionKey，
   *  deliver 回来时 ctx.to === taskId，据此找回源消息做 session.reply。 */
  lastInboundByTaskId: Map<string, InboundMessage>;
  /** conversation/task/child id → AgentNexus reply target.
   *
   * OpenClaw child runs may deliver outbound chunks with ctx.to equal to a
   * child conversation id rather than the original AgentNexus task_id. This
   * map keeps all of those aliases pinned to the original placeholder. */
  replyTargets: Map<string, ReplyTarget>;
  /** SessionBindingAdapter 的内存 store（sessionKey → records） */
  bindingStore: Map<string, SessionBindingRecord[]>;
  /** 给 stopAccount 解除注册用 */
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
// Plugin API 共享 —— registerFull 里把 api 存到这里，onMessage 里通过 fetch
// 把消息 bounce 到 api.registerHttpRoute 注册的路由，从而进入 request scope
// ============================================================================

interface SharedApiRef {
  api: OpenClawPluginApi | null;
  gatewayPort: number | null;
  internalToken: string | null;  // 自 loopback 的防护 token
  gatewayToken: string | null;   // OpenClaw gateway 外层 token-auth
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

  // 注册 SessionBindingAdapter：deliver:true 靠这个把 sessionKey 路由到
  // {channel, accountId, conversationId}。conversationId 我们用 taskId，
  // 这样每条入站消息独占一个 conversation；outbound.sendText 拿到的 ctx.to 就是 taskId。
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
        // ChannelAccountSnapshot 形状 —— gateway health monitor 依据这些字段判断是否需要重启
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

        // 自 loopback 到 api.registerHttpRoute 的路由：那个 handler 运行在
        // gateway-request-scope，可以合法调 api.runtime.subagent.run
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

        // 附件正文 hydration：在进入 subagent.run 前把每个文档正文拼进 message
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

  // gateway 把 startAccount 的 Promise 视作"账号生命周期"，只要它 resolve/reject
  // 就认为账号停了，立刻按指数退避 auto-restart。所以这里必须一直 await 直到
  // ctx.abortSignal 触发（= stopAccount 被调用 / gateway 关闭）。
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
// OpenClaw gateway (deliver-BNvlWd4P.js) 对 MEDIA: 协议的处理是在 gateway
// 侧先抽出 MEDIA 行，然后按 handler.sendMedia(caption, mediaUrl, overrides)
// 串行调用 —— caption 只在 index=0 的首次调用里非空，其余调用 caption=""。
// 纯文本 payload 走 handler.sendText(text) 分片发送，不走 sendMedia。
//
// 关键合约（gateway 读 delivery.messageId）：
//   sendMedia / sendText 必须返回 { channel, messageId, chatId? }，
//   返回 undefined 会导致 gateway "Cannot read properties of undefined".
//
// 我们的策略：
//   - sendMedia 上传到 AgentNexus bridge 拿 file_id，按 `to`（= taskId）
//     累积到 pendingMediaByTo，记录首次调用的 caption；
//   - 每次 sendMedia 重新 arm 一个短 debounce（500ms）；最后一次 sendMedia
//     之后 debounce 触发，一次性 session.reply/send(text=caption, fileIds=all)；
//   - gateway 的 await 链不等我们 debounce 触发即可返回，因此每次立即返回
//     合成的 messageId（真实 msg_id 由 bridge broadcast 时生成）。

interface SendTextCtx {
  to: string;
  text: string;
  accountId?: string | null;
  cfg?: OpenClawConfig;
  [k: string]: unknown;
}

interface SendMediaCtx {
  to: string;
  /** gateway 运行时传 mediaUrl；旧 docs 写作 filePath，兼容二者。 */
  mediaUrl?: string;
  filePath?: string;
  /** sendMediaWithLeadingCaption 在 i=0 传 caption；i>0 传 undefined/"". */
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

/** sendMedia 的 debounce：最后一个 mediaUrl 之后等这么久再统一 flush 成一条 reply. */
const PENDING_MEDIA_DEBOUNCE_MS = 500;

/** 每条逻辑回复最多挂多少媒体附件，防 agent 一次刷屏。 */
const PENDING_MEDIA_CAP = 20;

/** sendText 流式聚合的 debounce：最后一个 chunk 之后等这么久再发 done。
 *  gateway 调 sendText 是同步串行的，相邻调用通常 < 50ms；500ms 既能撑过
 *  网络抖动，也能让 LLM 自然停顿后及时收尾。 */
const STREAM_DONE_DEBOUNCE_MS = 500;

/** 单条流式回复最多累积多少字符，防 agent 一次性写一本小说。超过即自动收尾 + 截断。 */
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
  const agentId = agentIdFromSessionKey(sessionKey);
  if (agentId) {
    const defaultDir = join(homedir(), ".openclaw", "workspace", agentId, "output");
    if (!dirs.includes(defaultDir)) dirs.push(defaultDir);
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
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, cfg.maxFiles);
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
    if (now - watcher.startedAt < watcher.cfg.delayMs) continue;
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

function clearOutputFallbackWatchersForAccount(accountId: string): void {
  for (const watcher of Array.from(outputFallbackWatchers.values())) {
    if (watcher.accountId === accountId) stopOutputFallbackWatcher(accountId, watcher.taskId);
  }
}

interface PendingStreamSlot {
  /** 触发该 stream 的 inbound message —— 用于回滚 fallback 到 session.reply */
  source: InboundMessage;
  /** 服务端要的占位 msg_id；为 null 则 stream 不可用，直接降级到 reply 路径 */
  placeholderMsgId: string | null;
  /** 累积字符数，达到 STREAM_TEXT_CAP_CHARS 后强制 done */
  totalChars: number;
  /** 单调递增的 delta seq */
  seq: number;
  /** 用户已点 ⏹ 取消 → 后续 sendText 不再推 delta，也不发 done */
  cancelled: boolean;
  /** 至少推过一次 delta —— 决定 done debounce 何时启动；
   *  也用于"sendText 全空也要发 done"这类边角 case 的判断 */
  hasDeltas: boolean;
  /** sendMedia 期间累积的 file_ids；done 帧把它们一并交给 server,
   *  让 server 的 finalize_stream 把它们合并进占位消息的 file_ids 字段. */
  fileIds: string[];
  /** 首段疑似“正在生成…”的进度句。确认有真正正文/文件前不推给频道。 */
  heldStatusText: string;
  doneTimer: ReturnType<typeof setTimeout> | null;
}

/** key = ctx.to（deliver 路径下等于 taskId）。流式聚合 + 取消查找都走这里。 */
const pendingStreamByTo = new Map<string, PendingStreamSlot>();

/** key = placeholderMsgId → ctx.to。control WS 推 cancel 帧时只知道 msg_id，
 *  需要据此反查到 stream 槽位。 */
const taskByPlaceholder = new Map<string, string>();

interface PendingMediaSlot {
  fileIds: string[];
  /** 首次 sendMedia 调用里 caption 非空时抓到的 payload 文本 */
  caption: string;
  /** 上传时解析出的 channelId，flush 时复用，无需再次 resolve */
  channelId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** key = ctx.to（deliver 路径下等于 taskId）。AccountRuntime 没这个字段，
 *  所以放模块级；不同 account 的 `to` (= taskId) 全局唯一，碰不上。 */
const pendingMediaByTo = new Map<string, PendingMediaSlot>();

async function uploadBotBinaryFile(
  session: BotSession,
  channelId: string,
  filename: string,
  data: Uint8Array,
  contentType?: string,
): Promise<string | null> {
  // 走 data WS 内嵌 file_upload 帧，不再依赖 HTTP /files/upload-binary。
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

/** filePath 可以是本地路径或 http(s) URL。返回 (bytes, filename, contentType)；失败返 null。 */
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
  // 本地路径
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

/** Debounce flush：把 `to` 上累积的 fileIds + caption 一次性发成 reply/send。 */
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
  // source 已被别的流程消费；尝试主动 send 到解析好的 channel（需是 bot 成员）
  if (session.membership.channelIds.has(slot.channelId)) {
    await session.send({ channelId: slot.channelId, text: slot.caption, fileIds: slot.fileIds });
  }
}

async function sendMedia(ctx: SendMediaCtx): Promise<SendTextResult> {
  const { accountId, entry } = resolveActiveEntry(ctx.accountId);
  const { session, lastInboundByTaskId, lastInboundBySessionKey } = entry;
  const target = resolveReplyTarget(entry, ctx.to);
  const streamKey = target?.taskId ?? ctx.to;

  // gateway 运行时传 mediaUrl；旧 docs 示例用 filePath，兼容二者
  const mediaUrl = ctx.mediaUrl || ctx.filePath || "";
  // sendMediaWithLeadingCaption: index=0 传 caption（= payload text）,
  // index>0 传 undefined/""。我们抓第一个非空的作为最终 reply text。
  const caption = ((ctx.text ?? ctx.caption) ?? "").toString();

  // 解析 channelId 而**不**消费 inbound source —— 上传可能失败，
  // 失败时不能让 source 丢失（否则后续 sendText/sendMedia 也走不到流式）。
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

  // ── 主路径：把 fileId 投到流式 slot，与 sendText 的 deltas 共用一个 done ──
  if (slot && slot.placeholderMsgId && !slot.cancelled) {
    if (slot.fileIds.length < PENDING_MEDIA_CAP) slot.fileIds.push(fileId);
    // 首个 sendMedia 的 caption（= 整段文本）：如果还没有任何 sendText delta，
    // 把它作为单个 delta 推一次，让前端能即时把文字显示出来再补文件。
    // 已经流过 sendText 的情况下不要重复推 —— gateway 这时给的 caption 会
    // 跟 sendText 的总和重复。
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

  // ── 兜底：source-less 广播 / 流式槽不可用 → 老的 pendingMediaByTo debounce ──
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
  pendingStreamByTo.delete(to);
  if (slot.placeholderMsgId) taskByPlaceholder.delete(slot.placeholderMsgId);
  stopOutputFallbackWatcher(entry.account.accountId, slot.source.event.task_id);

  // Cancelled streams: server already finalized partial when it pushed the
  // cancel frame to us. We deliberately do NOT send `done` again; the server
  // would no-op on it but skipping the round-trip is cleaner.
  if (slot.cancelled) return;

  if (slot.placeholderMsgId && (slot.hasDeltas || slot.fileIds.length > 0)) {
    entry.session.streamDone({
      msgId: slot.placeholderMsgId,
      fileIds: slot.fileIds.length > 0 ? slot.fileIds : undefined,
    });
    return;
  }

  // No deltas and no files — agent produced nothing for this `to`. Drop the
  // stream silently; the placeholder will be finalized by orchestrator timeout.
}

/** sendText 主路径：把每次调用当作一个 delta 推到服务端，debounce 之后发 done。
 *
 *  Why this works: gateway deliver:true 模式会把 agent 的输出按 chunk 多次调
 *  sendText（典型间隔 < 50ms），相比一次性 reply：
 *    - 用户能在浏览器里看到 token-by-token 渲染
 *    - 用户点 ⏹ 时控制 WS 推 cancel，我们立即停止后续 delta 推送
 *    - 服务端在 cancel 那一刻就用当前 buffer finalize 了 partial，所以即使
 *      agent 还在跑也不会再影响前端
 *
 *  Fallback: 如果 inbound source / placeholderMsgId 拿不到，或 data WS 不
 *  可写，则降级回老的 session.reply 一次性整段路径，行为等同于流式前。 */
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
      // 非响应式 send：保留原行为（主动 send 到 channel），不走流式
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
      // 状态句不是最终回复。这里静默挂起，让 AgentNexus 后端的前台等待
      // timer 把占位消息转成后台 task；OpenClaw 后续迟到的正文或 MEDIA
      // 仍会继续写入同一个 stream slot 并最终更新该 task 消息。
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
// Plugin 对象
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

// base 不直接接 gateway，我们用 spread 把它合回来
const baseWithGateway: ChannelPlugin<ResolvedAccount> = {
  ...base,
  gateway: {
    startAccount,
    stopAccount,
    // 注意：resolveGatewayAuthBypassPaths 只对 bundled 插件生效。外部 linked
    // 插件的自 loopback 用 api.config.gateway.auth.token 过 gateway 层 auth，
    // 然后由 handler 里自己的 internalToken 做防伪（见 index.ts）。
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
    // 参照 @openclaw/synology-chat 等官方 channel plugin：直接把 sendText 放在
    // outbound 顶层，deliveryMode 用 "gateway"。官方 docs 里的 attachedResults
    // 是另一个高阶 API（返回 messageId 给 attachment binding），不是 deliver 路径。
    deliveryMode: "gateway",
    sendText,
    sendMedia,
    // sdk-channel-plugins.md 官例把 sendMedia 放在 outbound.base；为了兼容
    // 不同版本的 gateway 查找路径，同时在顶层和 base 里各声明一遍。
    base: { sendMedia },
  },
});

// 追加 status 适配器：gateway 的 health monitor 会用这个判断是否应该 auto-restart。
// 默认实现会把自管 WS 的长连接当成 "stale socket" 误判为故障 —— 直接 opt out。
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
  outputFallbackWatchers,
  resolveOutputFallbackConfig,
  isCompleteOutputFile,
};
