/**
 * 本地 ambient declarations for OpenClaw plugin SDK —— tsc 编译不需要真装 openclaw。
 * 运行时由 OpenClaw CLI 的 node_modules 提供真实实现。
 *
 * 对齐 OpenClaw 2026.4.15 的公开 API（doc + /opt/homebrew/lib/node_modules/openclaw/
 * dist/plugin-sdk/）。
 */

declare module "openclaw/plugin-sdk/channel-core" {
  export type OpenClawConfig = {
    channels?: Record<string, unknown>;
    gateway?: { port?: number; bind?: string; [k: string]: unknown };
    [k: string]: unknown;
  };

  /** PluginRuntime：权限按 gateway request scope 分级。 */
  export interface PluginRuntime {
    events?: {
      onAgentEvent?: (listener: (evt: {
        runId: string;
        seq: number;
        stream: string;
        ts: number;
        data: Record<string, unknown>;
        sessionKey?: string;
      }) => void) => () => void;
    };
    subagent: {
      run(p: {
        sessionKey: string;
        message: string;
        deliver?: boolean;
        idempotencyKey?: string;
        provider?: string;
        model?: string;
        extraSystemPrompt?: string;
        lane?: string;
      }): Promise<{ runId: string }>;
      waitForRun(p: { runId: string; timeoutMs?: number }): Promise<{
        status: "ok" | "error" | "timeout";
        error?: string;
      }>;
      getSessionMessages(p: { sessionKey: string; limit?: number }): Promise<{
        messages: unknown[];
      }>;
      deleteSession(p: { sessionKey: string; deleteTranscript?: boolean }): Promise<void>;
    };
    channel?: {
      session?: {
        resolveStorePath(store?: string, opts?: { workspaceDir?: string }): string;
        updateLastRoute(p: {
          storePath: string;
          sessionKey: string;
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        }): Promise<unknown>;
        recordInboundSession?(p: unknown): Promise<void>;
        [k: string]: unknown;
      };
      [k: string]: unknown;
    };
    [k: string]: unknown;
  }

  /** HTTP route handler 运行在 gateway request scope 里，合法使用 subagent.run。 */
  export interface OpenClawPluginHttpRouteParams {
    path: string;
    handler: (req: unknown, res: unknown) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
    replaceExisting?: boolean;
  }

  export interface OpenClawPluginApi {
    id: string;
    name: string;
    config: OpenClawConfig;
    runtime: PluginRuntime;
    logger: {
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
      debug?: (...args: unknown[]) => void;
    };
    registerHttpRoute(params: OpenClawPluginHttpRouteParams): void;
    registerCli?(
      registrar: (ctx: { program: unknown }) => void,
      opts?: { descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }> },
    ): void;
    [k: string]: unknown;
  }

  export type ChannelPlugin<TAccount = unknown, _P = unknown, _A = unknown> = {
    id: string;
    meta?: {
      id: string;
      label?: string;
      selectionLabel?: string;
      blurb?: string;
      docsPath?: string;
      [k: string]: unknown;
    };
    capabilities?: {
      chatTypes: Array<"group" | "direct" | "thread">;
      threads?: boolean;
      reply?: boolean;
      media?: boolean;
      reactions?: boolean;
      edit?: boolean;
      [k: string]: unknown;
    };
    setup: {
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
      inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
      defaultAccountId?: (cfg: OpenClawConfig) => string | null | undefined;
      [k: string]: unknown;
    };
    config?: {
      listAccountIds: (cfg: OpenClawConfig) => string[];
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
      inspectAccount?: (cfg: OpenClawConfig, accountId?: string | null) => unknown;
      [k: string]: unknown;
    };
    gateway?: {
      startAccount?: (ctx: unknown) => Promise<void | unknown>;
      stopAccount?: (ctx: unknown) => Promise<void>;
      [k: string]: unknown;
    };
    security?: unknown;
    pairing?: unknown;
    threading?: unknown;
    outbound?: unknown;
    status?: unknown;
    [k: string]: unknown;
  };

  export function createChannelPluginBase<TAccount>(opts: {
    id: string;
    setup: ChannelPlugin<TAccount>["setup"];
    capabilities?: ChannelPlugin<TAccount>["capabilities"];
    meta?: ChannelPlugin<TAccount>["meta"];
    config?: ChannelPlugin<TAccount>["config"];
    configSchema?: unknown;
    [k: string]: unknown;
  }): ChannelPlugin<TAccount>;

  export function createChatChannelPlugin<TAccount extends { accountId?: string | null }>(params: {
    base: ChannelPlugin<TAccount>;
    security?: unknown;
    pairing?: unknown;
    threading?: unknown;
    outbound?: unknown;
  }): ChannelPlugin<TAccount>;

  export function defineChannelPluginEntry<TPlugin>(opts: {
    id: string;
    name: string;
    description: string;
    plugin: TPlugin;
    configSchema?: unknown;
    setRuntime?: (runtime: PluginRuntime) => void;
    registerCliMetadata?: (api: OpenClawPluginApi) => void;
    registerFull?: (api: OpenClawPluginApi) => void;
  }): unknown;

  export function defineSetupPluginEntry<TPlugin>(plugin: TPlugin): { plugin: TPlugin };
}

declare module "openclaw/plugin-sdk/conversation-runtime" {
  export type BindingTargetKind = "subagent" | "session";
  export type BindingStatus = "active" | "ending" | "ended";
  export type SessionBindingPlacement = "current" | "child";
  export interface ConversationRef {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  }
  export interface SessionBindingRecord {
    bindingId: string;
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversation: ConversationRef;
    status: BindingStatus;
    boundAt: number;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
  }
  export interface SessionBindingBindInput {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversation: ConversationRef;
    placement?: SessionBindingPlacement;
    metadata?: Record<string, unknown>;
    ttlMs?: number;
  }
  export interface SessionBindingUnbindInput {
    bindingId?: string;
    targetSessionKey?: string;
    reason: string;
  }
  export interface SessionBindingAdapterCapabilities {
    placements?: SessionBindingPlacement[];
    bindSupported?: boolean;
    unbindSupported?: boolean;
  }
  export interface SessionBindingAdapter {
    channel: string;
    accountId: string;
    capabilities?: SessionBindingAdapterCapabilities;
    bind?: (input: SessionBindingBindInput) => Promise<SessionBindingRecord | null>;
    listBySession: (targetSessionKey: string) => SessionBindingRecord[];
    resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
    touch?: (bindingId: string, at?: number) => void;
    unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
  }
  export interface SessionBindingService {
    bind(input: SessionBindingBindInput): Promise<SessionBindingRecord>;
    listBySession(targetSessionKey: string): SessionBindingRecord[];
    resolveByConversation(ref: ConversationRef): SessionBindingRecord | null;
    unbind(input: SessionBindingUnbindInput): Promise<SessionBindingRecord[]>;
  }
  export function registerSessionBindingAdapter(adapter: SessionBindingAdapter): void;
  export function unregisterSessionBindingAdapter(params: {
    channel: string;
    accountId: string;
    adapter?: SessionBindingAdapter;
  }): void;
  export function getSessionBindingService(): SessionBindingService;
}

declare module "openclaw/plugin-sdk/runtime-store" {
  export interface PluginRuntimeStoreOptions {
    pluginId: string;
    errorMessage?: string;
  }
  export interface PluginRuntimeStore<T> {
    setRuntime: (next: T) => void;
    clearRuntime: () => void;
    tryGetRuntime: () => T | null;
    getRuntime: () => T;
  }
  export function createPluginRuntimeStore<T>(opts: PluginRuntimeStoreOptions): PluginRuntimeStore<T>;
}
