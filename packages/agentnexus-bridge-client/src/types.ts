/**
 * AgentNexus bridge WebSocket protocol. Keep this aligned with
 * gateway/src/transport/ws/acp_bridge.rs. Update these types whenever the
 * server protocol changes.
 *
 * Each bot WebSocket connection (control / data) represents exactly one
 * AgentNexus bot_id and authenticates with the bot token.
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

export type ConnectorPermissionMode = "ask" | "reject" | "allow" | "cancel";

export interface ConnectorControlSettings {
  agentnexusApprovalMode?: ConnectorPermissionMode;
  agentNativePermissionMode?: string;
  /** @deprecated Use agentnexusApprovalMode. */
  permissionMode?: ConnectorPermissionMode;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  cwd?: string;
  model?: string;
  configOptions?: Record<string, string>;
}

export interface ConnectorControlConfig {
  revision?: number | string | null;
  settings?: ConnectorControlSettings;
  updated_at?: string | null;
  last_status?: Record<string, unknown> | null;
  options?: Record<string, unknown> | null;
}

export interface AcpSecurityHello {
  enabled?: boolean;
  mode?: string;
  algorithm?: string;
  require_capability?: boolean;
  allow_plaintext_fallback?: boolean;
  phase?: string;
}

export interface AcpCapabilityEnvelope {
  delegation_id: string;
  ts: number;
  nonce: string;
  signature: string;
  request_id?: string;
  algorithm?: string;
  kid?: string;
}

export interface ControlHello {
  type: "hello";
  bot_id: string;
  bot_username: string;
  bot_display_name?: string | null;
  connection_id?: string;
  session_id: string;
  memberships: ChannelInfo[];
  acp_security?: AcpSecurityHello | null;
  connector_config?: ConnectorControlConfig | null;
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

export interface ConfigUpdateInbound {
  type: "config_update";
  revision?: number | string | null;
  settings?: ConnectorControlSettings;
  updated_at?: string | null;
}

export interface ConfigOptionSetInbound {
  type: "config_option_set";
  request_id: string;
  session_id?: string | null;
  provider_session_key?: string | null;
  config_id: string;
  value: string;
  updated_at?: string | null;
}

export interface PermissionResolutionInbound {
  type: "permission_resolution";
  request_id: string;
  message_id?: string | null;
  resolution: "allow" | "deny";
  option_id?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
}

export type ControlInbound =
  | ControlHello
  | ChannelJoinedEvent
  | ChannelLeftEvent
  | CancelInbound
  | ConfigUpdateInbound
  | ConfigOptionSetInbound
  | PermissionResolutionInbound
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

export interface ConfigStatusFrame {
  type: "config_status";
  revision?: number | string | null;
  ok: boolean;
  applied?: string[];
  rejected?: Array<{ field: string; reason: string }>;
  error?: string;
}

export interface ConfigOptionsFrame {
  type: "config_options";
  options: Record<string, unknown>;
}

export interface ConfigOptionStatusFrame {
  type: "config_option_status";
  request_id?: string | null;
  ok: boolean;
  session_id?: string | null;
  provider_session_key?: string | null;
  config_id?: string | null;
  value?: string | null;
  error?: string | null;
  options?: Record<string, unknown> | null;
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
  is_image?: string | boolean | null;
  image_b64?: string | null;
}

export interface DataHello {
  type: "hello";
  stream: "data";
  bot_id: string;
  connection_id?: string;
  session_id: string;
  last_event_seq: number;
  acp_security?: AcpSecurityHello | null;
}

export interface AgentNexusSessionRef {
  id?: string;
  provider_session_key?: string;
  provider_session_id?: string;
  provider_account_id?: string;
  provider_agent_id?: string;
  primary_scope_type?: string;
  primary_scope_id?: string;
  task_scope_id?: string;
  [k: string]: unknown;
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
  session?: AgentNexusSessionRef;
  provider_session_key?: string;
  provider_session_id?: string;
}

export interface SendAckOk {
  type: "send_ack";
  client_msg_id: string;
  ok: true;
  message_id: string;
  finalized_placeholder?: boolean;
  permission_resolution?: (PermissionResolutionInbound & {
    outcome?: "selected" | "cancelled";
  });
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

export interface FileUploadAckOk {
  type: "file_upload_ack";
  client_file_id?: string | null;
  ok: true;
  file_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  preview_url?: string;
  download_url?: string;
}

export interface FileUploadAckErr {
  type: "file_upload_ack";
  client_file_id?: string | null;
  ok: false;
  code: string;
  error: string;
}

export type FileUploadAck = FileUploadAckOk | FileUploadAckErr;

export interface TerminalAckOk {
  type: "terminal_ack";
  client_msg_id: string;
  ok: true;
  msg_id: string;
  queued?: boolean;
  job_id?: string;
}

export interface TerminalAckErr {
  type: "terminal_ack";
  client_msg_id: string;
  ok: false;
  error: string;
  code: string;
}

export type TerminalAck = TerminalAckOk | TerminalAckErr;

export type DataInbound =
  | DataHello
  | MessageEvent
  | SendAck
  | FileUploadAck
  | TerminalAck
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
  session_id?: string;
  provider_session_key?: string | null;
  provider_session_id?: string;
  acp_capability?: AcpCapabilityEnvelope;
}

export interface SendFrame {
  type: "send";
  client_msg_id: string;
  channel_id: string;
  text: string;
  in_reply_to_msg_id?: string | null;
  file_ids?: string[];
  session_id?: string;
  provider_session_key?: string | null;
  provider_session_id?: string;
  acp_capability?: AcpCapabilityEnvelope;
}

export interface PermissionRequestOption {
  option_id: string;
  kind?: string;
  name?: string;
  description?: string;
}

export interface PermissionRequestFrame {
  type: "permission_request";
  client_msg_id: string;
  channel_id: string;
  request_id: string;
  task_id?: string | null;
  msg_id?: string | null;
  acp_session_id?: string | null;
  provider_session_key?: string | null;
  provider_session_id?: string;
  session_id?: string;
  title?: string | null;
  body: string;
  tool?: string | null;
  options?: PermissionRequestOption[];
  acp_capability?: AcpCapabilityEnvelope;
}

export interface TypingFrame {
  type: "typing";
  channel_id: string;
}

/** Lightweight progress/trace event from the OpenClaw runtime. These frames
 *  are intentionally small and best-effort: the bridge validates msg_id/bot_id
 *  and broadcasts them to browsers, but does not persist them. */
export interface TraceFrame {
  type: "trace";
  msg_id: string;
  task_id?: string;
  channel_id?: string;
  run_id?: string;
  session_key?: string;
  provider_session_key?: string | null;
  provider_session_id?: string;
  session_id?: string;
  stream: string;
  seq?: number;
  ts?: number;
  phase?: string;
  status?: string;
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ResumeFrame {
  type: "resume";
  last_event_seq: number;
}

export interface SessionUpdateFrame {
  type: "session_update";
  provider_session_key?: string;
  provider_session_id?: string;
  metadata?: Record<string, unknown>;
  acp_capability?: AcpCapabilityEnvelope;
}

// ---- Streaming reply frames (client → server) ----

/** One token / chunk of a streaming bot reply. The server appends `delta`
 *  to the placeholder identified by `msg_id` and broadcasts a
 *  `message_stream` event so the frontend can render it incrementally. */
export interface DeltaFrame {
  type: "delta";
  msg_id: string;
  /** Monotonic per-stream sequence; out-of-order frames are dropped server-side. */
  seq: number;
  delta: string;
  provider_session_key?: string | null;
  provider_session_id?: string;
  session_id?: string;
  acp_capability?: AcpCapabilityEnvelope;
}

/** End of a streaming reply. Server flushes the buffer to the placeholder
 *  Message and broadcasts `message_done`. Idempotent.
 *
 *  `file_ids` lets the plugin attach binary outputs (uploaded via the
 *  /agent-bridge/files/upload-binary HTTP route while the stream was in
 *  flight) to the same finalized message — so a typing-to-file-reveal UX
 *  shows up as a single bot reply, not text + a separate media message.
 *
 *  `content` is a durable final snapshot. It lets the server complete the
 *  placeholder even if a backend restart lost the in-memory delta buffer. */
export interface DoneFrame {
  type: "done";
  client_msg_id?: string;
  msg_id: string;
  file_ids?: string[];
  content?: string;
  provider_session_key?: string | null;
  provider_session_id?: string;
  session_id?: string;
  acp_capability?: AcpCapabilityEnvelope;
}

/** Plugin reports a mid-stream error. Server finalizes the placeholder with
 *  `is_partial=true` and includes `message` in the message_done event. */
export interface ErrorFrame {
  type: "error";
  client_msg_id?: string;
  msg_id: string;
  message: string;
  provider_session_key?: string | null;
  provider_session_id?: string;
  session_id?: string;
  acp_capability?: AcpCapabilityEnvelope;
}

/** In-band binary upload over the data WS (avoids the HTTP
 *  /files/upload-binary route). Server creates a FileRecord under
 *  channel_id/uploader=bot and acks with a real file_id that can be
 *  attached to subsequent reply / done / send frames. */
export interface FileUploadFrame {
  type: "file_upload";
  client_file_id: string;
  channel_id: string;
  filename: string;
  content_type?: string;
  /** Base64 of raw bytes. Capped server-side by file_upload_max_bytes. */
  data_b64: string;
}
