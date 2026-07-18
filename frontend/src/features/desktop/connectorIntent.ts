// Hand-off between the "new bot" flow and the connector setup: the desktop
// "Set up on this Mac" button stashes the just-created bot id here and
// navigates to Settings → Connector, where ConnectorManager consumes it on
// mount and opens the New-connector modal pre-selected. One-shot, like the
// push deep-link intent in lib/push.ts.

let pendingBotId: string | null = null;

/** Called from the bot flow before navigating to /settings/connector. */
export function requestConnectorForBot(botId: string): void {
  pendingBotId = botId;
}

/** Read + clear the pending bot id (ConnectorManager, on mount). */
export function consumeConnectorIntent(): string | null {
  const id = pendingBotId;
  pendingBotId = null;
  return id;
}
