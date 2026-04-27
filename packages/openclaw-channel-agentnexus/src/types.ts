/**
 * AgentNexus bridge WebSocket protocol —— 与 backend/app/api/v1/openclaw_bridge/routes.py
 * 保持对齐。如果服务端协议变化，这里的类型也要同步更新。
 *
 * Bot 的每个 WS 连接（control / data）只代表一个 AgentNexus bot_id；鉴权用 bot token。
 */

// ============ Close codes ============
export const WS_CLOSE_AUTH_FAIL = 4401;
export const WS_CLOSE_SUPERSEDED = 4402;
export const WS_CLOSE_BOT_UNAVAILABLE = 4403;

// ============ Control stream ============

export interface ChannelInfo {
  channel_id: string;
  channel_name?: string | null;
  channel_type?: string | null;
  workspace_id?: string | null;
  joined_at?: string | null;
}

export interface ControlHello {
  type: "hello";
  bot_id: string;
  bot_username: string;
  bot_display_name?: string | null;
  session_id: string;
  memberships: ChannelInfo[];
}

export interface ChannelJoinedEvent {
  type: "channel_joined";
  channel: ChannelInfo;
  invited_by?: string | null;
}

export interface ChannelLeftEvent {
  type: "channel_left";
  channel_id: string;
  reason: "kicked" | "left" | string;
}

export interface PongFrame {
  type: "pong";
}

/** Server pushes this on the control stream when a user clicks the ⏹ button
 *  on a streaming bot reply. The plugin should stop emitting deltas for the
 *  given msg_id and (best-effort) abort whatever LLM/agent run is producing
 *  the answer. */
export interface CancelInbound {
  type: "cancel";
  msg_id: string;
  reason?: string;
}

export type ControlInbound =
  | ControlHello
  | ChannelJoinedEvent
  | ChannelLeftEvent
  | CancelInbound
  | PongFrame
  | { type: "error"; detail?: string };

// client → server
export interface PingFrame {
  type: "ping";
}

export interface ReadyFrame {
  type: "ready";
  plugin_version?: string;
}

// ============ Data stream ============

export interface TriggerMessage {
  user?: string;
  sender_name?: string;
  text?: string;
  timestamp?: string;
  msg_id?: string;
  in_reply_to_msg_id?: string | null;
  msg_type?: string;
  thread_history?: unknown;
  child_replies?: unknown;
  [k: string]: unknown;
}

export interface AttachmentInfo {
  file_id?: string;
  filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  summary?: string | null;
}

export interface DataHello {
  type: "hello";
  stream: "data";
  bot_id: string;
  session_id: string;
  last_event_seq: number;
}

export interface MessageEvent {
  type: "message";
  seq: number;
  bot_id: string;
  bot_username?: string;
  bot_display_name?: string | null;
  channel_id: string;
  task_id: string;
  placeholder_msg_id?: string | null;
  trigger_message: TriggerMessage;
  memory_context: Record<string, string>;
  attachments: AttachmentInfo[];
  binding_config?: Record<string, unknown>;
}

export interface SendAckOk {
  type: "send_ack";
  client_msg_id: string;
  ok: true;
  message_id: string;
  finalized_placeholder?: boolean;
}

export interface SendAckErr {
  type: "send_ack";
  client_msg_id: string;
  ok: false;
  error: string;
  code: string;
}

export type SendAck = SendAckOk | SendAckErr;

export interface ResumeAck {
  type: "resume_ack";
  replayed: number;
  up_to_seq: number;
}

export type DataInbound =
  | DataHello
  | MessageEvent
  | SendAck
  | ResumeAck
  | PongFrame
  | { type: "error"; detail?: string };

// client → server
export interface ReplyFrame {
  type: "reply";
  client_msg_id: string;
  task_id?: string | null;
  reply_to_msg_id?: string | null;
  channel_id?: string | null;
  text: string;
  file_ids?: string[];
}

export interface SendFrame {
  type: "send";
  client_msg_id: string;
  channel_id: string;
  text: string;
  in_reply_to_msg_id?: string | null;
  file_ids?: string[];
}

export interface TypingFrame {
  type: "typing";
  channel_id: string;
}

export interface ResumeFrame {
  type: "resume";
  last_event_seq: number;
}

// ---- Streaming reply frames (client → server, fire-and-forget, no ack) ----

/** One token / chunk of a streaming bot reply. The server appends `delta`
 *  to the placeholder identified by `msg_id` and broadcasts a
 *  `message_stream` event so the frontend can render it incrementally. */
export interface DeltaFrame {
  type: "delta";
  msg_id: string;
  /** Monotonic per-stream sequence; out-of-order frames are dropped server-side. */
  seq: number;
  delta: string;
}

/** End of a streaming reply. Server flushes the buffer to the placeholder
 *  Message and broadcasts `message_done`. Idempotent.
 *
 *  `file_ids` lets the plugin attach binary outputs (uploaded via the
 *  /openclaw/bridge/files/upload-binary HTTP route while the stream was in
 *  flight) to the same finalized message — so a "正在打字 → 文件浮现" UX
 *  shows up as a single bot reply, not text + a separate media message. */
export interface DoneFrame {
  type: "done";
  msg_id: string;
  file_ids?: string[];
}

/** Plugin reports a mid-stream error. Server finalizes the placeholder with
 *  `is_partial=true` and includes `message` in the message_done event. */
export interface ErrorFrame {
  type: "error";
  msg_id: string;
  message: string;
}
