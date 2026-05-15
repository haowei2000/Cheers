/**
 * Minimal SDK stub for Vitest runtime. tsc only needs the ambient types from
 * src/openclaw-sdk.d.ts, but Vitest resolves modules through esbuild. Production
 * runtime gets the real SDK from the OpenClaw CLI node_modules; tests only need
 * an empty shell so the module graph resolves.
 */
export function createChannelPluginBase<T>(opts: unknown): T {
  return opts as T;
}

export function createChatChannelPlugin<T>(opts: { base: T } & Record<string, unknown>): T {
  return opts.base;
}

export function registerSessionBindingAdapter(_p: unknown): void {}
export function unregisterSessionBindingAdapter(_p: unknown): void {}

export type ChannelPlugin<T> = T;
export type OpenClawConfig = Record<string, unknown>;
export type OpenClawPluginApi = Record<string, unknown>;
export type ConversationRef = unknown;
export type SessionBindingAdapter = Record<string, unknown>;
export type SessionBindingRecord = Record<string, unknown>;
