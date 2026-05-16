export type BotScope = "private" | "friend" | "everyone";

export type BotRow = {
  bot_id: string;
  username: string;
  display_name?: string | null;
  description?: string | null;
  avatar_url?: string | null;
  status?: string;
  binding_type?: "http" | "agent_bridge" | string;
  connection_status?: string;
  is_online?: boolean;
  control_connected?: boolean | null;
  data_connected?: boolean | null;
  model_id?: string | null;
  template_id?: string | null;
  model_name?: string | null;
  template_name?: string | null;
  is_builtin?: boolean;
  created_by?: string | null;
  scope?: BotScope;
  owner?: {
    user_id: string;
    username: string;
    display_name?: string | null;
  } | null;
  can_manage?: boolean;
};

export type BotConnectionTestResult = {
  reachable: boolean;
  message?: string;
  checked_at?: string;
  duration_ms?: number;
};

export type BindingType = "http" | "agent_bridge";

export type ModelItem = {
  model_id: string;
  name: string;
  model_name?: string;
  provider?: string;
  is_enabled?: boolean;
};

export type TemplateItem = {
  template_id: string;
  name: string;
};
