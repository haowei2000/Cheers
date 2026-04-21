/**
 * agentnexus channel plugin —— 把 AgentNexus WebSocket Bot 桥接成 OpenClaw channel。
 *
 * 生命周期：
 *   OpenClaw SDK 调用 gateway.start(account, deps) 启动一个 BotSession
 *     → session 连 control + data WS
 *     → control hello / channel_joined 维护 membership
 *     → data message → 归一化 → deps.emitMessage（OpenClaw agent 收到）
 *     → OpenClaw agent 回 outbound.sendText → 映射成 reply/send 帧回 AgentNexus
 *
 * 退出：gateway.start 返回 { stop } —— SDK 调它断开所有 WS、清理 inflight。
 */
import { BotSession, type InboundMessage } from "./session.js";
import {
  type ChannelPlugin,
  type GatewayDeps,
  type NormalizedInboundMessage,
  type OutboundContext,
  type ResolvedAccount,
  type SendResult,
  type StatusSnapshot,
  createChatChannelPlugin,
} from "./sdk-shim.js";

const PLUGIN_ID = "agentnexus";

/**
 * 以 accountId 为 key 的 session 注册表。
 *
 * outbound.sendText 在 SDK 里常被当成独立的路径调用（与 start 不一定同一个 closure），
 * 所以把活跃 session 缓存起来，便于从 accountId 查到 BotSession 做 reply/send。
 */
const sessionRegistry = new Map<string, {
  session: BotSession;
  // 最近一次从 data 流收到的 message（按 task_id 索引），方便 outbound 时快速 finalize。
  lastInboundByTaskId: Map<string, InboundMessage>;
}>();

interface PluginConfig {
  agentnexus?: {
    accounts?: Record<string, {
      enabled?: boolean;
      botToken: string;
      controlUrl: string;
      dataUrl: string;
      advanced?: ResolvedAccount["advanced"];
    }>;
  };
}

function resolveAccount(cfg: unknown, accountId?: string): ResolvedAccount | undefined {
  const c = cfg as PluginConfig | undefined;
  const accounts = c?.agentnexus?.accounts ?? {};
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

function normalizeForOpenClaw(
  account: ResolvedAccount, m: InboundMessage,
): NormalizedInboundMessage {
  return {
    id: m.event.placeholder_msg_id || m.event.task_id,
    channel: PLUGIN_ID,
    accountId: account.accountId,
    senderId: m.senderId,
    senderName: m.senderName,
    text: m.text,
    timestamp: m.timestamp ?? new Date(),
    isGroup: true, // AgentNexus 基本都是频道语义；未来区分 DM 时再细化
    groupId: m.channelId,
    groupName: m.channelId, // control hello 有 channel_name，可从 session.membership 查
    threadId: m.threadId,
    attachments: m.attachments.map((a) => ({
      fileId: a.file_id,
      filename: a.filename ?? null,
      contentType: a.content_type ?? null,
      summary: a.summary ?? null,
    })),
    metadata: {
      taskId: m.event.task_id,
      placeholderMsgId: m.event.placeholder_msg_id,
      bindingConfig: m.event.binding_config ?? {},
      memoryContext: m.event.memory_context,
    },
  };
}

export const agentnexusPlugin: ChannelPlugin<ResolvedAccount> = createChatChannelPlugin({
  id: PLUGIN_ID,
  meta: {
    id: PLUGIN_ID,
    label: "AgentNexus",
    selectionLabel: "AgentNexus Chat (multi-channel, WebSocket Bot)",
    blurb: "Slack-like multi-channel chat with bots, via per-bot control+data WS bridge.",
    docsPath: "/channels/agentnexus",
  },
  capabilities: {
    chatTypes: ["group"],
    supports: { threads: true, mentions: true, formatting: true },
  },

  config: {
    listAccountIds: (cfg) => {
      const c = cfg as PluginConfig | undefined;
      return Object.keys(c?.agentnexus?.accounts ?? {});
    },
    resolveAccount,
  },

  gateway: {
    start: async (account, deps) => {
      const existing = sessionRegistry.get(account.accountId);
      if (existing) {
        deps.logger.warn("agentnexus: start called twice for", account.accountId);
        await existing.session.stop();
        sessionRegistry.delete(account.accountId);
      }

      const lastInboundByTaskId = new Map<string, InboundMessage>();

      const session = new BotSession(
        {
          botToken: account.botToken,
          controlUrl: account.controlUrl,
          dataUrl: account.dataUrl,
          advanced: account.advanced,
        },
        {
          onReady: () => {
            deps.logger.info(
              "agentnexus: ready account=%s memberships=%d",
              account.accountId,
              session.membership.channelIds.size,
            );
            deps.onReady?.();
          },
          onMessage: async (m) => {
            lastInboundByTaskId.set(m.event.task_id, m);
            const normalized = normalizeForOpenClaw(account, m);
            // enrich groupName from membership cache if possible
            const ch = session.membership.byId.get(m.channelId);
            if (ch?.channel_name) normalized.groupName = ch.channel_name;
            await deps.emitMessage(normalized);
          },
          onChannelJoined: (ch, invitedBy) => {
            deps.logger.info(
              "agentnexus: channel_joined account=%s channel_id=%s invited_by=%s",
              account.accountId, ch.channel_id, invitedBy,
            );
          },
          onChannelLeft: (channelId, reason) => {
            deps.logger.info(
              "agentnexus: channel_left account=%s channel_id=%s reason=%s",
              account.accountId, channelId, reason,
            );
          },
          onError: (err) => deps.logger.warn("agentnexus: error", err),
          onFatal: (reason) => deps.logger.error("agentnexus: fatal", reason),
          onConnectionChange: (stream, state) => {
            deps.logger.info(
              "agentnexus: %s %s account=%s",
              stream, state, account.accountId,
            );
          },
        },
      );

      sessionRegistry.set(account.accountId, { session, lastInboundByTaskId });
      session.start();

      return {
        stop: async () => {
          sessionRegistry.delete(account.accountId);
          await session.stop();
        },
      };
    },
  },

  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx: OutboundContext): Promise<SendResult> => {
      const entry = sessionRegistry.get(ctx.account.accountId);
      if (!entry) return { ok: false, error: "session not running for account" };
      const { session, lastInboundByTaskId } = entry;

      // 优先按 replyTo.messageId 匹配最近一次派发的 message（task_id 就是 messageId 的 fallback）
      const taskId = ctx.replyTo?.messageId;
      const source = taskId ? lastInboundByTaskId.get(taskId) : undefined;
      if (source) {
        lastInboundByTaskId.delete(source.event.task_id);
        const r = await session.reply({ source, text: ctx.text });
        return r.ok
          ? { ok: true, messageId: r.messageId }
          : { ok: false, error: `${r.code}: ${r.error}` };
      }

      // 没匹配到 → 走主动 send（例如 agent 定时任务或跨会话回复）
      if (!ctx.target.groupId) {
        return { ok: false, error: "no target.groupId for agentnexus send" };
      }
      if (!session.membership.channelIds.has(ctx.target.groupId)) {
        return { ok: false, error: `bot not in channel ${ctx.target.groupId}` };
      }
      const r = await session.send({
        channelId: ctx.target.groupId,
        text: ctx.text,
        inReplyToMsgId: ctx.replyTo?.messageId ?? null,
      });
      return r.ok
        ? { ok: true, messageId: r.messageId }
        : { ok: false, error: `${r.code}: ${r.error}` };
    },
  },

  status: {
    getStatus: (account): StatusSnapshot => {
      const entry = sessionRegistry.get(account.accountId);
      if (!entry) return { state: "stopped" };
      const { session } = entry;
      return {
        state: "running",
        detail: {
          botId: session.botId,
          sessionId: session.sessionId,
          membershipCount: session.membership.channelIds.size,
          lastProcessedSeq: session.lastProcessedSeq,
        },
      };
    },
  },

  security: {
    getDmPolicy: () => "open",
    checkGroupAccess: (_account, _groupId) => true,
  },
});

// 内部导出，方便测试从这里拿到 registry
export const __testonly = { sessionRegistry };
