export type Workspace = {
  workspace_id: string;
  name: string;
};

export type Channel = {
  channel_id: string;
  name: string;
  type: string;
  workspace_id?: string;
  auto_assist?: boolean;
  /** Count of messages in this channel that the caller has not yet read.
   *  Populated by the channel list endpoints; updated locally on select. */
  unread_count?: number;
};

export type DMCounterparty = {
  member_id: string;
  member_type: "user" | "bot";
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
};

export type Message = {
  msg_id: string;
  sender_id: string;
  sender_type: string;
  sender_name?: string;
  content: string;
  created_at?: string;
  _streaming?: boolean;
  in_reply_to_msg_id?: string | null;
  msg_type?:
    | "normal"
    | "thread"
    | "reply"
    | "announcement"
    | "routing"
    | "permission";
  content_data?: Record<string, unknown> | null;
  file_ids?: string[];
  files?: FileInfo[];
  is_secret?: boolean;
  secret_token?: string;
};

export type QaPair = { question: Message; answer: Message };

export type ContextData = Record<string, string>;
