export type AgentBridgeSessionBinding = {
  binding_id: string;
  scope_type: "channel" | "dm" | "topic" | "task" | string;
  scope_id: string;
  role: "primary" | "alias" | string;
  channel_id?: string | null;
  topic_id?: string | null;
  dm_id?: string | null;
  task_id?: string | null;
  created_at?: string | null;
  detached_at?: string | null;
};

export type AgentBridgeSession = {
  session_id: string;
  bot_id: string;
  bot_username?: string | null;
  bot_display_name?: string | null;
  provider: string;
  provider_account_id: string;
  provider_agent_id: string;
  provider_session_key: string;
  provider_session_id?: string | null;
  current_scope_type: string;
  current_scope_id: string;
  status: string;
  metadata?: Record<string, unknown>;
  last_used_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  bindings: AgentBridgeSessionBinding[];
};
