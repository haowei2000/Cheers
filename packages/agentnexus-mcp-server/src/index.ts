#!/usr/bin/env node
/**
 * AgentNexus local stdio MCP server.
 *
 * Spawned by the ACP agent (e.g. opencode) as a child process, declared by the
 * connector in the session's `mcpServers`. Exposes AgentNexus channel resources
 * as MCP tools; relays calls to the connector's data WS via local IPC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AgentNexusClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { HttpLoopbackTransport } from "./transport.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const transport = new HttpLoopbackTransport(config.resourceUrl, config.requestTimeoutMs);
  const client = new AgentNexusClient(transport, config.defaultChannelId);

  const server = new McpServer({
    name: "agentnexus",
    version: "0.1.0",
  });

  registerTools(server, client);

  // stdio transport: stdout is the MCP channel, so all logs must go to stderr.
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[agentnexus-mcp] ready (channel=${config.defaultChannelId ?? "none"}, bot=${config.botId ?? "?"})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[agentnexus-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
