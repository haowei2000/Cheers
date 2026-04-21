/**
 * OpenClaw bundled channel entry —— 被 `openclaw plugins install` 识别并加载。
 *
 * 和 SDK 示例（如 @openclaw/slack）一样走 `defineBundledChannelEntry`：
 * OpenClaw 运行时通过 `plugin.specifier` 按模块 ref 懒加载真正的插件对象。
 *
 * 运行时：`openclaw/plugin-sdk/channel-entry-contract` 由 OpenClaw CLI 的
 * node_modules 提供，不需要把 openclaw 列为 dependency。TS 编译期通过
 * `openclaw-sdk.d.ts` 的 ambient 声明放行。
 */
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "agentnexus",
  name: "AgentNexus",
  description: "Slack-like multi-channel chat with bots (per-bot WS bridge).",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./plugin.js",
    exportName: "agentnexusPlugin",
  },
  runtime: {
    specifier: "./runtime-store.js",
    exportName: "setAgentNexusRuntime",
  },
});
