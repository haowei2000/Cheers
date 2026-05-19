import http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import type { MessageEvent } from "@haowei0520/bridge-client";

export class MockBridge {
  private server!: http.Server;
  private wss!: WebSocketServer;
  private conns = new Set<{ ws: WebSocket; stream: "control" | "data" }>();
  private readonly textFiles = new Map<string, {
    filename: string;
    contentType: string;
    content: string;
    truncated?: boolean;
    summary?: string;
  }>();
  private readonly binaryFiles = new Map<string, {
    filename: string;
    contentType: string;
    data: Uint8Array;
    summary?: string;
  }>();
  public controlUrl = "";
  public dataUrl = "";
  public receivedDeltas: Array<Record<string, unknown>> = [];
  public receivedDones: Array<Record<string, unknown>> = [];
  public receivedErrors: Array<Record<string, unknown>> = [];
  public receivedReplies: Array<Record<string, unknown>> = [];
  public receivedTraces: Array<Record<string, unknown>> = [];
  public receivedUploads: Array<Record<string, unknown>> = [];
  public receivedConfigStatuses: Array<Record<string, unknown>> = [];

  constructor(private readonly botToken = "agb_test") {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
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

  setTextFile(
    fileId: string,
    file: { filename: string; contentType: string; content: string; truncated?: boolean; summary?: string },
  ): void {
    this.textFiles.set(fileId, file);
  }

  setBinaryFile(
    fileId: string,
    file: { filename: string; contentType: string; data: Uint8Array; summary?: string },
  ): void {
    this.binaryFiles.set(fileId, file);
  }

  pushConfigUpdate(frame: {
    revision?: number | string | null;
    settings?: Record<string, unknown>;
    updated_at?: string | null;
  }): void {
    this.broadcast("control", {
      type: "config_update",
      revision: frame.revision ?? null,
      settings: frame.settings ?? {},
      updated_at: frame.updated_at ?? null,
    });
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
    if (stream === "control" && frame.type === "config_status") {
      this.receivedConfigStatuses.push(frame);
      return;
    }
    if (stream !== "data") return;
    if (frame.type === "delta") this.receivedDeltas.push(frame);
    if (frame.type === "done") {
      this.receivedDones.push(frame);
      if (typeof frame.client_msg_id === "string") {
        ws.send(JSON.stringify({
          type: "terminal_ack",
          client_msg_id: frame.client_msg_id,
          ok: true,
          msg_id: frame.msg_id,
          queued: true,
        }));
      }
    }
    if (frame.type === "error") {
      this.receivedErrors.push(frame);
      if (typeof frame.client_msg_id === "string") {
        ws.send(JSON.stringify({
          type: "terminal_ack",
          client_msg_id: frame.client_msg_id,
          ok: true,
          msg_id: frame.msg_id,
          queued: true,
        }));
      }
    }
    if (frame.type === "trace") this.receivedTraces.push(frame);
    if (frame.type === "file_upload") {
      this.receivedUploads.push(frame);
      ws.send(JSON.stringify({
        type: "file_upload_ack",
        client_file_id: frame.client_file_id,
        ok: true,
        file_id: `file-${this.receivedUploads.length}`,
        filename: frame.filename,
        content_type: frame.content_type || "application/octet-stream",
        size_bytes: Buffer.from(String(frame.data_b64 || ""), "base64").byteLength,
      }));
      return;
    }
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

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers.authorization !== `Bearer ${this.botToken}`) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    const path = (req.url || "").split("?")[0];
    const contentMatch = /^\/api\/v1\/agent-bridge\/files\/([^/]+)\/content$/.exec(path);
    if (contentMatch) {
      const fileId = decodeURIComponent(contentMatch[1]);
      const file = this.textFiles.get(fileId);
      if (!file) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      this.writeJson(res, {
        status: "success",
        data: {
          file_id: fileId,
          filename: file.filename,
          content_type: file.contentType,
          size_bytes: Buffer.byteLength(file.content, "utf8"),
          summary: file.summary || "",
          content: file.content,
          truncated: file.truncated || false,
        },
      });
      return;
    }
    const binaryMatch = /^\/api\/v1\/agent-bridge\/files\/([^/]+)\/binary$/.exec(path);
    if (binaryMatch) {
      const fileId = decodeURIComponent(binaryMatch[1]);
      const file = this.binaryFiles.get(fileId);
      if (!file) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      this.writeJson(res, {
        status: "success",
        data: {
          file_id: fileId,
          filename: file.filename,
          content_type: file.contentType,
          size_bytes: file.data.byteLength,
          data_b64: Buffer.from(file.data).toString("base64"),
        },
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }

  private writeJson(res: http.ServerResponse, body: unknown): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
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
