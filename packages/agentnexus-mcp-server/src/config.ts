/**
 * Runtime config for the AgentNexus stdio MCP server.
 *
 * The connector injects these as env vars when it declares this MCP server in
 * the ACP session's `mcpServers`. Because each ACP session is bound to one
 * AgentNexus channel, `AGENTNEXUS_CHANNEL_ID` is stable for the lifetime of the
 * spawned server and is used as the default target for channel-scoped tools.
 */
export interface ServerConfig {
  /** Connector loopback IPC endpoint, e.g. http://127.0.0.1:8731/resource. */
  resourceUrl: string;
  /** Channel this ACP session is bound to. Default target for tools. */
  defaultChannelId?: string;
  /** Bot identity, for diagnostics only — auth is enforced by the connection. */
  botId?: string;
  /** Per-call timeout for the resource round-trip. */
  requestTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const resourceUrl = env.AGENTNEXUS_RESOURCE_URL;
  if (!resourceUrl) {
    throw new Error(
      "AGENTNEXUS_RESOURCE_URL is required (connector loopback resource endpoint)",
    );
  }
  return {
    resourceUrl,
    defaultChannelId: env.AGENTNEXUS_CHANNEL_ID || undefined,
    botId: env.AGENTNEXUS_BOT_ID || undefined,
    requestTimeoutMs: Number(env.AGENTNEXUS_REQUEST_TIMEOUT_MS ?? "30000"),
  };
}
