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

// ── Bot posture (the agent's session mode) ────────────────────────────────────
// docs/arch/ACP_EVENT_TAXONOMY.md.

/** Posture: the agent's session mode + the L0-allowed choices. */
export interface Posture {
  agent_type: string;
  /** Current desired mode (persisted override, else the preset default). */
  permission_mode: string | null;
  /** L0 allowed_modes; empty = the agent advertises its own (no envelope). */
  allowed_modes: string[];
}

/** One selectable value of an ACP session config option. */
export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

/** An ACP session config option the agent advertised (model / reasoning / mode…). */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue: string;
  options: ConfigOptionValue[];
}

export interface BotPermissions {
  posture: Posture;
  /** Session config options: what the agent advertised + the owner's overrides. */
  config_options: {
    advertised: ConfigOption[];
    desired: Record<string, string>;
  };
}

/** Owner/admin: read the bot's posture + config options. */
export async function getBotPermissions(botId: string): Promise<BotPermissions> {
  return apiJson<BotPermissions>(`/bots/${botId}/permissions`);
}

/** Owner/admin: set the agent's posture mode (clamped by L0 allowed_modes). */
export async function setBotPosture(botId: string, permission_mode: string): Promise<void> {
  await apiJson(`/bots/${botId}/permissions/posture`, {
    method: "PUT",
    body: JSON.stringify({ permission_mode }),
  });
}

/** Owner/admin: set an ACP session config option (bot-level desired override,
 * applied per-session by the connector, clamped by L0 allowed_config_options). */
export async function setBotConfigOption(
  botId: string,
  config_id: string,
  value: string
): Promise<void> {
  await apiJson(`/bots/${botId}/permissions/config-option`, {
    method: "PUT",
    body: JSON.stringify({ config_id, value }),
  });
}

// ── Event-access matrix (INITIATE / SEE / RESPOND) ────────────────────────────
// docs/arch/ACP_EVENT_TAXONOMY.md — per (subject × event-class × capability)
// authorization, subject = channel role (with per-user overrides).

export type Capability = "initiate" | "see" | "respond";
export type SubjectKind = "role" | "user" | "group";

/** A selectable dynamic-group subject (friends / channel:<id> / workspace:<id>). */
export interface GroupRef {
  ref: string;
  label: string;
}

export interface EventRule {
  channel_id: string; // "" = bot-wide
  subject_kind: SubjectKind;
  subject_id: string; // role name | user_id | "*"
  event_class: string;
  capability: Capability;
  decision: "allow" | "deny";
  updated_by?: string | null;
  updated_at?: string;
}

export interface EventAccess {
  rules: EventRule[];
  initiate_events: string[];
  see_events: string[];
  respond_events: string[];
  /** Selectable group subjects (friends / channel / workspace) for overrides. */
  groups: GroupRef[];
}

/** Owner/admin: read the event-access rules + the event vocabulary. */
export async function getEventAccess(botId: string): Promise<EventAccess> {
  return apiJson<EventAccess>(`/bots/${botId}/event-access`);
}

/** Owner/admin: upsert one (subject × event-class × capability) rule. */
export async function upsertEventRule(
  botId: string,
  rule: {
    channel_id?: string;
    subject_kind: SubjectKind;
    subject_id: string;
    event_class: string;
    capability: Capability;
    decision: "allow" | "deny";
  }
): Promise<void> {
  await apiJson(`/bots/${botId}/event-access`, {
    method: "PUT",
    body: JSON.stringify(rule),
  });
}

/** One row of the complete ACP event timeline (acp_event_log). */
export interface AcpEventRow {
  name: string;
  home: string;
  channel_id?: string | null;
  session_id?: string | null;
  payload?: unknown;
  created_at: string;
}

/** Owner/admin: read the bot's recent ACP events (everything it emitted). */
export async function getBotAcpEvents(
  botId: string,
  limit = 100
): Promise<{ events: AcpEventRow[] }> {
  return apiJson(`/bots/${botId}/acp-events?limit=${limit}`);
}

/** Owner/admin: delete one event-access rule (back to the membership default). */
export async function deleteEventRule(
  botId: string,
  q: {
    channel_id?: string;
    subject_kind: SubjectKind;
    subject_id: string;
    event_class: string;
    capability: Capability;
  }
): Promise<void> {
  const params = new URLSearchParams({
    subject_kind: q.subject_kind,
    subject_id: q.subject_id,
    event_class: q.event_class,
    capability: q.capability,
  });
  if (q.channel_id) params.set("channel_id", q.channel_id);
  await apiJson(`/bots/${botId}/event-access?${params.toString()}`, {
    method: "DELETE",
  });
}
