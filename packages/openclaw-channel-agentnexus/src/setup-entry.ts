/**
 * setup 入口：OpenClaw SDK 启动时会加载此模块，拿到 plugin 对象用来初始化 channel。
 *
 * 真实 SDK 示例：
 *   export default defineSetupPluginEntry(plugin)
 */
import { agentnexusPlugin } from "./plugin.js";
import { defineSetupPluginEntry } from "./sdk-shim.js";

export default defineSetupPluginEntry(agentnexusPlugin);
