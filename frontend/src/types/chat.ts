export type Workspace = {
  workspace_id: string;
  name: string;
  /** "team" (shared workspace with channels) or "personal" (per-user,
   *  auto-provisioned, hosts DMs only). Defaults to "team" server-side. */
  kind?: "team" | "personal";
  avatar_url?: string | null;
};

export type Channel = {
  channel_id: string;
  name: string;
  type: string;
  workspace_id?: string;
  purpose?: string | null;
  auto_assist?: boolean;
  allow_member_invites?: boolean;
  allow_bot_adds?: boolean;
  my_role?: string | null;
  can_manage?: boolean;
  can_invite_members?: boolean;
  can_add_bots?: boolean;
  /** Count of messages in this channel that the caller has not yet read.
   *  Populated by the channel list endpoints; updated locally on select. */
  unread_count?: number;
};

export type DMCounterparty = {
  member_id: string;
  member_type: "user" | "bot" | "system";
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
};

export type DM = {
  channel_id: string;
  workspace_id: string;
  counterparty: DMCounterparty;
  unread_count?: number | null;
};

export type FileInfo = {
  file_id: string;
  original_filename?: string;
  content_type?: string;
  size_bytes?: number;
  status?: string;
  expires_at?: string | null;
};

export type BotTraceEvent = {
  msg_id: string;
  task_id?: string | null;
  channel_id?: string;
  bot_id?: string;
  run_id?: string;
  session_key?: string;
  stream?: string;
  seq?: number;
  ts?: number;
  phase?: string;
  status?: string;
  title?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type AgentBridgeTaskContentData = {
  kind: "agent_bridge_background_task";
  status?: string;
  title?: string;
  message?: string;
  task_id?: string | null;
  bot_id?: string | null;
  timeout_seconds?: number;
};

export type MemoryLoadLayerDetail = {
  source: string;
  label?: string;
  loader?: string;
  requested?: boolean;
  present?: boolean;
  chars?: number;
  preview?: string;
};

export type MemoryLoadDetail = {
  kind: "bot_memory_load";
  strategy?: string;
  trigger_msg_id?: string;
  trigger_msg_type?: string;
  requested_layers?: string[];
  total_chars?: number;
  layers?: MemoryLoadLayerDetail[];
};

export type Message = {
  msg_id: string;
  task_id?: string | null;
  sender_id: string;
  sender_type: string;
  sender_name?: string;
  content: string;
  created_at?: string;
  _streaming?: boolean;
  in_reply_to_msg_id?: string | null;
  msg_type?:
    | "normal"
    | "topic"
    | "reply"
    | "announcement"
    | "routing"
    | "permission"
    | "friend_request";
  content_data?: Record<string, unknown> | null;
  file_ids?: string[];
  files?: FileInfo[];
  is_secret?: boolean;
  secret_token?: string;
  /** True when the bot reply was finalized mid-stream (cancel/error).
   *  Renders a "已取消" / "已中断" badge. */
  is_partial?: boolean;
  _bot_status?: string;
  _bot_trace?: BotTraceEvent[];
  _agent_bridge_task?: AgentBridgeTaskContentData;
};

export type ContextData = Record<string, string>;
