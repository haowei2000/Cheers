export type BotScope = "private" | "friend" | "everyone";
export type ConnectorPermissionMode = "ask" | "reject" | "allow" | "cancel";
export type AgentNativePermissionMode = "ask" | "allow" | "deny";

export type ConnectorControlSettings = {
  agentnexusApprovalMode?: ConnectorPermissionMode;
  agentNativePermissionMode?: AgentNativePermissionMode | string;
  /** @deprecated Use agentnexusApprovalMode. */
  permissionMode?: ConnectorPermissionMode;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  cwd?: string;
  model?: string;
  configOptions?: Record<string, string>;
};

export type ConnectorControlConfig = {
  revision?: number | string | null;
  settings?: ConnectorControlSettings | null;
  options?: {
    source?: string;
    agentInfo?: Record<string, unknown> | null;
    agentCapabilities?: Record<string, unknown> | null;
    sessionId?: string | null;
    providerSessionKey?: string | null;
    modes?: {
      currentModeId?: string | null;
      availableModes?: Array<{ id?: string; name?: string; description?: string | null }>;
      [key: string]: unknown;
    } | null;
    configOptions?: Array<{
      id?: string;
      name?: string;
      description?: string | null;
      currentValue?: string | null;
      currentValueId?: string | null;
      options?: Array<{ value?: string; id?: string; name?: string; description?: string | null }>;
      values?: Array<{ id?: string; name?: string; description?: string | null }>;
      [key: string]: unknown;
    }>;
    availableCommands?: Array<{
      name?: string;
      description?: string;
      [key: string]: unknown;
    }>;
    reported_at?: string | null;
    updatedAt?: string | null;
    truncated?: boolean;
    [key: string]: unknown;
  } | null;
  updated_at?: string | null;
  last_status?: {
    revision?: number | string | null;
    ok?: boolean;
    applied?: string[];
    rejected?: Array<{ field?: string; reason?: string }>;
    error?: string | null;
    reported_at?: string | null;
  } | null;
  last_option_status?: {
    request_id?: string | null;
    ok?: boolean | null;
    status?: string | null;
    session_id?: string | null;
    provider_session_key?: string | null;
    config_id?: string | null;
    value?: string | null;
    error?: string | null;
    requested_at?: string | null;
    reported_at?: string | null;
  } | null;
};

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
  binding_config?: {
    connector_control?: ConnectorControlConfig | null;
    [key: string]: unknown;
  } | null;
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
  description?: string | null;
  tags?: string[];
  default_bot_id?: string | null;
  default_bot?: {
    bot_id: string;
    username: string;
    display_name?: string | null;
    avatar_url?: string | null;
  } | null;
};
