import { apiJson } from "./client";
import type { BotItem } from "@/types";

export async function listBots(): Promise<BotItem[]> {
  return apiJson<BotItem[]>("/bots");
}

/** ACP agent kinds the onboarding presets know how to configure. */
export type AgentType = "claude" | "codex" | "opencode" | "generic";

export interface CreateBotInput {
  username: string;
  display_name?: string;
  intro?: string;
  /** Remembers which external agent this bot fronts (drives config presets). */
  bridge_provider?: string;
  /** When set, the Agent Bridge requires a signed ACP capability delegation. */
  acp_security?: { enabled: boolean; require_capability?: boolean };
}

export async function createBot(input: CreateBotInput): Promise<BotItem> {
  return apiJson<BotItem>("/bots", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface IssuedToken {
  bot_id: string;
  token: string;
  token_prefix: string;
  note?: string;
}

/** Issue/rotate the bot's Agent Bridge token. Plaintext is returned once. */
/** Admin/owner kill-switch: disable the bot + kick its live connector. */
export async function disableBot(botId: string): Promise<void> {
  await apiJson(`/bots/${botId}/disable`, { method: "POST" });
}

/** Re-enable a disabled bot (admin/owner). */
export async function enableBot(botId: string): Promise<void> {
  await apiJson(`/bots/${botId}/enable`, { method: "POST" });
}

export async function issueBotToken(botId: string): Promise<IssuedToken> {
  return apiJson<IssuedToken>(`/bots/${botId}/token`, { method: "POST" });
}

export interface BotStatus {
  bot_id: string;
  /** Admin kill-switch flag (distinct from live connectivity). */
  is_disabled: boolean;
  is_online: boolean;
  connection_status?: string;
  /** Live truth from the connection registry: a connector is bound right now. */
  bridge_connected?: boolean;
  /** Owner/admin-only count of un-redeemed enrollment codes; null otherwise. */
  live_enrollment_codes?: number | null;
}

export async function getBotStatus(botId: string): Promise<BotStatus> {
  return apiJson<BotStatus>(`/bots/${botId}/status`);
}

// ── Bot onboarding: enrollment codes + connector config ───────────────────────

export interface Reachability {
  public_base: string;
  configured: boolean;
}

export interface ConnectorConfig {
  bot_id: string;
  account_id: string;
  agent_type: string;
  token_file: string;
  control_url: string;
  data_url: string;
  config_toml: string;
  reachability: Reachability;
  note?: string;
}

/** Manual-mode (mode 3) config: token is read from a sidecar file, never inlined.
 * Issue the token separately via {@link issueBotToken}. */
export async function getConnectorConfig(
  botId: string,
  agentType?: AgentType
): Promise<ConnectorConfig> {
  const q = agentType ? `?agent_type=${encodeURIComponent(agentType)}` : "";
  return apiJson<ConnectorConfig>(`/bots/${botId}/connector-config${q}`);
}

export interface EnrollmentCode {
  code: string;
  code_id: string;
  bot_id: string;
  agent_type: string;
  expires_at: string;
  ttl_secs: number;
  redeem_path: string;
  control_url: string;
  reachability: Reachability;
  live_codes: number;
  note?: string;
}

/** Mint a one-time enrollment code for a bot (owner/admin). Plaintext once. */
export async function mintEnrollmentCode(
  botId: string,
  agentType?: AgentType
): Promise<EnrollmentCode> {
  return apiJson<EnrollmentCode>(`/bots/${botId}/enrollment`, {
    method: "POST",
    body: JSON.stringify(agentType ? { agent_type: agentType } : {}),
  });
}

/** Revoke ALL live enrollment codes for a bot (owner/admin). Idempotent. */
export async function revokeEnrollmentCodes(
  botId: string
): Promise<{ bot_id: string; revoked: number }> {
  return apiJson(`/bots/${botId}/enrollment`, { method: "DELETE" });
}

export interface ConnectorDiscovery {
  public_base: string;
  configured: boolean;
  control_url: string;
  data_url: string;
  hint: string;
}

/** Where should a connector dial, and is an explicit public base configured? */
export async function getConnectorDiscovery(): Promise<ConnectorDiscovery> {
  return apiJson<ConnectorDiscovery>(`/ops/connector-discovery`);
}

export interface EnrollmentGuidance {
  install_url: string;
  prompt_template: string;
  code_placeholder: string;
  note?: string;
}

/** Mode-1 prompt template (install URL baked in); client fills the code. */
export async function getEnrollmentGuidance(): Promise<EnrollmentGuidance> {
  return apiJson<EnrollmentGuidance>(`/enrollment/guidance`);
}
