/**
 * Mock AgentNexus bridge for tests. A local WebSocket server pair maps to
 * `/control` and `/data` streams and simulates the backend protocol.
 *
 * Supports:
 *   - Bearer token validation; missing or mismatched tokens close with 4401.
 *   - Configurable first hello frame with membership snapshot.
 *   - control: manually push channel_joined / channel_left / bot_revoked.
 *   - data: push message, receive reply and send send_ack, replay after resume.
 *   - Exposes supersede() to simulate 4402 old-connection eviction.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import type { ChannelInfo, MessageEvent } from "../src/types.js";

export interface MockBridgeOptions {
  /** Expected bot token (Bearer); mismatches close the connection. */
  botToken: string;
  /** botId used by the first hello frame. */
  botId?: string;
  /** botUsername used by the first hello frame. */
  botUsername?: string;
  /** Membership list sent by the first hello frame. */
  initialMemberships?: ChannelInfo[];
  /** last_event_seq used by the first data hello frame. */
  dataLastEventSeq?: number;
}

interface ConnInfo {
  ws: WebSocket;
  stream: "control" | "data";
}

export class MockBridge {
  private server!: http.Server;
  private wss!: WebSocketServer;
  private conns = new Set<ConnInfo>();
  public port!: number;
  public controlUrl!: string;
  public dataUrl!: string;

  public receivedReplies: Array<Record<string, unknown>> = [];
  public receivedSends: Array<Record<string, unknown>> = [];
  public receivedTraces: Array<Record<string, unknown>> = [];
  public receivedResumes: Array<Record<string, unknown>> = [];
  public receivedPings = 0;

  /** Test injection: auto-send send_ack for reply / send. Defaults to ok=true with random message_id. */
  public autoAckReply: boolean = true;

  constructor(private opts: MockBridgeOptions) {}

  async start(): Promise<void> {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      const path = (req.url || "").split("?")[0];
      if (path !== "/ws/agent-bridge/control" && path !== "/ws/agent-bridge/data") {
        socket.destroy();
        return;
      }
      const auth = req.headers["authorization"] as string | undefined;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || token !== this.opts.botToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const stream: "control" | "data" = path === "/ws/agent-bridge/control" ? "control" : "data";
        this.onConnection(ws, stream);
      });
    });

    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    this.port = addr.port;
    this.controlUrl = `ws://127.0.0.1:${this.port}/ws/agent-bridge/control`;
    this.dataUrl = `ws://127.0.0.1:${this.port}/ws/agent-bridge/data`;
  }

  private onConnection(ws: WebSocket, stream: "control" | "data"): void {
    const info: ConnInfo = { ws, stream };
    this.conns.add(info);

    ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type === "ping") {
        this.receivedPings += 1;
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (stream === "data") {
        if (frame.type === "reply") {
          this.receivedReplies.push(frame);
          if (this.autoAckReply) {
            ws.send(JSON.stringify({
              type: "send_ack",
              client_msg_id: frame.client_msg_id,
              ok: true,
              message_id: `mock-msg-${this.receivedReplies.length}`,
              finalized_placeholder: true,
            }));
          }
          return;
        }
        if (frame.type === "send") {
          this.receivedSends.push(frame);
          if (this.autoAckReply) {
            ws.send(JSON.stringify({
              type: "send_ack",
              client_msg_id: frame.client_msg_id,
              ok: true,
              message_id: `mock-send-${this.receivedSends.length}`,
            }));
          }
          return;
        }
        if (frame.type === "trace") {
          this.receivedTraces.push(frame);
          return;
        }
        if (frame.type === "resume") {
          this.receivedResumes.push(frame);
          // Test on-demand replay; default to resume_ack{replayed:0}.
          ws.send(JSON.stringify({
            type: "resume_ack",
            replayed: 0,
            up_to_seq: this.opts.dataLastEventSeq ?? 0,
          }));
          return;
        }
      }
      // Ignore control frames such as ready.
    });

    ws.on("close", () => {
      this.conns.delete(info);
    });

    // First hello frame.
    if (stream === "control") {
      ws.send(JSON.stringify({
        type: "hello",
        bot_id: this.opts.botId ?? "bot-mock-001",
        bot_username: this.opts.botUsername ?? "mock-bot",
        bot_display_name: "Mock Bot",
        session_id: `sess-${Date.now()}`,
        memberships: this.opts.initialMemberships ?? [],
      }));
    } else {
      ws.send(JSON.stringify({
        type: "hello",
        stream: "data",
        bot_id: this.opts.botId ?? "bot-mock-001",
        session_id: `sess-${Date.now()}`,
        last_event_seq: this.opts.dataLastEventSeq ?? 0,
      }));
    }
  }

  // ===================== test-side controls =====================

  pushChannelJoined(channel: ChannelInfo, invitedBy: string | null = null): void {
    this.broadcast("control", { type: "channel_joined", channel, invited_by: invitedBy });
  }

  pushChannelLeft(channelId: string, reason = "kicked"): void {
    this.broadcast("control", { type: "channel_left", channel_id: channelId, reason });
  }

  pushMessage(ev: Partial<MessageEvent> & { task_id: string; channel_id: string; seq: number }): void {
    const full: MessageEvent = {
      type: "message",
      seq: ev.seq,
      bot_id: this.opts.botId ?? "bot-mock-001",
      bot_username: this.opts.botUsername ?? "mock-bot",
      channel_id: ev.channel_id,
      task_id: ev.task_id,
      placeholder_msg_id: ev.placeholder_msg_id ?? `ph-${ev.task_id}`,
      trigger_message: ev.trigger_message ?? { text: "hi" },
      memory_context: ev.memory_context ?? {},
      attachments: ev.attachments ?? [],
      binding_config: ev.binding_config ?? {},
    };
    this.broadcast("data", full);
  }

  /** Simulate the backend kicking the current connection with 4402 because a new connection arrived. */
  supersede(stream: "control" | "data"): void {
    for (const c of Array.from(this.conns)) {
      if (c.stream === stream) {
        try {
          c.ws.close(4402, "superseded by a new connection");
        } catch {
          /* ignore */
        }
      }
    }
  }

  connectionsFor(stream: "control" | "data"): number {
    return Array.from(this.conns).filter((c) => c.stream === stream).length;
  }

  private broadcast(stream: "control" | "data", obj: unknown): void {
    const payload = JSON.stringify(obj);
    for (const c of this.conns) {
      if (c.stream === stream && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(payload);
      }
    }
  }

  async stop(): Promise<void> {
    for (const c of Array.from(this.conns)) {
      try {
        c.ws.close(1000, "mock shutting down");
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
