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
  msg_type?: "normal" | "thread" | "reply" | "announcement";
  content_data?: Record<string, unknown> | null;
  file_ids?: string[];
  files?: FileInfo[];
  is_secret?: boolean;
  secret_token?: string;
};

export type QaPair = { question: Message; answer: Message };

export type ContextData = Record<string, string>;
