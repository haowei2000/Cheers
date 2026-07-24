import { apiJson } from "./client";
import type { BotItem } from "@/types";

export async function listBots(): Promise<BotItem[]> {
  return apiJson<BotItem[]>("/bots");
}

/** ACP agent id for enrollment presets: legacy short names (`claude`/`codex`/
 *  `opencode`/`generic`) or an ACP registry id (`gemini`, `cline`, …). */
export type AgentType = string;

export interface AcpAgentInfo {
  id: string;
  name: string;
  version?: string;
  package?: string;
  args?: string[];
  source: string;
  installable: boolean;
}

/** Catalog of agents Cheers can quick-configure (builtins + registry npx). */
export async function listAcpAgents(): Promise<AcpAgentInfo[]> {
  const res = await apiJson<{ agents: AcpAgentInfo[] }>("/acp/agents");
  return res.agents ?? [];
}

export interface CreateBotInput {
  username: string;
  display_name?: string;
  intro?: string;
  /** Remembers which external agent this bot fronts (drives config presets). */
  bridge_provider?: string;
  /** When set, the Agent Bridge requires a signed ACP capability delegation. */
  acp_security?: { enabled: boolean; require_capability?: boolean };
  external_processor?: boolean;
  processor_name?: string;
  processor_privacy_url?: string;
  processor_data_use?: string;
  processor_policy_version?: string;
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

/** Admin/owner: permanently delete a bot (kicks its connector, cascades its data). */
export async function deleteBot(botId: string): Promise<void> {
  await apiJson(`/bots/${botId}`, { method: "DELETE" });
}

/** Manager-editable bot identity + status + scheduled-self-update config. Omit a key
 *  to leave it unchanged; send "" to clear a text field. */
export interface UpdateBotProfileInput {
  display_name?: string | null;
  description?: string | null;
  intro?: string | null;
  status_text?: string | null;
  status_emoji?: string | null;
  status_auto_update?: boolean;
  status_update_prompt?: string | null;
  status_update_interval_minutes?: number | null;
  external_processor?: boolean;
  processor_name?: string | null;
  processor_privacy_url?: string | null;
  processor_data_use?: string | null;
  processor_policy_version?: string | null;
}

/** PATCH /bots/:id/profile — owner/admin edits identity, status, and the schedule. */
export async function updateBotProfile(
  botId: string,
  input: UpdateBotProfileInput
): Promise<void> {
  await apiJson(`/bots/${botId}/profile`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function issueBotToken(botId: string): Promise<IssuedToken> {
  return apiJson<IssuedToken>(`/bots/${botId}/token`, { method: "POST" });
}

/** POST /bots/:id/status/refresh — owner/admin triggers the agent to update its own
 *  status now (runs the bot's status_update_prompt via the normal prompt path). */
export async function refreshBotStatus(
  botId: string
): Promise<{ ok: boolean; channel_id: string; msg_id: string }> {
  return apiJson(`/bots/${botId}/status/refresh`, { method: "POST" });
}

export interface BotStatus {
  bot_id: string;
  /** Admin kill-switch flag (distinct from live connectivity). */
  is_disabled: boolean;
  is_online: boolean;
  connection_status?: string;
  /** Live truth from the connection registry: a connector is bound right now. */
  bridge_connected?: boolean;
  /** Control bridge timeline anchors from bot_connection_events (RFC 3339). */
  last_connected_at?: string | null;
  last_disconnected_at?: string | null;
  /** Owner/admin-only count of un-redeemed enrollment codes; null otherwise. */
  live_enrollment_codes?: number | null;
  /** Current status line (mirrors the profile) — lets a poller detect a fresh write. */
  status_text?: string | null;
  status_emoji?: string | null;
  /** When the status was last written (RFC 3339); newer than a captured "before"
   *  value means the agent has responded to a manual refresh. */
  status_updated_at?: string | null;
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

/** Result of redeeming an enrollment code: a ready-to-run config plus the
 * rotated token (once) and the relative token_file the config references. */
export interface RedeemedEnrollment {
  bot_id: string;
  account_id: string;
  agent_type: string;
  token: string;
  token_prefix: string;
  token_file: string;
  control_url: string;
  data_url: string;
  config_toml: string;
  reachability: Reachability;
  note?: string;
}

/** Redeem an enrollment code (single-use; authenticated by the code itself, so
 * no bearer needed). Returns the generated config + token to write to disk. */
export async function redeemEnrollmentCode(
  code: string
): Promise<RedeemedEnrollment> {
  return apiJson<RedeemedEnrollment>("/enrollment/redeem", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
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
  /** RFC3339 expiry; null/absent = permanent. */
  expires_at?: string | null;
  /** True when past expires_at: no longer enforced, listed until deleted/renewed. */
  expired?: boolean;
}

/** Effective decision for one (event × role) cell of the baseline matrix. */
export interface EffectiveDecision {
  allow: boolean;
  /** "rule" = a stored bot-wide grant decided it; "default" = membership default;
   *  "owner" = the bot owner's built-in privilege (not revocable by rules). */
  source: "default" | "rule" | "owner";
}

/** One row of the read-only effective-defaults matrix: an event with its per-role
 *  decision at bot-wide scope (before any channel / user / group override). */
export interface EffectiveCell {
  capability: Capability;
  event_class: string;
  roles: Record<string, EffectiveDecision>;
  /** The bot OWNER's own effective decision — Do/Answer are always allowed
   *  (owner privilege); View follows the same rules as everyone else. */
  bot_owner?: EffectiveDecision;
}

export interface EventAccess {
  rules: EventRule[];
  /** Read-only baseline: effective decision per (capability × event × role), bot-wide. */
  effective: EffectiveCell[];
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
    /** RFC3339 expiry in the future; omit for a permanent rule. */
    expires_at?: string;
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

// ── Bot-to-bot grants (dispatch / workspace_read; bot-subject rules) ───────────
// The dedicated management path for grants keyed on ANOTHER bot as subject, which the
// human role/user/group event-access matrix intentionally excludes. Each grant kind
// maps server-side to a distinct (event_class, capability); the client speaks the
// stable kind. Both default member-allow with deny-override.

/** An owner-manageable bot-subject grant kind. */
export type BotGrantKind = "dispatch" | "workspace_read";

/** One bot-to-bot grant rule (a bot-subject row of bot_event_access, tagged with the
 *  owner-facing grant kind). `subject_id` is the granted bot's id, or "*" (any bot). */
export interface BotGrant {
  channel_id: string; // "" = bot-wide
  subject_id: string; // bot_id | "*"
  grant: BotGrantKind;
  decision: "allow" | "deny";
  updated_by?: string | null;
  updated_at?: string;
  expires_at?: string | null;
  expired?: boolean;
}

/** A grant kind with its human label and member-allow default (for the UI). */
export interface BotGrantKindInfo {
  kind: BotGrantKind;
  /** User-friendly name shown by default. */
  label: string;
  /** Raw (event_class · capability) key — shown only in hover tooltips. */
  tech: string;
  default: "allow" | "deny";
}

/** A bot that may be named as a grant subject (a co-member of some shared channel). */
export interface BotGrantSubject {
  bot_id: string;
  label: string;
}

export interface BotGrants {
  grants: BotGrant[];
  grant_kinds: BotGrantKindInfo[];
  subjects: BotGrantSubject[];
}

/** Owner/admin: read this bot's bot-to-bot grants + the manageable kinds + candidate
 *  subject bots. */
export async function getBotGrants(botId: string): Promise<BotGrants> {
  return apiJson<BotGrants>(`/bots/${botId}/bot-grants`);
}

/** Owner/admin: upsert one bot-to-bot grant (allow / deny a subject bot for a kind). */
export async function upsertBotGrant(
  botId: string,
  grant: {
    channel_id?: string;
    subject_id: string; // bot_id | "*"
    grant: BotGrantKind;
    decision: "allow" | "deny";
    expires_at?: string;
  }
): Promise<void> {
  await apiJson(`/bots/${botId}/bot-grants`, {
    method: "PUT",
    body: JSON.stringify(grant),
  });
}

/** Owner/admin: remove one bot-to-bot grant (back to the member-allow default). */
export async function deleteBotGrant(
  botId: string,
  q: { channel_id?: string; subject_id: string; grant: BotGrantKind }
): Promise<void> {
  const params = new URLSearchParams({ subject_id: q.subject_id, grant: q.grant });
  if (q.channel_id) params.set("channel_id", q.channel_id);
  await apiJson(`/bots/${botId}/bot-grants?${params.toString()}`, {
    method: "DELETE",
  });
}

// ── Bridge connection history ─────────────────────────────────────────────────

export interface BotConnectionEvent {
  stream: "control" | "data";
  event: "connected" | "disconnected";
  /** Disconnects only: closed | superseded | idle_timeout | protocol_error | write_failed | unbound. */
  reason?: string | null;
  connection_id?: string | null;
  created_at: string;
}

/** Recent bridge connect/disconnect history, newest first (persisted timeline
 * behind the live presence dot — includes WHY a connector went away). */
export async function listBotConnectionEvents(
  botId: string,
  limit = 50
): Promise<BotConnectionEvent[]> {
  const res = await apiJson<{ events: BotConnectionEvent[] }>(
    `/bots/${botId}/connection-events?limit=${limit}`
  );
  return res.events;
}
