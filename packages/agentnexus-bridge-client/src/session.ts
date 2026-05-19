/**
 * BotSession: one OpenClaw account = one AgentNexus bot = one pair of
 * (control, data) WebSockets.
 *
 * Responsibilities:
 *   - Establish and maintain the control + data WebSockets through
 *     ReconnectingClient.
 *   - Control stream: process the hello snapshot and channel_joined/left
 *     events, then maintain the membership set.
 *   - Data stream:
 *       · Receive message frames and call the external onMessage callback.
 *       · Send reply / send frames, track inflight requests by client_msg_id,
 *         and wait for send_ack.
 *       · Resume automatically after reconnect. last_event_seq is currently
 *         persisted in memory.
 *   - Heartbeat: send ping every N seconds and wait for server pong.
 */
import { randomUUID } from "node:crypto";

import { ReconnectingClient } from "./reconnect.js";
import type {
  AttachmentInfo,
  ChannelInfo,
  ControlInbound,
  DataInbound,
  DeltaFrame,
  DoneFrame,
  ErrorFrame,
  FileUploadAck,
  FileUploadFrame,
  MessageEvent,
  ReplyFrame,
  SendAck,
  SendFrame,
  SessionUpdateFrame,
  TerminalAck,
  TraceFrame,
  TriggerMessage,
} from "./types.js";

const DEFAULT_SEND_ACK_TIMEOUT_MS = 10 * 60 * 1000;

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
  /** Original AgentNexus message frame, usable as reply_to_msg_id when replying. */
  event: MessageEvent;
  /** Normalized fields for callers. */
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
  /** Called when AgentNexus dispatches a user message. */
  onMessage?: (m: InboundMessage) => void | Promise<void>;
  /** Called when a member joins a new channel, including bot invitations. */
  onChannelJoined?: (channel: ChannelInfo, invitedBy: string | null) => void;
  /** Called when a member is removed. */
  onChannelLeft?: (channelId: string, reason: string) => void;
  /** Called when the user clicks stop on a streaming bot reply. `msgId` is the
   *  placeholder message id. The plugin should stop pushing deltas for this
   *  message and best-effort abort the underlying LLM/agent call. The server
   *  already finalizes the partial reply when it receives cancel, so omitting a
   *  done frame will not leave the frontend stuck; done is only useful for
   *  cleaner plugin logs. */
  onCancel?: (msgId: string, reason?: string) => void;
  onError?: (err: unknown) => void;
  onFatal?: (reason: string) => void;
  /** Control/data connection state changes for observability. */
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

const MAX_INFLIGHT = 500; // Soft cap; reject new sends above this limit.

export class BotSession {
  public readonly membership: MembershipSnapshot = {
    channelIds: new Set(),
    byId: new Map(),
  };

  public botId: string | null = null;
  public sessionId: string | null = null;
  /** Last locally processed data event seq; used as the resume point after reconnect. */
  public lastProcessedSeq = 0;

  private control: ReconnectingClient;
  private data: ReconnectingClient;
  private heartbeatTimers: Array<NodeJS.Timeout | null> = [null, null];
  private inflight = new Map<string, { resolve: InflightResolver; timer: NodeJS.Timeout }>();
  private inflightUploads = new Map<string, { resolve: (ack: FileUploadAck) => void; timer: NodeJS.Timeout }>();
  private inflightTerminals = new Map<string, { resolve: (ack: TerminalAck) => void; timer: NodeJS.Timeout }>();
  private stopped = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  /** Control hello has arrived. */
  private controlReady = false;
  /** Data hello has arrived. */
  private dataReady = false;

  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly sendAckTimeoutMs: number;
  private dataEverOpened = false;
  private dataBlockedUntilReconnect = false;

  constructor(
    private readonly config: SessionConfig,
    private readonly events: SessionEvents,
  ) {
    const adv = config.advanced ?? {};
    this.reconnectBaseMs = adv.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = adv.reconnectMaxMs ?? 30000;
    this.heartbeatIntervalMs = adv.heartbeatIntervalMs ?? 30000;
    this.sendAckTimeoutMs = adv.sendAckTimeoutMs ?? DEFAULT_SEND_ACK_TIMEOUT_MS;

    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });

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
      onFatal: (reason) => this.onFatalEscalate("control", reason),
    });
    this.data = new ReconnectingClient(config.dataUrl, headers, reconnectOpts, {
      onOpen: () => this.onDataOpen(),
      onFrame: (f) => this.enqueueDataFrame(f),
      onClose: (code, reason) => this.onStreamClose("data", code, reason),
      onFatal: (reason) => this.onFatalEscalate("data", reason),
    });
  }

  start(): void {
    if (this.stopped) throw new Error("session has been stopped; construct a new one");
    this.control.start();
    this.data.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopHeartbeat("control");
    this.stopHeartbeat("data");
    this.rejectAllInflight("session stopped");
    await Promise.all([this.control.stop(), this.data.stop()]);
  }

  /** Wait until both hellos arrive and membership is ready; reject on timeout. */
  waitReady(timeoutMs = 10000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitReady timeout")), timeoutMs);
      this.readyPromise.then(
        () => {
          clearTimeout(t);
          resolve();
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  /** Fatal close code on control or data: stop the whole session and emit onFatal. */
  private onFatalEscalate(stream: "control" | "data", reason: string): void {
    this.events.onFatal?.(`${stream}: ${reason}`);
    void this.stop();
  }

  /** Ready only after both streams receive hello; onReady fires once. */
  private firedReady = false;
  private maybeResolveReady(): void {
    if (!this.controlReady || !this.dataReady) return;
    this.resolveReady();
    if (!this.firedReady) {
      this.firedReady = true;
      this.events.onReady?.();
    }
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
          // Hello is the authoritative membership snapshot, so replace local state.
          this.membership.channelIds.clear();
          this.membership.byId.clear();
          for (const ch of frame.memberships || []) {
            this.membership.channelIds.add(ch.channel_id);
            this.membership.byId.set(ch.channel_id, ch);
          }
          this.controlReady = true;
          this.maybeResolveReady();
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
        case "cancel": {
          // The user stopped generation. The backend already finalized the
          // partial locally; cancel only tells us to stop producing more output.
          if (typeof frame.msg_id === "string" && frame.msg_id) {
            this.events.onCancel?.(frame.msg_id, frame.reason);
          }
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

  private dataFrameQueue: Promise<void> = Promise.resolve();

  private onDataOpen(): void {
    const shouldResume = this.dataEverOpened || this.lastProcessedSeq > 0;
    this.dataEverOpened = true;
    this.dataBlockedUntilReconnect = false;
    this.events.onConnectionChange?.("data", "open");
    this.startHeartbeat("data");
    // Resume missed events after reconnect. A failed first event keeps seq=0,
    // so reconnects still need to request replay from the beginning.
    if (shouldResume) {
      this.data.send({ type: "resume", last_event_seq: this.lastProcessedSeq });
    }
  }

  private enqueueDataFrame(raw: unknown): Promise<void> {
    this.dataFrameQueue = this.dataFrameQueue
      .then(() => this.onDataFrame(raw))
      .catch((err) => {
        this.events.onError?.(err);
      });
    return this.dataFrameQueue;
  }

  private async onDataFrame(raw: unknown): Promise<void> {
    if (!isObject(raw) || typeof raw.type !== "string") return;
    const frame = raw as DataInbound;
    if (this.dataBlockedUntilReconnect) return;
    try {
      switch (frame.type) {
        case "hello":
          // Data hello includes last_event_seq. On the first connection
          // lastProcessedSeq=0, so we do not resume until the agent reports how
          // far it has processed.
          this.dataReady = true;
          this.maybeResolveReady();
          break;
        case "message": {
          const ev = frame as MessageEvent;
          const normalized = this.normalizeInbound(ev);
          try {
            await this.events.onMessage?.(normalized);
          } catch (err) {
            this.events.onError?.(err);
            this.dataBlockedUntilReconnect = true;
            this.data.reconnectNow("message handler failed");
            break;
          }
          if (typeof ev.seq === "number" && ev.seq > this.lastProcessedSeq) {
            this.lastProcessedSeq = ev.seq;
          }
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
        case "file_upload_ack": {
          const ack = frame as FileUploadAck;
          const cid = ack.client_file_id ?? "";
          const entry = this.inflightUploads.get(cid);
          if (entry) {
            clearTimeout(entry.timer);
            this.inflightUploads.delete(cid);
            entry.resolve(ack);
          }
          break;
        }
        case "terminal_ack": {
          const ack = frame as TerminalAck;
          const entry = this.inflightTerminals.get(ack.client_msg_id);
          if (entry) {
            clearTimeout(entry.timer);
            this.inflightTerminals.delete(ack.client_msg_id);
            entry.resolve(ack);
          }
          break;
        }
        case "resume_ack":
          // Phase D: replay has ended; following frames are live events.
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
   * Reply to a message dispatched to the bot and finalize the placeholder.
   * Recommended use: callers receive onMessage, produce a result, then call
   * reply({ source: m, text: ... }).
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

  // ============== streaming reply: delta / done / error ==================
  // Delta remains fire-and-forget because it is high frequency. Terminal frames
  // include client_msg_id and wait for terminal_ack so callers can tell whether
  // the server accepted the finalization request.

  /** Push a single token / chunk into a streaming reply identified by `msgId`. */
  streamDelta(args: { msgId: string; seq: number; delta: string }): boolean {
    if (!this.data.isOpen) return false;
    const frame: DeltaFrame = {
      type: "delta",
      msg_id: args.msgId,
      seq: args.seq,
      delta: args.delta,
    };
    return this.data.send(frame);
  }

  /** End of a streaming reply. Server flushes the buffer + broadcasts
   *  message_done. Optional `fileIds` attaches binary outputs uploaded
   *  during the stream (e.g. images / .md from sendMedia). */
  streamDone(args: { msgId: string; fileIds?: string[] }): Promise<SendResult> {
    const frame: DoneFrame = { type: "done", client_msg_id: randomUUID(), msg_id: args.msgId };
    if (args.fileIds && args.fileIds.length > 0) frame.file_ids = args.fileIds;
    return this.sendTerminalFrame(frame);
  }

  /** Mid-stream error: server finalizes partial with the given message tag. */
  streamError(args: { msgId: string; message: string }): Promise<SendResult> {
    const frame: ErrorFrame = {
      type: "error",
      client_msg_id: randomUUID(),
      msg_id: args.msgId,
      message: args.message,
    };
    return this.sendTerminalFrame(frame);
  }

  /** Best-effort runtime trace/progress event for a bot reply placeholder. */
  trace(args: Omit<TraceFrame, "type">): boolean {
    if (!this.data.isOpen) return false;
    const frame: TraceFrame = { type: "trace", ...args };
    return this.data.send(frame);
  }

  /** Report provider-side session/run identity for debugging and audits. */
  reportProviderSession(args: Omit<SessionUpdateFrame, "type">): boolean {
    if (!this.data.isOpen) return false;
    const frame: SessionUpdateFrame = { type: "session_update", ...args };
    return this.data.send(frame);
  }

  /** Proactively send a message to a channel, for example a scheduled reminder. */
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

  /** Upload a binary file inline over the data WS. Returns the bridge file_id
   *  on success, which can then be referenced in reply / done / send frames.
   *  No HTTP fallback — pure WS path so the plugin only needs WS connectivity. */
  uploadFile(args: {
    channelId: string;
    filename: string;
    data: Uint8Array;
    contentType?: string;
  }): Promise<FileUploadAck> {
    if (!this.data.isOpen) {
      return Promise.resolve({
        type: "file_upload_ack",
        client_file_id: null,
        ok: false,
        code: "ws_not_open",
        error: "data WS not connected",
      });
    }
    const clientFileId = randomUUID();
    const dataB64 = Buffer.from(args.data).toString("base64");
    const frame: FileUploadFrame = {
      type: "file_upload",
      client_file_id: clientFileId,
      channel_id: args.channelId,
      filename: args.filename,
      content_type: args.contentType,
      data_b64: dataB64,
    };
    return new Promise<FileUploadAck>((resolve) => {
      const timer = setTimeout(() => {
        this.inflightUploads.delete(clientFileId);
        resolve({
          type: "file_upload_ack",
          client_file_id: clientFileId,
          ok: false,
          code: "ack_timeout",
          error: "file_upload_ack timeout",
        });
      }, this.sendAckTimeoutMs);
      this.inflightUploads.set(clientFileId, { resolve, timer });
      const sent = this.data.send(frame);
      if (!sent) {
        clearTimeout(timer);
        this.inflightUploads.delete(clientFileId);
        resolve({
          type: "file_upload_ack",
          client_file_id: clientFileId,
          ok: false,
          code: "ws_send_failed",
          error: "data WS send failed",
        });
      }
    });
  }

  private sendFrame<F extends ReplyFrame | SendFrame>(frame: F): Promise<SendResult> {
    if (!this.data.isOpen) {
      return Promise.resolve({ ok: false, error: "data WS not connected", code: "ws_not_open" });
    }
    if (this.inflight.size >= MAX_INFLIGHT) {
      return Promise.resolve({ ok: false, error: "too many inflight messages", code: "backpressure" });
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

  private sendTerminalFrame<F extends DoneFrame | ErrorFrame>(frame: F): Promise<SendResult> {
    if (!this.data.isOpen) {
      return Promise.resolve({ ok: false, error: "data WS not connected", code: "ws_not_open" });
    }
    const clientMsgId = frame.client_msg_id ?? randomUUID();
    frame.client_msg_id = clientMsgId;
    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.inflightTerminals.delete(clientMsgId);
        resolve({ ok: false, error: "terminal_ack timeout", code: "ack_timeout" });
      }, Math.min(this.sendAckTimeoutMs, 30_000));
      this.inflightTerminals.set(clientMsgId, {
        resolve: (ack) => {
          if (ack.ok) {
            resolve({ ok: true, messageId: ack.msg_id });
          } else {
            resolve({ ok: false, error: ack.error, code: ack.code });
          }
        },
        timer,
      });
      const sent = this.data.send(frame);
      if (!sent) {
        clearTimeout(timer);
        this.inflightTerminals.delete(clientMsgId);
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
    for (const [id, entry] of this.inflightUploads) {
      clearTimeout(entry.timer);
      entry.resolve({
        type: "file_upload_ack",
        client_file_id: id,
        ok: false,
        code: "session_closed",
        error: reason,
      });
    }
    this.inflightUploads.clear();
    for (const [id, entry] of this.inflightTerminals) {
      clearTimeout(entry.timer);
      entry.resolve({
        type: "terminal_ack",
        client_msg_id: id,
        ok: false,
        code: "session_closed",
        error: reason,
      });
    }
    this.inflightTerminals.clear();
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
