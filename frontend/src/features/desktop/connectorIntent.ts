// Hand-off between the "new bot" flow and the connector setup: the desktop
// "Set up on this Mac" button stashes the just-created bot here and navigates
// to Settings → Connector, where ConnectorManager consumes it on mount and
// opens the New-connector modal pre-selected. One-shot, like the push deep-link
// intent in lib/push.ts.
//
// The agent type rides along with the id. ConnectorManager has its own
// agentType default, and defaulting there instead of carrying the wizard's
// choice silently rendered (say) a claude config for a bot registered as codex
// — a mismatch nothing downstream catches, since the connector starts whatever
// adapter the config names.

import type { AgentType } from "@/api/bots";

export interface ConnectorIntent {
  botId: string;
  agentType?: AgentType;
}

let pending: ConnectorIntent | null = null;

/** Called from the bot flow before navigating to /settings/connector. */
export function requestConnectorForBot(
  botId: string,
  agentType?: AgentType
): void {
  pending = { botId, agentType };
}

/** Read + clear the pending intent (ConnectorManager, on mount). */
export function consumeConnectorIntent(): ConnectorIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}
