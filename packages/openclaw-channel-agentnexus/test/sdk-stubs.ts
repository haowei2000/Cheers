/**
 * Vitest 运行时用的 SDK 最小桩 —— tsc 用 src/openclaw-sdk.d.ts 的 ambient
 * 类型就够了，但 vitest 通过 esbuild 实际要解析模块；生产运行时由 openclaw CLI
 * 的 node_modules 提供真 SDK，测试里给个空壳即可让模块图解析成功。
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
