export type SearchContext =
  | "global_nav"
  | "add_friend"
  | "dm_start"
  | "workspace_create"
  | "workspace_invite"
  | "channel_create"
  | "channel_invite"
  | "channel_invite_user"
  | "channel_invite_bot"
  | "file_lookup"
  | "todo_lookup"
  | "task_monitor";

export type SearchResultType =
  | "workspaces"
  | "channels"
  | "users"
  | "bots"
  | "files"
  | "todos"
  | "tasks"
  | "messages";

export type SearchWorkspaceHit = {
  workspace_id: string;
  name: string;
  kind?: "team" | "personal" | string;
};

export type SearchChannelHit = {
  channel_id: string;
  name: string;
  workspace_id: string;
  workspace_name?: string | null;
  type: string;
};

export type SearchUserHit = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type SearchBotHit = {
  bot_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  scope?: "private" | "friend" | "everyone";
  owner?: {
    user_id: string;
    username: string;
    display_name?: string | null;
  } | null;
};

export type SearchFileHit = {
  file_id: string;
  channel_id: string;
  channel_name: string;
  original_filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  status: string;
  snippet: string;
  created_at: string | null;
};

export type SearchTodoHit = {
  todo_id: string;
  channel_id: string;
  channel_name: string;
  content: string;
  status: string;
  assignee_id: string | null;
  assignee_type: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SearchTaskHit = {
  task_id: string;
  channel_id: string;
  channel_name: string;
  bot_id: string;
  bot_name: string | null;
  trigger_msg_id: string;
  response_msg_id: string | null;
  latency_ms: number | null;
  feedback: string | null;
  snippet: string;
  created_at: string | null;
};

export type SearchMessageHit = {
  msg_id: string;
  channel_id: string;
  channel_name: string;
  sender_label: string;
  snippet: string;
  created_at: string | null;
};

export type SearchResultsPayload = {
  q: string;
  context: SearchContext | string;
  workspaces: SearchWorkspaceHit[];
  channels: SearchChannelHit[];
  users: SearchUserHit[];
  bots: SearchBotHit[];
  files: SearchFileHit[];
  todos: SearchTodoHit[];
  tasks: SearchTaskHit[];
  messages: SearchMessageHit[];
};

export type SearchSelection =
  | { type: "workspace"; item: SearchWorkspaceHit }
  | { type: "channel"; item: SearchChannelHit }
  | { type: "user"; item: SearchUserHit }
  | { type: "bot"; item: SearchBotHit }
  | { type: "file"; item: SearchFileHit }
  | { type: "todo"; item: SearchTodoHit }
  | { type: "task"; item: SearchTaskHit }
  | { type: "message"; item: SearchMessageHit };
