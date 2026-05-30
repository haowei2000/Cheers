/**
 * Thin typed wrapper over the resource transport. One method per gateway
 * resource (see gateway/src/acp_bridge/resource/mod.rs::dispatch). Channel
 * resolution (explicit arg vs. session default) lives here so every tool
 * behaves consistently.
 */
import type { ResourceResponse, ResourceTransport } from "./transport.js";

export class ResourceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResourceError";
  }
}

export class AgentNexusClient {
  constructor(
    private readonly transport: ResourceTransport,
    private readonly defaultChannelId?: string,
  ) {}

  /** Resolve the target channel: explicit arg wins, else the bound session channel. */
  resolveChannel(channelId?: string): string {
    const id = channelId ?? this.defaultChannelId;
    if (!id) {
      throw new ResourceError(
        "NO_CHANNEL",
        "no channel_id provided and this session is not bound to a channel",
      );
    }
    return id;
  }

  private async call(resource: string, params: Record<string, unknown>): Promise<unknown> {
    const res: ResourceResponse = await this.transport.request({ resource, params });
    if (!res.ok) {
      throw new ResourceError(res.code ?? "UNKNOWN", res.error ?? "resource call failed");
    }
    return res.data;
  }

  // ── reads (channel membership only) ──────────────────────────────────────
  channelInfo(channelId?: string) {
    return this.call("channel.info", { channel_id: this.resolveChannel(channelId) });
  }
  members(channelId?: string) {
    return this.call("channel.members", { channel_id: this.resolveChannel(channelId) });
  }
  readMessages(args: { channelId?: string; limit?: number }) {
    return this.call("channel.messages", {
      channel_id: this.resolveChannel(args.channelId),
      limit: args.limit,
    });
  }
  context(channelId?: string) {
    return this.call("channel.context", { channel_id: this.resolveChannel(channelId) });
  }
  listFiles(channelId?: string) {
    return this.call("channel.files", { channel_id: this.resolveChannel(channelId) });
  }
  readFile(args: { channelId?: string; fileId: string }) {
    return this.call("channel.files.read", {
      channel_id: this.resolveChannel(args.channelId),
      file_id: args.fileId,
    });
  }
  /** `layer` selects which memory tier to read (the gateway requires it). */
  readMemory(args: { channelId?: string; layer: string }) {
    return this.call("channel.memory", {
      channel_id: this.resolveChannel(args.channelId),
      layer: args.layer,
    });
  }

  // ── writes (membership + Grant) ──────────────────────────────────────────
  // NOTE: the gateway create handler currently reads `content` + `msg_type`
  // only; threaded replies (reply_to_msg_id) are not wired server-side yet.
  postMessage(args: { channelId?: string; text: string; msgType?: string }) {
    return this.call("channel.messages.create", {
      channel_id: this.resolveChannel(args.channelId),
      content: args.text,
      msg_type: args.msgType ?? "text",
    });
  }
  createFile(args: { channelId?: string; filename: string; dataB64: string; contentType?: string }) {
    return this.call("channel.files.create", {
      channel_id: this.resolveChannel(args.channelId),
      filename: args.filename,
      data_b64: args.dataB64,
      content_type: args.contentType,
    });
  }
  /** Memory writes are layered + entry-based: `mode` replace|merge, entries[]. */
  updateMemory(args: {
    channelId?: string;
    layer: string;
    mode?: "replace" | "merge";
    entries: Array<{ title?: string; content: string }>;
  }) {
    return this.call("channel.memory.update", {
      channel_id: this.resolveChannel(args.channelId),
      layer: args.layer,
      mode: args.mode ?? "replace",
      entries: args.entries,
    });
  }
}
