/**
 * agentnexus channel plugin —— 把 AgentNexus WebSocket Bot 桥接成 OpenClaw channel。
 *
 * 形状对齐 OpenClaw Plugin SDK（2026.4.15）的 ChannelPlugin 契约：
 *   - config.listAccountIds / resolveAccount（必填）
 *   - gateway.startAccount(ctx) / stopAccount(ctx)：ctx.account 即 resolveAccount
 *     的返回；ctx.setStatus 用来上报运行状态；ctx.abortSignal 用来驱动停止
 *   - outbound.sendText(ctx): Promise<OutboundDeliveryResult>
 *   - capabilities: 扁平 ChannelCapabilities 形状
 *
 * 生命周期：
 *   OpenClaw 读取 cfg.channels.agentnexus.accounts.<id> → resolveAccount →
 *   gateway.startAccount → new BotSession(...) 连 control + data WS →
 *   hello → setStatus("connected")。
 *
 * 出站：OpenClaw agent 调 outbound.sendText(ctx, text) →
 *   session.reply() 或 session.send()，映射回 AgentNexus 的 reply/send 帧。
 *
 * 入站（agent 接收用户消息）：
 *   当前版本先仅缓存 lastInboundByTaskId，供 outbound.sendText 的 replyTo 匹配；
 *   把消息真正推入 OpenClaw agent 需要 ctx.runtime 的专用 helper，
 *   那部分 SDK 未公开稳定类型，留待后续 SDK 升级后补齐。
 */
import { BotSession, type InboundMessage } from "./session.js";
import type { ChannelPlugin, ResolvedAccount, StatusSnapshot } from "./sdk-shim.js";
import { createChatChannelPlugin } from "./sdk-shim.js";

const PLUGIN_ID = "agentnexus";
const INBOUND_CACHE_MAX = 1000;

// ============================================================================
// Account registry —— accountId → live BotSession + inbound cache
// ============================================================================

interface AccountRuntime {
  session: BotSession;
  lastInboundByTaskId: Map<string, InboundMessage>;
  /** ctx.setStatus 的最后一次快照，便于 getStatus 查询 */
  lastStatus: StatusSnapshot;
}

const sessionRegistry = new Map<string, AccountRuntime>();

function rememberInbound(cache: Map<string, InboundMessage>, taskId: string, m: InboundMessage): void {
  if (cache.has(taskId)) cache.delete(taskId);
  cache.set(taskId, m);
  while (cache.size > INBOUND_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ============================================================================
// Config parsing
// ============================================================================

interface AccountShape {
  enabled?: boolean;
  botToken: string;
  controlUrl: string;
  dataUrl: string;
  advanced?: ResolvedAccount["advanced"];
}

interface OpenClawChannelConfig {
  channels?: { agentnexus?: { enabled?: boolean; accounts?: Record<string, AccountShape> } };
}

function getAccountsFromConfig(cfg: unknown): Record<string, AccountShape> {
  const c = cfg as OpenClawChannelConfig | undefined;
  return c?.channels?.agentnexus?.accounts ?? {};
}

function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedAccount | undefined {
  const accounts = getAccountsFromConfig(cfg);
  const id = accountId ?? Object.keys(accounts)[0];
  if (!id) return undefined;
  const raw = accounts[id];
  if (!raw) return undefined;
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
    raw: raw as unknown as Record<string, unknown>,
  };
}

// ============================================================================
// Gateway adapter —— SDK 调用 startAccount 启动会话、stopAccount 停止
// ============================================================================

interface GatewayCtx {
  account: ResolvedAccount;
  accountId: string;
  abortSignal?: AbortSignal;
  log?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
  setStatus?: (next: unknown) => void;
}

async function startAccount(ctx: GatewayCtx): Promise<void> {
  const { account, accountId } = ctx;
  const log = ctx.log ?? console;
  const setStatus = (next: StatusSnapshot) => ctx.setStatus?.(next as unknown);

  // 若已经有旧 session，先停掉（幂等）
  const existing = sessionRegistry.get(accountId);
  if (existing) {
    log.warn?.(`agentnexus: startAccount called twice for ${accountId}; stopping old session first`);
    await existing.session.stop();
  }

  const lastInboundByTaskId = new Map<string, InboundMessage>();
  let lastStatus: StatusSnapshot = { state: "stopped" };

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
        lastStatus = { state: "running", detail: { botId: session.botId ?? undefined, memberships: session.membership.channelIds.size } };
        setStatus({ state: "connected" } as unknown as StatusSnapshot);
      },
      onChannelJoined: (ch, invitedBy) => {
        log.info?.(`agentnexus: ${accountId} joined ${ch.channel_id} invited_by=${invitedBy ?? "?"}`);
      },
      onChannelLeft: (cid, reason) => {
        log.info?.(`agentnexus: ${accountId} left ${cid} reason=${reason}`);
      },
      onMessage: async (m) => {
        rememberInbound(lastInboundByTaskId, m.event.task_id, m);
        log.info?.(
          `agentnexus: ${accountId} inbound channel=${m.channelId} task=${m.event.task_id} text=${JSON.stringify(m.text).slice(0, 80)}`,
        );
        // TODO: 将 m 推入 OpenClaw agent。本版本暂只缓存到 lastInboundByTaskId，
        //       供 outbound.sendText 的 replyTo 匹配。SDK 公开稳定的 "runtime"
        //       helpers 后在这里接 runtime.reply.dispatch / session.startAgentTurn.
      },
      onConnectionChange: (stream, state) => {
        log.info?.(`agentnexus: ${accountId} ${stream} ${state}`);
      },
      onFatal: (reason) => {
        log.error?.(`agentnexus: ${accountId} fatal: ${reason}`);
        lastStatus = { state: "stopped", detail: { fatal: reason } };
        setStatus({ state: "error", error: reason } as unknown as StatusSnapshot);
      },
    },
  );

  const runtime: AccountRuntime = { session, lastInboundByTaskId, lastStatus };
  sessionRegistry.set(accountId, runtime);

  ctx.abortSignal?.addEventListener("abort", () => {
    log.info?.(`agentnexus: ${accountId} abortSignal fired; stopping session`);
    void session.stop();
    sessionRegistry.delete(accountId);
  });

  session.start();
}

async function stopAccount(ctx: GatewayCtx): Promise<void> {
  const entry = sessionRegistry.get(ctx.accountId);
  if (!entry) return;
  sessionRegistry.delete(ctx.accountId);
  await entry.session.stop();
}

// ============================================================================
// Outbound: OpenClaw agent → send text back to AgentNexus channel
// ============================================================================

interface OutboundCtx {
  to: string;              // 目标 channel id（或 task id）
  text: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  accountId?: string | null;
}

interface OutboundResult {
  channel: string;
  messageId: string;
  channelId?: string;
}

async function sendText(ctx: OutboundCtx): Promise<OutboundResult> {
  const accountId = ctx.accountId ?? Array.from(sessionRegistry.keys())[0];
  if (!accountId) throw new Error("agentnexus: no active account");
  const entry = sessionRegistry.get(accountId);
  if (!entry) throw new Error(`agentnexus: no running session for account ${accountId}`);
  const { session, lastInboundByTaskId } = entry;

  // 优先把 reply 匹配到最近一次派发的消息（taskId 即 ctx.replyToId / ctx.to 时）
  const taskHint = ctx.replyToId ?? ctx.to;
  const source = taskHint ? lastInboundByTaskId.get(taskHint) : undefined;
  if (source) {
    lastInboundByTaskId.delete(source.event.task_id);
    const r = await session.reply({ source, text: ctx.text });
    if (r.ok && r.messageId) {
      return { channel: PLUGIN_ID, messageId: r.messageId, channelId: source.channelId };
    }
    throw new Error(`agentnexus: reply failed (${r.code ?? "?"} ${r.error ?? ""})`);
  }

  // 否则作为主动 send 到 channel（ctx.to 被视为 channelId）
  const channelId = ctx.to;
  if (!channelId) throw new Error("agentnexus: sendText missing channel id");
  if (!session.membership.channelIds.has(channelId)) {
    throw new Error(`agentnexus: bot not in channel ${channelId}`);
  }
  const r = await session.send({ channelId, text: ctx.text });
  if (r.ok && r.messageId) return { channel: PLUGIN_ID, messageId: r.messageId, channelId };
  throw new Error(`agentnexus: send failed (${r.code ?? "?"} ${r.error ?? ""})`);
}

// ============================================================================
// Plugin object
// ============================================================================

export const agentnexusPlugin: ChannelPlugin<ResolvedAccount> = createChatChannelPlugin({
  id: PLUGIN_ID,
  meta: {
    id: PLUGIN_ID,
    label: "AgentNexus",
    selectionLabel: "AgentNexus (per-bot WebSocket bridge)",
    blurb: "Slack-like multi-channel chat with bots, via per-bot control+data WS bridge.",
    docsPath: "/channels/agentnexus",
  },
  capabilities: {
    chatTypes: ["group"],
    threads: true,
    reply: true,
    media: true,
  },
  config: {
    listAccountIds: (cfg) => Object.keys(getAccountsFromConfig(cfg)),
    resolveAccount,
  },
  gateway: {
    // 字段名对齐 OpenClaw SDK 的 ChannelGatewayAdapter：startAccount / stopAccount
    startAccount,
    stopAccount,
    // legacy start 字段保留（shim 里有），真实 SDK 不读但不影响
    start: async () => ({ stop: async () => {} }),
  } as unknown as ChannelPlugin<ResolvedAccount>["gateway"],
  outbound: {
    deliveryMode: "direct",
    sendText: sendText as unknown as ChannelPlugin<ResolvedAccount>["outbound"]["sendText"],
  },
  status: {
    getStatus: (account): StatusSnapshot => {
      const entry = sessionRegistry.get(account.accountId);
      if (!entry) return { state: "stopped" };
      return entry.lastStatus;
    },
  },
  security: {
    getDmPolicy: () => "open",
    checkGroupAccess: () => true,
  },
});

// 内部暴露，便于测试
export const __testonly = { sessionRegistry };
