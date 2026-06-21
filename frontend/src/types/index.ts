export interface User {
  user_id: string;
  username?: string;
  display_name: string | null;
  email?: string | null;
  role?: string;
  avatar_url?: string | null;
  bio?: string | null;
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
}

export interface MessageMention {
  member_id: string;
  member_type: string;
  username?: string | null;
  display_name?: string | null;
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
    | "topic"
    | "reply"
    | "announcement"
    | "routing"
    | "permission"
    | "notification";
  in_reply_to_msg_id?: string | null;
  files?: FileInfo[];
  file_ids?: string[];
  mentions?: MessageMention[];
  is_deleted?: boolean;
  is_partial?: boolean;
  error?: string | null;
  _streaming?: boolean;
}

export interface MemberItem {
  member_id: string;
  member_type: string;
  role?: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  is_online?: boolean;
}

export interface BotItem {
  bot_id: string;
  username: string;
  display_name?: string;
  intro?: string;
  avatar_url?: string;
  status?: string;
  scope?: "private" | "friend" | "everyone";
  binding_type?: string;
  is_online?: boolean;
}

export interface WsEvent {
  type: string;
  data: Record<string, unknown>;
}
