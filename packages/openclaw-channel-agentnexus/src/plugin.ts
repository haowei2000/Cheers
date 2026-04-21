/**
 * agentnexus channel plugin —— OpenClaw 官方 SDK 契约版（channel-core）
 *
 * 按 docs.openclaw.ai/plugins/sdk-channel-plugins 的 createChatChannelPlugin
 * + createChannelPluginBase 模式构建；entry 文件里 registerFull 注册 HTTP 路由，
 * WS 入站时自 loopback 到该路由进入 gateway-request-scope，合法调用
 * api.runtime.subagent.run。agent 产出经 outbound.sendText 回推 → session.reply
 * 原地 finalize AgentNexus 侧占位消息。
 */
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";

import { BotSession, type InboundMessage } from "./session.js";

const PLUGIN_ID = "agentnexus";
const INBOUND_CACHE_MAX = 1000;

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
  /** sessionKey → 最近一次 inbound，供 outbound.sendText 查源消息做 session.reply */
  lastInboundBySessionKey: Map<string, InboundMessage>;
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
        log.info?.(
          `agentnexus: ${accountId} inbound channel=${m.channelId} task=${m.event.task_id} text=${JSON.stringify(m.text).slice(0, 80)}`,
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
              text: m.text,
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

  sessionRegistry.set(accountId, { session, account, lastInboundBySessionKey });

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
  await entry.session.stop();
}

// ============================================================================
// Outbound: OpenClaw agent → sendText → session.reply
// ============================================================================

interface SendTextParams {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
}

async function sendText(params: SendTextParams): Promise<{ messageId: string }> {
  const accountId = params.accountId ?? Array.from(sessionRegistry.keys())[0];
  if (!accountId) throw new Error("agentnexus: no active account for sendText");
  const entry = sessionRegistry.get(accountId);
  if (!entry) throw new Error(`agentnexus: no running session for account ${accountId}`);
  const { session, lastInboundBySessionKey } = entry;

  // deliver 路径下 `to` 通常等于 sessionKey
  const source = lastInboundBySessionKey.get(params.to);
  if (source) {
    lastInboundBySessionKey.delete(params.to);
    const r = await session.reply({ source, text: params.text });
    if (r.ok && r.messageId) return { messageId: r.messageId };
    throw new Error(`agentnexus: session.reply failed (${r.code ?? "?"} ${r.error ?? ""})`);
  }

  // 兜底：把 to 当 channelId，走主动 send
  const channelId = params.to;
  if (!session.membership.channelIds.has(channelId)) {
    throw new Error(`agentnexus: bot not in channel ${channelId}`);
  }
  const r = await session.send({ channelId, text: params.text });
  if (r.ok && r.messageId) return { messageId: r.messageId };
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
    attachedResults: {
      sendText,
    },
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
export const __testonly = { sessionRegistry };
