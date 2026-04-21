/**
 * BotSession：一个 OpenClaw account = 一个 AgentNexus bot = 一对 (control, data) WS。
 *
 * 职责：
 *   - 建立并维护 control + data 两条 WS（通过 ReconnectingClient）
 *   - control 流：处理 hello 快照 + channel_joined/left 事件，维护 membership 集合
 *   - data 流：
 *       · 收到 message 帧 → 调用外部 onMessage callback（上层把它翻译成 OpenClaw 消息）
 *       · 发送 reply / send 帧，按 client_msg_id 记录 inflight，等 send_ack
 *       · 重连后自动 resume（last_event_seq 本地持久 —— 这里先存内存）
 *   - heartbeat：每 N 秒发 ping，服务器回 pong
 */
import { randomUUID } from "node:crypto";

import { ReconnectingClient } from "./reconnect.js";
import type {
  AttachmentInfo,
  ChannelInfo,
  ControlInbound,
  DataInbound,
  MessageEvent,
  ReplyFrame,
  SendAck,
  SendFrame,
  TriggerMessage,
} from "./types.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export interface SessionConfig {
  botToken: string;
  controlUrl: string;
  dataUrl: string;
  advanced?: {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    heartbeatIntervalMs?: number;
    sendAckTimeoutMs?: number;
  };
}

export interface InboundMessage {
  /** 原始 AgentNexus message frame（可用于回复时 reply_to_msg_id） */
  event: MessageEvent;
  /** 便于上层使用的归一字段 */
  channelId: string;
  senderId: string | undefined;
  senderName: string | undefined;
  text: string;
  timestamp: Date | undefined;
  threadId: string | undefined;
  attachments: AttachmentInfo[];
  trigger: TriggerMessage;
}

export interface MembershipSnapshot {
  channelIds: Set<string>;
  byId: Map<string, ChannelInfo>;
}

export interface SessionEvents {
  onReady?: () => void;
  /** 收到 AgentNexus 派发的用户消息 */
  onMessage?: (m: InboundMessage) => void | Promise<void>;
  /** 成员加入新频道（bot 被邀请时） */
  onChannelJoined?: (channel: ChannelInfo, invitedBy: string | null) => void;
  /** 成员被移除 */
  onChannelLeft?: (channelId: string, reason: string) => void;
  onError?: (err: unknown) => void;
  onFatal?: (reason: string) => void;
  /** control/data 连接状态变更（observability） */
  onConnectionChange?: (stream: "control" | "data", state: "open" | "closed") => void;
}

type InflightResolver = (ack: SendAck) => void;

export interface SendResult {
  ok: boolean;
  messageId?: string;
  finalizedPlaceholder?: boolean;
  error?: string;
  code?: string;
}

export class BotSession {
  public readonly membership: MembershipSnapshot = {
    channelIds: new Set(),
    byId: new Map(),
  };

  public botId: string | null = null;
  public sessionId: string | null = null;
  /** 本地跟踪的最后一次已处理 data 事件 seq；重连后作为 resume 起点 */
  public lastProcessedSeq = 0;

  private control: ReconnectingClient;
  private data: ReconnectingClient;
  private heartbeatTimers: Array<NodeJS.Timeout | null> = [null, null];
  private inflight = new Map<string, { resolve: InflightResolver; timer: NodeJS.Timeout }>();

  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly sendAckTimeoutMs: number;

  constructor(
    private readonly config: SessionConfig,
    private readonly events: SessionEvents,
  ) {
    const adv = config.advanced ?? {};
    this.reconnectBaseMs = adv.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = adv.reconnectMaxMs ?? 30000;
    this.heartbeatIntervalMs = adv.heartbeatIntervalMs ?? 30000;
    this.sendAckTimeoutMs = adv.sendAckTimeoutMs ?? 10000;

    const headers = { Authorization: `Bearer ${config.botToken}` };
    const reconnectOpts = {
      baseMs: this.reconnectBaseMs,
      maxMs: this.reconnectMaxMs,
      resetAfterMs: 30000,
    };

    this.control = new ReconnectingClient(config.controlUrl, headers, reconnectOpts, {
      onOpen: () => this.onControlOpen(),
      onFrame: (f) => this.onControlFrame(f),
      onClose: (code, reason) => this.onStreamClose("control", code, reason),
      onFatal: (reason) => this.events.onFatal?.(reason),
    });
    this.data = new ReconnectingClient(config.dataUrl, headers, reconnectOpts, {
      onOpen: () => this.onDataOpen(),
      onFrame: (f) => this.onDataFrame(f),
      onClose: (code, reason) => this.onStreamClose("data", code, reason),
      onFatal: (reason) => this.events.onFatal?.(reason),
    });
  }

  start(): void {
    this.control.start();
    this.data.start();
  }

  async stop(): Promise<void> {
    this.stopHeartbeat("control");
    this.stopHeartbeat("data");
    this.rejectAllInflight("session stopped");
    await Promise.all([this.control.stop(), this.data.stop()]);
  }

  // =================== control stream ===================

  private onControlOpen(): void {
    this.events.onConnectionChange?.("control", "open");
    this.startHeartbeat("control");
  }

  private onControlFrame(raw: unknown): void {
    if (!isObject(raw) || typeof raw.type !== "string") return;
    const frame = raw as ControlInbound;
    try {
      switch (frame.type) {
        case "hello": {
          this.botId = frame.bot_id;
          this.sessionId = frame.session_id;
          // Hello 是 membership 的权威快照：替换本地状态
          this.membership.channelIds.clear();
          this.membership.byId.clear();
          for (const ch of frame.memberships || []) {
            this.membership.channelIds.add(ch.channel_id);
            this.membership.byId.set(ch.channel_id, ch);
          }
          this.events.onReady?.();
          break;
        }
        case "channel_joined": {
          const ch = frame.channel;
          this.membership.channelIds.add(ch.channel_id);
          this.membership.byId.set(ch.channel_id, ch);
          this.events.onChannelJoined?.(ch, frame.invited_by ?? null);
          break;
        }
        case "channel_left": {
          this.membership.channelIds.delete(frame.channel_id);
          this.membership.byId.delete(frame.channel_id);
          this.events.onChannelLeft?.(frame.channel_id, frame.reason);
          break;
        }
        case "pong":
          break;
        default:
          // Unknown control frame — keep for forward compat
          break;
      }
    } catch (err) {
      this.events.onError?.(err);
    }
  }

  // =================== data stream ===================

  private onDataOpen(): void {
    this.events.onConnectionChange?.("data", "open");
    this.startHeartbeat("data");
    // 断线重连后立即 resume 漏收的事件
    if (this.lastProcessedSeq > 0) {
      this.data.send({ type: "resume", last_event_seq: this.lastProcessedSeq });
    }
  }

  private onDataFrame(raw: unknown): void {
    if (!isObject(raw) || typeof raw.type !== "string") return;
    const frame = raw as DataInbound;
    try {
      switch (frame.type) {
        case "hello":
          // data hello 给 last_event_seq，首次连接时 lastProcessedSeq=0，
          // 不主动 resume；等 agent 自己说它处理到哪了。
          break;
        case "message": {
          const ev = frame as MessageEvent;
          // 更新本地 seq；允许上层在处理完业务逻辑后再 bumpSeq 来做 exactly-once。
          // 这里先用宽松策略：一见即更新。
          if (typeof ev.seq === "number" && ev.seq > this.lastProcessedSeq) {
            this.lastProcessedSeq = ev.seq;
          }
          const normalized = this.normalizeInbound(ev);
          void this.events.onMessage?.(normalized);
          break;
        }
        case "send_ack": {
          const ack = frame as SendAck;
          const entry = this.inflight.get(ack.client_msg_id);
          if (entry) {
            clearTimeout(entry.timer);
            this.inflight.delete(ack.client_msg_id);
            entry.resolve(ack);
          }
          break;
        }
        case "resume_ack":
          // Phase D：重放已结束，后续是实时事件
          break;
        case "pong":
          break;
        default:
          break;
      }
    } catch (err) {
      this.events.onError?.(err);
    }
  }

  private normalizeInbound(ev: MessageEvent): InboundMessage {
    const t = ev.trigger_message || {};
    const ts = typeof t.timestamp === "string" ? new Date(t.timestamp) : undefined;
    return {
      event: ev,
      channelId: ev.channel_id,
      senderId: typeof t.user === "string" ? t.user : undefined,
      senderName: typeof t.sender_name === "string" ? t.sender_name : undefined,
      text: typeof t.text === "string" ? t.text : "",
      timestamp: ts && !isNaN(ts.getTime()) ? ts : undefined,
      threadId: typeof t.in_reply_to_msg_id === "string" ? t.in_reply_to_msg_id : undefined,
      attachments: Array.isArray(ev.attachments) ? ev.attachments : [],
      trigger: t,
    };
  }

  // =================== outbound ===================

  /**
   * 回复一条派发给 Bot 的消息：finalize 占位。推荐用法——上层收到 onMessage 后，
   * 产出结果调用 reply({ source: m, text: ... }).
   */
  async reply(args: {
    source: InboundMessage;
    text: string;
    fileIds?: string[];
  }): Promise<SendResult> {
    const { source, text, fileIds } = args;
    return this.sendFrame<ReplyFrame>({
      type: "reply",
      client_msg_id: randomUUID(),
      task_id: source.event.task_id,
      reply_to_msg_id: source.event.placeholder_msg_id ?? null,
      channel_id: source.channelId,
      text,
      file_ids: fileIds,
    });
  }

  /** 非响应式主动发一条消息到频道（例如定时提醒）。 */
  async send(args: {
    channelId: string;
    text: string;
    inReplyToMsgId?: string | null;
    fileIds?: string[];
  }): Promise<SendResult> {
    return this.sendFrame<SendFrame>({
      type: "send",
      client_msg_id: randomUUID(),
      channel_id: args.channelId,
      text: args.text,
      in_reply_to_msg_id: args.inReplyToMsgId ?? null,
      file_ids: args.fileIds,
    });
  }

  private sendFrame<F extends ReplyFrame | SendFrame>(frame: F): Promise<SendResult> {
    if (!this.data.isOpen) {
      return Promise.resolve({ ok: false, error: "data WS not connected", code: "ws_not_open" });
    }
    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.inflight.delete(frame.client_msg_id);
        resolve({ ok: false, error: "send_ack timeout", code: "ack_timeout" });
      }, this.sendAckTimeoutMs);
      this.inflight.set(frame.client_msg_id, {
        resolve: (ack) => {
          if (ack.ok) {
            resolve({
              ok: true,
              messageId: ack.message_id,
              finalizedPlaceholder: ack.finalized_placeholder,
            });
          } else {
            resolve({ ok: false, error: ack.error, code: ack.code });
          }
        },
        timer,
      });
      const sent = this.data.send(frame);
      if (!sent) {
        clearTimeout(timer);
        this.inflight.delete(frame.client_msg_id);
        resolve({ ok: false, error: "data WS send failed", code: "ws_send_failed" });
      }
    });
  }

  private rejectAllInflight(reason: string): void {
    for (const [id, entry] of this.inflight) {
      clearTimeout(entry.timer);
      entry.resolve({ type: "send_ack", client_msg_id: id, ok: false, error: reason, code: "session_closed" });
    }
    this.inflight.clear();
  }

  // =================== heartbeat / close ===================

  private onStreamClose(stream: "control" | "data", _code: number, _reason: string): void {
    this.stopHeartbeat(stream);
    this.events.onConnectionChange?.(stream, "closed");
    if (stream === "data") {
      this.rejectAllInflight("data ws closed");
    }
  }

  private startHeartbeat(stream: "control" | "data"): void {
    this.stopHeartbeat(stream);
    const idx = stream === "control" ? 0 : 1;
    this.heartbeatTimers[idx] = setInterval(() => {
      const client = stream === "control" ? this.control : this.data;
      client.send({ type: "ping" });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(stream: "control" | "data"): void {
    const idx = stream === "control" ? 0 : 1;
    const t = this.heartbeatTimers[idx];
    if (t) {
      clearInterval(t);
      this.heartbeatTimers[idx] = null;
    }
  }
}
