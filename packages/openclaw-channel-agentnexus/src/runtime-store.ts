/**
 * PluginRuntime 存储槽。OpenClaw SDK 在 bundled entry 的 runtime ref 里调
 * `setRuntime()` 把真实 `PluginRuntime` 注入进来；plugin 其他地方通过 `getRuntime()`
 * 拿到，调 `runtime.subagent.run(...)` 触发 agent turn。
 *
 * 使用 SDK 自带的 createPluginRuntimeStore 以保持与其它 native channel
 * plugin（slack、telegram、…）一致的生命周期与异常语义。
 */
// 使用 scoped subpath（/runtime-store）而不是 compat —— compat 在 2026.4 会被下架
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

import type { PluginRuntime } from "./openclaw-types.js";

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "agentnexus",
  errorMessage: "agentnexus runtime not initialized",
});

/** OpenClaw SDK 启动时调用，注入真实 runtime。 */
export const setAgentNexusRuntime = store.setRuntime;

/** 清理（测试 / 停止时用）。 */
export const clearAgentNexusRuntime = store.clearRuntime;

/** 在 plugin 内部使用：获取 runtime，未注入时返回 null。 */
export const tryGetAgentNexusRuntime = store.tryGetRuntime;
