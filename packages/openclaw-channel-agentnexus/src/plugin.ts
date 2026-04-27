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
      onCancel: (msgId, reason) => {
        // Frontend ⏹: server already finalized the placeholder with whatever
        // deltas had landed before the cancel. We just stop pushing more.
        const to = taskByPlaceholder.get(msgId);
        const slot = to ? pendingStreamByTo.get(to) : undefined;
        if (!slot) {
          log.info?.(`agentnexus: ${accountId} cancel for unknown msg=${msgId} (already done?)`);
          return;
        }
        slot.cancelled = true;
        if (slot.doneTimer) {
          clearTimeout(slot.doneTimer);
          slot.doneTimer = null;
        }
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

/** sendText 流式聚合的 debounce：最后一个 chunk 之后等这么久再发 done。
 *  gateway 调 sendText 是同步串行的，相邻调用通常 < 50ms；500ms 既能撑过
 *  网络抖动，也能让 LLM 自然停顿后及时收尾。 */
const STREAM_DONE_DEBOUNCE_MS = 500;

/** 单条流式回复最多累积多少字符，防 agent 一次性写一本小说。超过即自动收尾 + 截断。 */
const STREAM_TEXT_CAP_CHARS = 200_000;

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
  const { accountId, entry } = resolveActiveEntry(ctx.accountId);
  const { session, lastInboundByTaskId, lastInboundBySessionKey } = entry;

  // gateway 运行时传 mediaUrl；旧 docs 示例用 filePath，兼容二者
  const mediaUrl = ctx.mediaUrl || ctx.filePath || "";
  // sendMediaWithLeadingCaption: index=0 传 caption（= payload text）,
  // index>0 传 undefined/""。我们抓第一个非空的作为最终 reply text。
  const caption = ((ctx.text ?? ctx.caption) ?? "").toString();

  // 解析 channelId 而**不**消费 inbound source —— 上传可能失败，
  // 失败时不能让 source 丢失（否则后续 sendText/sendMedia 也走不到流式）。
  const existingSlot = pendingStreamByTo.get(ctx.to);
  const peekedSource = existingSlot ? null : lastInboundByTaskId.get(ctx.to);
  const channelId = existingSlot?.source.channelId
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

  // Upload succeeded — *now* it's safe to consume the inbound source and
  // promote it into a stream slot.
  let slot = existingSlot;
  if (!slot && peekedSource) {
    lastInboundByTaskId.delete(peekedSource.event.task_id);
    lastInboundBySessionKey.delete(`agentnexus:${accountId}:${peekedSource.channelId}`);
    const placeholder = peekedSource.event.placeholder_msg_id ?? null;
    slot = {
      source: peekedSource,
      placeholderMsgId: placeholder,
      totalChars: 0,
      seq: 0,
      cancelled: false,
      hasDeltas: false,
      fileIds: [],
      doneTimer: null,
    };
    pendingStreamByTo.set(ctx.to, slot);
    if (placeholder) taskByPlaceholder.set(placeholder, ctx.to);
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
    armStreamDoneTimer(ctx.to, entry, slot);
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
function armStreamDoneTimer(to: string, entry: AccountRuntime, slot: PendingStreamSlot): void {
  if (slot.doneTimer) clearTimeout(slot.doneTimer);
  slot.doneTimer = setTimeout(() => {
    flushStreamDone(to, entry).catch(() => { /* swallow */ });
  }, STREAM_DONE_DEBOUNCE_MS);
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

  let slot = pendingStreamByTo.get(ctx.to);

  if (!slot) {
    // First chunk for this `to`. Locate the inbound source so we have a
    // placeholder to stream against (and a fallback target if streaming
    // turns out to be unusable).
    const byTask = lastInboundByTaskId.get(ctx.to);
    const bySk = lastInboundBySessionKey.get(ctx.to);
    const source = byTask ?? bySk;
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
    lastInboundBySessionKey.delete(`agentnexus:${accountId}:${source.channelId}`);

    const placeholder = source.event.placeholder_msg_id ?? null;
    slot = {
      source,
      placeholderMsgId: placeholder,
      totalChars: 0,
      seq: 0,
      cancelled: false,
      hasDeltas: false,
      fileIds: [],
      doneTimer: null,
    };
    pendingStreamByTo.set(ctx.to, slot);
    if (placeholder) taskByPlaceholder.set(placeholder, ctx.to);
  }

  // Cancelled mid-stream: drop further deltas silently. Returning a
  // "messageId" keeps the gateway happy.
  if (slot.cancelled) {
    return {
      channel: PLUGIN_ID,
      messageId: `cancelled-${ctx.to}`,
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
        messageId: `dup-${ctx.to}`,
        chatId: slot.source.channelId,
      };
    }
    slot.hasDeltas = true;
    const fileIds = await maybeAutoAttachReplyAsFile(entry, slot.source.channelId, ctx.text);
    const r = await session.reply({ source: slot.source, text: ctx.text, fileIds });
    pendingStreamByTo.delete(ctx.to);
    if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, chatId: slot.source.channelId };
    throw new Error(`agentnexus: session.reply failed (${r.code ?? "?"} ${r.error ?? ""})`);
  }

  // Cap protection: once we've streamed enough, force a done and refuse more.
  const incoming = ctx.text || "";
  if (slot.totalChars >= STREAM_TEXT_CAP_CHARS) {
    if (slot.placeholderMsgId) {
      session.streamDone({ msgId: slot.placeholderMsgId });
    }
    pendingStreamByTo.delete(ctx.to);
    if (slot.placeholderMsgId) taskByPlaceholder.delete(slot.placeholderMsgId);
    return {
      channel: PLUGIN_ID,
      messageId: `truncated-${ctx.to}`,
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
    pendingStreamByTo.delete(ctx.to);
    if (slot.placeholderMsgId) taskByPlaceholder.delete(slot.placeholderMsgId);
    const fileIds = await maybeAutoAttachReplyAsFile(entry, slot.source.channelId, incoming);
    const r = await session.reply({ source: slot.source, text: incoming, fileIds });
    if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, chatId: slot.source.channelId };
    throw new Error(`agentnexus: session.reply failed (${r.code ?? "?"} ${r.error ?? ""})`);
  }
  armStreamDoneTimer(ctx.to, entry, slot);
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
};
