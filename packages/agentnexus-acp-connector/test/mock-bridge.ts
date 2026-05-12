import http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import type { MessageEvent } from "@haowei0520/bridge-client";

export class MockBridge {
  private server!: http.Server;
  private wss!: WebSocketServer;
  private conns = new Set<{ ws: WebSocket; stream: "control" | "data" }>();
  public controlUrl = "";
  public dataUrl = "";
  public receivedDeltas: Array<Record<string, unknown>> = [];
  public receivedDones: Array<Record<string, unknown>> = [];
  public receivedErrors: Array<Record<string, unknown>> = [];
  public receivedReplies: Array<Record<string, unknown>> = [];
  public receivedTraces: Array<Record<string, unknown>> = [];

  constructor(private readonly botToken = "agb_test") {}

  async start(): Promise<void> {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.botToken}`) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const path = (req.url || "").split("?")[0];
      if (path !== "/ws/agent-bridge/control" && path !== "/ws/agent-bridge/data") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, path.endsWith("/control") ? "control" : "data");
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.controlUrl = `ws://127.0.0.1:${port}/ws/agent-bridge/control`;
    this.dataUrl = `ws://127.0.0.1:${port}/ws/agent-bridge/data`;
  }

  pushMessage(ev: Partial<MessageEvent> & { task_id: string; channel_id: string; seq: number }): void {
    const frame: MessageEvent = {
      type: "message",
      seq: ev.seq,
      bot_id: "bot-acp",
      bot_username: "acp",
      channel_id: ev.channel_id,
      task_id: ev.task_id,
      placeholder_msg_id: ev.placeholder_msg_id ?? `ph-${ev.task_id}`,
      trigger_message: ev.trigger_message ?? { text: "hello" },
      memory_context: ev.memory_context ?? {},
      attachments: ev.attachments ?? [],
      binding_config: ev.binding_config ?? {},
      provider_session_key: ev.provider_session_key,
      session: ev.session,
    };
    this.broadcast("data", frame);
  }

  connectionsFor(stream: "control" | "data"): number {
    return Array.from(this.conns).filter((c) => c.stream === stream).length;
  }

  async stop(): Promise<void> {
    for (const c of Array.from(this.conns)) c.ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handleConnection(ws: WebSocket, stream: "control" | "data"): void {
    this.conns.add({ ws, stream });
    ws.on("close", () => {
      for (const c of Array.from(this.conns)) {
        if (c.ws === ws) this.conns.delete(c);
      }
    });
    ws.on("message", (raw) => this.handleFrame(ws, stream, raw.toString()));
    if (stream === "control") {
      ws.send(JSON.stringify({
        type: "hello",
        bot_id: "bot-acp",
        bot_username: "acp",
        session_id: "bridge-control",
        memberships: [{ channel_id: "C1", channel_name: "general" }],
      }));
    } else {
      ws.send(JSON.stringify({
        type: "hello",
        stream: "data",
        bot_id: "bot-acp",
        session_id: "bridge-data",
        last_event_seq: 0,
      }));
    }
  }

  private handleFrame(ws: WebSocket, stream: "control" | "data", raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (stream !== "data") return;
    if (frame.type === "delta") this.receivedDeltas.push(frame);
    if (frame.type === "done") this.receivedDones.push(frame);
    if (frame.type === "error") this.receivedErrors.push(frame);
    if (frame.type === "trace") this.receivedTraces.push(frame);
    if (frame.type === "reply") {
      this.receivedReplies.push(frame);
      ws.send(JSON.stringify({
        type: "send_ack",
        client_msg_id: frame.client_msg_id,
        ok: true,
        message_id: "reply-1",
        finalized_placeholder: true,
      }));
    }
  }

  private broadcast(stream: "control" | "data", frame: unknown): void {
    const payload = JSON.stringify(frame);
    for (const c of this.conns) {
      if (c.stream === stream && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(payload);
      }
    }
  }
}
