/**
 * 测试用的 mock AgentNexus bridge —— 一对本地 WS server 对应 `/control` 与 `/data`
 * 两条流，模拟后端协议。
 *
 * 支持：
 *   - Bearer token 校验（缺失 / 不匹配 → close code 4401）
 *   - 可配置的 hello 首帧（membership 快照）
 *   - control: 手动推 channel_joined / channel_left / bot_revoked
 *   - data: 推 message / 收 reply 并回 send_ack / 收 resume 后回指定重放
 *   - 暴露 `supersede()` 模拟 4402 踢旧连接
 */
import http from "node:http";
import { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import type { ChannelInfo, MessageEvent } from "../src/types.js";

export interface MockBridgeOptions {
  /** 期望的 bot token（Bearer）。不匹配时关闭连接。 */
  botToken: string;
  /** hello 首帧使用的 botId */
  botId?: string;
  /** hello 首帧使用的 botUsername */
  botUsername?: string;
  /** hello 首帧下发的成员列表 */
  initialMemberships?: ChannelInfo[];
  /** data hello 首帧的 last_event_seq */
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
  public receivedResumes: Array<Record<string, unknown>> = [];
  public receivedPings = 0;

  /** 注入：当收到 reply / send 时自动回的 send_ack。默认 ok=true，message_id 随机。 */
  public autoAckReply: boolean = true;

  constructor(private opts: MockBridgeOptions) {}

  async start(): Promise<void> {
    this.server = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      const path = (req.url || "").split("?")[0];
      if (path !== "/ws/openclaw/control" && path !== "/ws/openclaw/data") {
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
        const stream: "control" | "data" = path === "/ws/openclaw/control" ? "control" : "data";
        this.onConnection(ws, stream);
      });
    });

    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address() as AddressInfo;
    this.port = addr.port;
    this.controlUrl = `ws://127.0.0.1:${this.port}/ws/openclaw/control`;
    this.dataUrl = `ws://127.0.0.1:${this.port}/ws/openclaw/data`;
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
        if (frame.type === "resume") {
          this.receivedResumes.push(frame);
          // 测试按需重放：默认回 resume_ack{replayed:0}
          ws.send(JSON.stringify({
            type: "resume_ack",
            replayed: 0,
            up_to_seq: this.opts.dataLastEventSeq ?? 0,
          }));
          return;
        }
      }
      // control: ready 等 —— 忽略
    });

    ws.on("close", () => {
      this.conns.delete(info);
    });

    // 首帧 hello
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

  /** 模拟后端把当前连接以 4402 踢下线（新连接上来了）。 */
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
