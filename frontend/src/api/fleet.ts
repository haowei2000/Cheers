import { apiJson } from "./client";
import type { PermissionContentData } from "@/types";

// Fleet view: global approvals inbox + bot roster, with a retained
// workspace-scoped reader for consumers that intentionally need one slice.

export interface FleetApproval {
  message_id: string;
  channel_id: string;
  channel_name: string;
  bot_id: string;
  created_at: string;
  /** Whether the caller may answer this request (server-authoritative:
   *  owner ∪ per-kind delegate ∪ RESPOND grant). */
  actionable: boolean;
  content_data: PermissionContentData;
}

export interface FleetBot {
  bot_id: string;
  bot_name: string;
  username?: string;
  channel_id?: string;
  channel_name?: string;
  channels?: Array<{ channel_id: string; channel_name: string }>;
  can_manage?: boolean;
  relationship?: "mine" | "shared";
  is_disabled?: boolean;
  host_count?: number;
  online: boolean;
  busy_sessions: number;
  idle_sessions: number;
  status_text: string | null;
  status_emoji: string | null;
  cost_today_usd: number;
  pending_count: number;
}

export interface FleetResponse {
  summary?: {
    online: number;
    working: number;
    offline: number;
    waiting: number;
  };
  approvals: FleetApproval[];
  bots: FleetBot[];
}

export interface FleetHost {
  host_id: string;
  bot_id: string;
  bot_name: string;
  bot_username: string;
  device_name: string;
  agent_type: string;
  credential_prefix: string;
  status: "pending" | "active" | "standby";
  online: boolean;
  connector_version?: string | null;
  last_seen_at?: string | null;
  connected_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  mcp_connection_state: string;
  mcp_state_updated_at?: string | null;
  mcp_connected_at?: string | null;
  mcp_last_seen_at?: string | null;
}

export interface FleetAuditEvent {
  id: string;
  source: "management" | "connection" | "acp" | "approval";
  event_type: string;
  bot_id?: string | null;
  host_id?: string | null;
  actor_id?: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export async function getFleet(workspaceId: string): Promise<FleetResponse> {
  return apiJson(`/workspaces/${workspaceId}/fleet`);
}

/** Complete fleet across every channel visible to the caller. */
export async function getAllFleet(): Promise<FleetResponse> {
  return apiJson(`/fleet`);
}

export async function getFleetHosts(): Promise<FleetHost[]> {
  const result = await apiJson<{ hosts: FleetHost[] }>(`/fleet/hosts`);
  return result.hosts ?? [];
}

export async function getFleetAudit(params: {
  cursor?: string;
  botId?: string;
  hostId?: string;
  eventType?: string;
  limit?: number;
} = {}): Promise<{ events: FleetAuditEvent[]; next_cursor?: string | null }> {
  const query = new URLSearchParams();
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.botId) query.set("bot_id", params.botId);
  if (params.hostId) query.set("host_id", params.hostId);
  if (params.eventType) query.set("event_type", params.eventType);
  if (params.limit) query.set("limit", String(params.limit));
  return apiJson(`/fleet/audit${query.size ? `?${query}` : ""}`);
}

/** Workspace-agnostic count of pending approvals the caller may answer. */
export async function getFleetBadge(): Promise<{ count: number }> {
  return apiJson(`/fleet/badge`);
}
