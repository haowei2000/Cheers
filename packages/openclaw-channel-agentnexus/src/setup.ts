/**
 * OpenClaw bundled channel setup entry —— 用于 `openclaw configure` / 首次接入流程。
 */
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./plugin.js",
    exportName: "agentnexusPlugin",
  },
});
