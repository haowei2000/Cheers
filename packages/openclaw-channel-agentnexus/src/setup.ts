/**
 * OpenClaw channel setup entry —— lightweight 加载路径，用于 onboarding / setup wizard。
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { agentnexusPlugin } from "./plugin.js";

export default defineSetupPluginEntry(agentnexusPlugin);
