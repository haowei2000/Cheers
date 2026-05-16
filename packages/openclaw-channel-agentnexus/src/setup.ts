/**
 * OpenClaw channel setup entry, a lightweight loading path for onboarding and
 * setup wizards.
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { agentnexusPlugin } from "./plugin.js";

export default defineSetupPluginEntry(agentnexusPlugin);
