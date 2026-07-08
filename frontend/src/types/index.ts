export interface User {
  user_id: string;
  username?: string;
  display_name: string | null;
  email?: string | null;
  role?: string;
  avatar_url?: string | null;
  /** Longer self-description ("information"). */
  bio?: string | null;
  /** Short presence line (Slack-style custom status). */
  status_text?: string | null;
  status_emoji?: string | null;
  status_updated_at?: string | null;
}

export interface Workspace {
  workspace_id: string;
  name: string;
  kind?: "team" | "personal";
  avatar_url?: string | null;
  default_bot_id?: string | null;
}

export interface Channel {
  channel_id: string;
  name: string;
  type: string;
  workspace_id?: string;
  purpose?: string | null;
  auto_assist?: boolean;
  unread_count?: number;
  /** Of the unread messages, how many @mention me — drives the distinct
   * "mentioned here" sidebar badge (from GET /channels). */
  mention_count?: number;
  /** For type='dm': the other participant's name (from GET /channels/dm). */
  peer_name?: string;
  my_role?: string | null;
  can_manage?: boolean;
}

export interface DM {
  channel_id: string;
  workspace_id: string;
  counterparty: {
    member_id: string;
    member_type: "user" | "bot" | "system";
    username?: string | null;
    display_name?: string | null;
    avatar_url?: string | null;
  };
  title?: string | null;
  unread_count?: number | null;
}

export interface FileInfo {
  file_id: string;
  original_filename?: string;
  content_type?: string;
  size_bytes?: number;
  preview_url?: string | null;
  download_url?: string | null;
  /** "staged" = lazy (remote, not yet on S3); "uploaded" = available; "expired" = gone. */
  status?: string;
  /** Short derived text when a server pipeline produced one — today the audio
   *  transcript snippet; shown under the inline audio player. */
  summary?: string | null;
  /** Audio transcription state: "done" | "pending" | "failed" | null (never requested).
   *  Kept live by the `file_transcribed` realtime frame. */
  transcript_status?: string | null;
}

export interface MessageMention {
  member_id: string;
  member_type: string;
  username?: string | null;
  display_name?: string | null;
}

/** One ACP permission option, as forwarded by the connector (kind passthrough). */
export interface PermissionOption {
  option_id?: string;
  optionId?: string;
  kind?: string; // allow_once | allow_always | reject_once | reject_always
  name?: string;
  description?: string;
}

/** content_data payload of a `msg_type: "permission"` message. */
export interface PermissionContentData {
  kind?: "agent_bridge_permission_request";
  request_id?: string;
  title?: string;
  body?: string;
  tool?: {
    title?: string | null;
    name?: string;
    kind?: string | null;
    raw_input?: unknown;
    locations?: unknown;
    // Normalized by the connector from the agent's _meta (e.g. codex's
    // `_meta.codex.params.command`/`cwd`) — cleaner than raw_input.command.
    command?: string | null;
    cwd?: string | null;
    status?: string | null;
    tool_call_id?: string | null;
  } | null;
  options?: PermissionOption[];
  bot_owner_id?: string;
  resolved?: boolean;
  resolved_by?: string;
  resolved_at?: string;
  resolved_kind?: string; // "expired" when finalized by timeout/cancel
  resolved_reason?: string;
  chosen_option_id?: string;
  chosen_kind?: string;
}

export interface Message {
  msg_id: string;
  channel_seq?: number;
  sender_id: string;
  sender_type: string;
  sender_name?: string;
  content: string;
  created_at?: string;
  msg_type?:
    | "normal"
    | "reply"
    | "announcement"
    | "routing"
    | "permission"
    | "notification";
  /** The message this one replies to. Wire name is `reply_to_msg_id` on every
   *  server path (REST DTO + WS frames) — the DB column `in_reply_to_msg_id`
   *  never crosses the API boundary. */
  reply_to_msg_id?: string | null;
  files?: FileInfo[];
  file_ids?: string[];
  mentions?: MessageMention[];
  is_deleted?: boolean;
  is_partial?: boolean;
  error?: string | null;
  /** Structured payload for system messages (ACP approval cards, etc.). */
  content_data?: PermissionContentData | Record<string, unknown> | null;
  _streaming?: boolean;
  /** Latest agent progress (trace) title shown while streaming. */
  _trace?: string | null;
  /** Client-only: lifecycle of an outgoing message the server hasn't confirmed.
   *  "sending" = a retry is in flight; "failed" = the send failed and is retryable.
   *  Absent on normal (server-confirmed) messages. Never sent to the server. */
  _status?: "sending" | "failed";
  /** Client-only: the original send arguments, kept on a failed message so it can
   *  be re-sent verbatim (mentions, attachments, reply target, session route). */
  _sendParams?: {
    content: string;
    mention_ids?: string[];
    mention_names?: string[];
    file_ids?: string[];
    reply_to_msg_id?: string;
    session_id?: string;
  };
}

export interface MemberItem {
  member_id: string;
  member_type: string;
  role?: string;
  username?: string;
  display_name?: string;
  avatar_url?: string | null;
  /** Longer self-description for the profile hovercard (users: bio; bots: description). */
  bio?: string | null;
  /** Short presence line (Slack-style custom status). */
  status_text?: string | null;
  status_emoji?: string | null;
  /** When the status was last written (RFC 3339). Powers "updated 3m ago"; carried
   *  in channel.members and the member_updated frame. */
  status_updated_at?: string | null;
  /** Users: live browser connection subscribed to this channel; bots: connector liveness. */
  is_online?: boolean | null;
  /** Bots only: connector-reported "agent accepts audio prompts" (policy AND
   *  promptCapabilities.audio). null = unknown (never connected) — treat as false. */
  can_receive_audio?: boolean | null;
}

export interface BotItem {
  bot_id: string;
  username: string;
  display_name?: string;
  intro?: string;
  avatar_url?: string;
  scope?: "private" | "friend" | "everyone";
  binding_type?: string;
  /** Live: a connector bridge is bound right now (from the registry). */
  is_online?: boolean;
  /** Admin kill-switch: the bot is disabled and cannot connect. */
  is_disabled?: boolean;
  /** Whether the caller (admin or owner) may manage this bot. */
  can_manage?: boolean;
  /** Longer self-description ("information"). */
  description?: string | null;
  /** Short presence line, set by a manager or the bot itself. */
  status_text?: string | null;
  status_emoji?: string | null;
  status_updated_at?: string | null;
  /** Scheduled self-refresh config (manager-only; prompt redacted for others). */
  status_auto_update?: boolean;
  status_update_prompt?: string | null;
  status_update_interval_minutes?: number | null;
}

export interface WsEvent {
  type: string;
  data: Record<string, unknown>;
}
