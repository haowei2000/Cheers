/**
 * OpenClaw channel plugin SDK 的本地类型 shim。
 *
 * 真实 SDK 的入口形如：
 *   import { defineChannelPluginEntry, defineSetupPluginEntry, createChatChannelPlugin }
 *     from "openclaw/plugin-sdk/channel-core";
 *
 * 在能拉到真实包之前，我们先用等价 shape 的本地声明保证 tsc 可编译 + 行为可测。
 * 接入真实 SDK 时，把这个文件里的 import 换成 `openclaw/plugin-sdk/channel-core` 即可。
 */

// ============ Normalized message（plugin → OpenClaw agent） ============
export interface NormalizedInboundMessage {
  id: string;
  channel: string; // plugin id，例如 "agentnexus"
  accountId: string;

  senderId?: string;
  senderName?: string;

  text: string;
  timestamp: Date;

  isGroup: boolean;
  groupId?: string;
  groupName?: string;

  threadId?: string;
  replyTo?: {
    messageId: string;
    senderId?: string;
  };

  attachments?: Array<{
    fileId?: string;
    filename?: string | null;
    contentType?: string | null;
    summary?: string | null;
  }>;

  metadata?: Record<string, unknown>;
}

// ============ 出站（OpenClaw agent → plugin） ============
export interface OutboundTarget {
  channel: string;
  accountId: string;
  groupId?: string;
  threadId?: string;
}

export interface OutboundContext {
  account: ResolvedAccount;
  target: OutboundTarget;
  text: string;
  replyTo?: {
    messageId?: string;
    senderId?: string;
  };
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

// ============ 账户 ============
export interface ResolvedAccount {
  accountId: string;
  enabled: boolean;
  botToken: string;
  controlUrl: string;
  dataUrl: string;
  advanced?: {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    heartbeatIntervalMs?: number;
    sendAckTimeoutMs?: number;
  };
  raw?: Record<string, unknown>;
}

// ============ Gateway deps（SDK 注入给 plugin） ============
export interface GatewayDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  /** plugin 把归一化消息推给 OpenClaw agent */
  emitMessage: (m: NormalizedInboundMessage) => void | Promise<void>;
  /** plugin 回传「已准备好接收消息」—— 可选 */
  onReady?: () => void;
}

// ============ 状态快照（供 SDK status 命令读取） ============
export interface StatusSnapshot {
  state: "running" | "degraded" | "stopped";
  detail?: Record<string, unknown>;
}

// ============ Plugin 接口 ============
export interface ChannelPlugin<TAccount = ResolvedAccount> {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel?: string;
    blurb?: string;
    docsPath?: string;
  };
  capabilities?: {
    chatTypes?: Array<"group" | "direct">;
    supports?: {
      threads?: boolean;
      reactions?: boolean;
      mentions?: boolean;
      formatting?: boolean;
    };
  };
  config: {
    listAccountIds: (cfg: unknown) => string[];
    resolveAccount: (cfg: unknown, accountId?: string) => TAccount | undefined;
  };
  gateway: {
    start: (account: TAccount, deps: GatewayDeps) => Promise<{
      stop: () => Promise<void>;
    }>;
  };
  outbound: {
    deliveryMode: "direct";
    sendText: (ctx: OutboundContext) => Promise<SendResult>;
  };
  status?: {
    getStatus?: (account: TAccount) => StatusSnapshot;
  };
  security?: {
    getDmPolicy?: (account: TAccount) => "open" | "pairing" | "allowlist";
    checkGroupAccess?: (account: TAccount, groupId: string) => boolean;
  };
}

// ============ Entry helpers ============
export interface PluginEntry<TAccount> {
  id: string;
  name: string;
  description: string;
  plugin: ChannelPlugin<TAccount>;
}

/** 真实 SDK 会用这个把 plugin 对象注册到 OpenClaw gateway 里。 */
export function defineChannelPluginEntry<TAccount>(entry: PluginEntry<TAccount>): PluginEntry<TAccount> {
  return entry;
}

/** 真实 SDK 的 setup 入口；这里 pass-through。 */
export function defineSetupPluginEntry<TAccount>(plugin: ChannelPlugin<TAccount>): ChannelPlugin<TAccount> {
  return plugin;
}

/** 简化的 createChatChannelPlugin —— 真实 SDK 会注入 mention gating / approval 等。 */
export function createChatChannelPlugin<TAccount extends ResolvedAccount>(
  base: ChannelPlugin<TAccount>,
): ChannelPlugin<TAccount> {
  return base;
}
