import type { SessionConfig } from "@haowei0520/bridge-client";

export type PermissionMode = "ask" | "reject" | "allow" | "cancel";

export interface RemoteConnectorSettings {
  agentnexusApprovalMode?: PermissionMode;
  agentNativePermissionMode?: string;
  /** @deprecated Use agentnexusApprovalMode. */
  permissionMode?: PermissionMode;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  cwd?: string;
  model?: string;
  configOptions?: Record<string, string>;
}

export interface StdioAgentConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  agentnexusApprovalMode?: PermissionMode;
  agentNativePermissionMode?: string;
  /** @deprecated Use agentnexusApprovalMode. */
  permissionMode?: PermissionMode;
  mcpServers?: unknown[];
  clientCapabilities?: Record<string, unknown>;
}

export interface AccountConfig {
  botToken: string;
  controlUrl: string;
  dataUrl: string;
  advanced?: SessionConfig["advanced"];
  agent: StdioAgentConfig;
}

export interface ConnectorConfig {
  accounts: Record<string, AccountConfig>;
  statePath?: string;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

export interface ContentBlock {
  type: string;
  text?: string;
  resource?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    [key: string]: unknown;
  };
  content?: ContentBlock;
  [key: string]: unknown;
}

export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: AcpConfigOptionValue[];
  [key: string]: unknown;
}

export interface AcpSessionUpdate {
  sessionId: string;
  update: Record<string, unknown>;
}

export interface AcpSessionStartResult {
  sessionId: string;
  modes?: unknown;
  configOptions?: unknown;
  availableCommands?: unknown;
  [key: string]: unknown;
}

export interface AcpSessionLoadResult {
  modes?: unknown;
  configOptions?: unknown;
  availableCommands?: unknown;
  [key: string]: unknown;
}

export interface AcpInitializeResponse {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: Record<string, unknown>;
    sessionCapabilities?: Record<string, unknown>;
    [key: string]: unknown;
  };
  agentInfo?: Record<string, unknown>;
  authMethods?: unknown[];
  [key: string]: unknown;
}
