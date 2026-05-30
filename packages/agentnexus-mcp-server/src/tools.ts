/**
 * MCP tool surface over AgentNexus channel resources.
 *
 * Each tool maps 1:1 to a gateway resource method. `channel_id` is optional on
 * every tool: when omitted it falls back to the channel this ACP session is
 * bound to. Cross-channel calls are allowed but still enforced server-side
 * (membership + Grant) — an unauthorized target returns NOT_MEMBER /
 * PERMISSION_DENIED, surfaced here as an MCP tool error.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AgentNexusClient } from "./client.js";
import { ResourceError } from "./client.js";

const channelArg = {
  channel_id: z
    .string()
    .optional()
    .describe("Target channel id. Omit to use the channel this session is bound to."),
};

/** Wrap a client call into the MCP content/result envelope. */
async function run(fn: () => Promise<unknown>) {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const code = err instanceof ResourceError ? err.code : "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    };
  }
}

export function registerTools(server: McpServer, client: AgentNexusClient): void {
  // ── reads ────────────────────────────────────────────────────────────────
  server.registerTool(
    "get_channel_info",
    {
      title: "Get channel info",
      description: "Metadata for a channel: name, type, workspace.",
      inputSchema: { ...channelArg },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id }) => run(() => client.channelInfo(channel_id)),
  );

  server.registerTool(
    "list_members",
    {
      title: "List channel members",
      description: "Users and bots that are members of the channel.",
      inputSchema: { ...channelArg },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id }) => run(() => client.members(channel_id)),
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read recent messages",
      description: "Most recent messages in the channel (newest first).",
      inputSchema: {
        ...channelArg,
        limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id, limit }) => run(() => client.readMessages({ channelId: channel_id, limit })),
  );

  server.registerTool(
    "get_context",
    {
      title: "Get channel context",
      description: "Condensed channel context bundle (topic, pinned info, summary).",
      inputSchema: { ...channelArg },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id }) => run(() => client.context(channel_id)),
  );

  server.registerTool(
    "list_files",
    {
      title: "List channel files",
      description: "Files shared in the channel.",
      inputSchema: { ...channelArg },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id }) => run(() => client.listFiles(channel_id)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a channel file",
      description: "Fetch a file's content/metadata by id.",
      inputSchema: { ...channelArg, file_id: z.string().describe("File id from list_files.") },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id, file_id }) => run(() => client.readFile({ channelId: channel_id, fileId: file_id })),
  );

  server.registerTool(
    "read_memory",
    {
      title: "Read channel memory",
      description: "Persisted memory entries for this channel, within a memory layer.",
      inputSchema: {
        ...channelArg,
        layer: z.string().describe("Memory layer/tier to read (e.g. 'channel', 'task')."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ channel_id, layer }) => run(() => client.readMemory({ channelId: channel_id, layer })),
  );

  // ── writes (Grant-gated) ──────────────────────────────────────────────────
  server.registerTool(
    "post_message",
    {
      title: "Post a message",
      description:
        "Send a message to a channel. Use this for proactive / cross-channel posts; " +
        "the reply to the triggering message goes through the normal agent reply flow, not this tool.",
      inputSchema: {
        ...channelArg,
        text: z.string().min(1).describe("Message body (markdown)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ channel_id, text }) => run(() => client.postMessage({ channelId: channel_id, text })),
  );

  server.registerTool(
    "create_file",
    {
      title: "Create a channel file",
      description: "Upload a file into the channel (base64-encoded bytes).",
      inputSchema: {
        ...channelArg,
        filename: z.string().describe("File name."),
        data_b64: z.string().describe("Base64 of the raw file bytes."),
        content_type: z.string().optional().describe("MIME type."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ channel_id, filename, data_b64, content_type }) =>
      run(() => client.createFile({ channelId: channel_id, filename, dataB64: data_b64, contentType: content_type })),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update channel memory",
      description: "Write memory entries into a channel layer. mode=replace clears the layer first.",
      inputSchema: {
        ...channelArg,
        layer: z.string().describe("Memory layer/tier to write."),
        mode: z.enum(["replace", "merge"]).optional().describe("Default replace."),
        entries: z
          .array(z.object({ title: z.string().optional(), content: z.string() }))
          .describe("Entries to persist."),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ channel_id, layer, mode, entries }) =>
      run(() => client.updateMemory({ channelId: channel_id, layer, mode, entries })),
  );
}
