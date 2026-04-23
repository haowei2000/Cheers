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
  const url = `${httpBase}/api/v1/openclaw/bridge/files/${encodeURIComponent(fileId)}/content`;
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

async function uploadBotMarkdownFile(
  httpBase: string,
  botToken: string,
  channelId: string,
  filename: string,
  content: string,
): Promise<string | null> {
  if (!httpBase) return null;
  const url = `${httpBase}/api/v1/openclaw/bridge/files/upload`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel_id: channelId, filename, content }),
      signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = await resp.json() as { data?: { file_id?: string } };
    return body.data?.file_id ?? null;
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
}

interface RawAccount {
  enabled?: boolean;
  botToken: string;
  controlUrl: string;
  dataUrl: string;
  advanced?: Partial<ResolvedAccount["advanced"]>;
  allowFrom?: string[];
  dmSecurity?: string;
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
  /** SessionBindingAdapter 的内存 store（sessionKey → records） */
  bindingStore: Map<string, SessionBindingRecord[]>;
  /** 给 stopAccount 解除注册用 */
  bindingAdapter: SessionBindingAdapter;
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

export function sessionKeyFor(accountId: string, channelId: string): string {
  return `agentnexus:${accountId}:${channelId}`;
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
        const sk = sessionKeyFor(accountId, m.channelId);
        rememberInbound(lastInboundBySessionKey, sk, m);
        rememberInbound(lastInboundByTaskId, m.event.task_id, m);
        log.info?.(
          `agentnexus: ${accountId} inbound channel=${m.channelId} task=${m.event.task_id} attachments=${m.attachments.length} text=${JSON.stringify(m.text).slice(0, 80)}`,
        );

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
        const hydratedText = await buildMessageWithAttachments(httpBase, account.botToken, m, log);

        const url = `http://127.0.0.1:${ref.gatewayPort}/plugins/agentnexus/inbound`;
        try {
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
              text: hydratedText,
            }),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => "<unreadable>");
            log.warn?.(`agentnexus: ${accountId} inbound loopback failed HTTP ${resp.status}: ${body.slice(0, 200)}`);
            await session.reply({
              source: m,
              text: `[agentnexus plugin] 内部路由 HTTP ${resp.status}: ${body.slice(0, 120)}`,
            }).catch(() => { /* ignore */ });
          }
        } catch (err) {
          log.error?.(`agentnexus: ${accountId} inbound loopback error: ${String(err)}`);
          await session.reply({
            source: m,
            text: `[agentnexus plugin] 内部路由错误: ${String(err)}`,
          }).catch(() => { /* ignore */ });
        }
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
  httpBase: string,
  botToken: string,
  channelId: string,
  filename: string,
  data: Uint8Array,
  contentType?: string,
): Promise<string | null> {
  if (!httpBase) return null;
  const url = `${httpBase}/api/v1/openclaw/bridge/files/upload-binary`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": contentType || "application/octet-stream",
        "X-Channel-Id": channelId,
        "X-Filename": filename,
      },
      body: data,
      signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = await resp.json() as { data?: { file_id?: string } };
    return body.data?.file_id ?? null;
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
  const httpBase = deriveHttpBase(entry.account.dataUrl);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileId = await uploadBotMarkdownFile(
    httpBase, entry.account.botToken, channelId, `reply-${ts}.md`, text,
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

  const { session, lastInboundByTaskId } = entry;
  const source = lastInboundByTaskId.get(to);
  if (source) {
    lastInboundByTaskId.delete(source.event.task_id);
    await session.reply({ source, text: slot.caption, fileIds: slot.fileIds });
    return;
  }
  // source 已被别的流程消费；尝试主动 send 到解析好的 channel（需是 bot 成员）
  if (session.membership.channelIds.has(slot.channelId)) {
    await session.send({ channelId: slot.channelId, text: slot.caption, fileIds: slot.fileIds });
  }
}

async function sendMedia(ctx: SendMediaCtx): Promise<SendTextResult> {
  const { entry } = resolveActiveEntry(ctx.accountId);
  const { lastInboundByTaskId } = entry;

  // gateway 运行时传 mediaUrl；旧 docs 示例用 filePath，兼容二者
  const mediaUrl = ctx.mediaUrl || ctx.filePath || "";
  // sendMediaWithLeadingCaption: index=0 传 caption（= payload text）,
  // index>0 传 undefined/""。我们抓第一个非空的作为最终 reply text。
  const caption = ((ctx.text ?? ctx.caption) ?? "").toString();

  const source = lastInboundByTaskId.get(ctx.to);
  const channelId = source?.channelId
    ?? (entry.session.membership.channelIds.has(ctx.to) ? ctx.to : null);
  if (!channelId || !mediaUrl) {
    // 没法解析 channel / 没给 url —— gateway 的 lastMessageId 仍然需要一个非 undefined
    return { channel: PLUGIN_ID, messageId: "", chatId: channelId ?? "" };
  }

  const media = await readMediaSource(mediaUrl, ctx.filename, ctx.contentType);
  if (!media) {
    return { channel: PLUGIN_ID, messageId: "", chatId: channelId };
  }

  const fileId = await uploadBotBinaryFile(
    deriveHttpBase(entry.account.dataUrl),
    entry.account.botToken,
    channelId,
    media.filename,
    media.bytes,
    media.contentType,
  );
  if (!fileId) {
    return { channel: PLUGIN_ID, messageId: "", chatId: channelId };
  }

  let slot = pendingMediaByTo.get(ctx.to);
  if (!slot) {
    slot = { fileIds: [], caption: "", channelId, timer: null };
    pendingMediaByTo.set(ctx.to, slot);
  }
  if (slot.fileIds.length < PENDING_MEDIA_CAP) slot.fileIds.push(fileId);
  if (caption && !slot.caption) slot.caption = caption;

  // 每次 sendMedia 都重置 debounce；gateway 循环结束后 timer 触发 → 一次性 flush
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    flushPendingMedia(ctx.to, entry).catch(() => { /* swallow, gateway 无需感知 */ });
  }, PENDING_MEDIA_DEBOUNCE_MS);

  // 合成 messageId —— 真实 msg_id 要等 flush 后 bridge broadcast 才知道
  return {
    channel: PLUGIN_ID,
    messageId: `pending-media-${ctx.to}-${fileId.slice(0, 8)}`,
    chatId: channelId,
  };
}

async function sendText(ctx: SendTextCtx): Promise<SendTextResult> {
  const { accountId, entry } = resolveActiveEntry(ctx.accountId);
  const { session, lastInboundBySessionKey, lastInboundByTaskId } = entry;

  // deliver:true 路径：ctx.to === conversationId === taskId（见 bindingAdapter 注册）
  const byTask = lastInboundByTaskId.get(ctx.to);
  const bySk = lastInboundBySessionKey.get(ctx.to);
  const source = byTask ?? bySk;
  if (source) {
    lastInboundByTaskId.delete(source.event.task_id);
    lastInboundBySessionKey.delete(`agentnexus:${accountId}:${source.channelId}`);
    const fileIds = await maybeAutoAttachReplyAsFile(entry, source.channelId, ctx.text);
    const r = await session.reply({ source, text: ctx.text, fileIds });
    if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, chatId: source.channelId };
    throw new Error(`agentnexus: session.reply failed (${r.code ?? "?"} ${r.error ?? ""})`);
  }

  // 最终兜底：把 to 当 channelId，走主动 send（非响应场景）
  const channelId = ctx.to;
  if (!session.membership.channelIds.has(channelId)) {
    throw new Error(`agentnexus: bot not in channel ${channelId} (to=${ctx.to})`);
  }
  const fileIds = await maybeAutoAttachReplyAsFile(entry, channelId, ctx.text);
  const r = await session.send({ channelId, text: ctx.text, fileIds });
  if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, chatId: channelId };
  throw new Error(`agentnexus: session.send failed (${r.code ?? "?"} ${r.error ?? ""})`);
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
};
