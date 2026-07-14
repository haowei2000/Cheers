import { apiJson } from "./client";
import type { PermissionContentData } from "@/types";

// Fleet view: workspace-level approvals inbox + bot roster
// (docs/design/FLEET_VIEW.md).

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
  channel_id: string;
  channel_name: string;
  online: boolean;
  busy_sessions: number;
  idle_sessions: number;
  status_text: string | null;
  status_emoji: string | null;
  cost_today_usd: number;
  pending_count: number;
}

export interface FleetResponse {
  approvals: FleetApproval[];
  bots: FleetBot[];
}

export async function getFleet(workspaceId: string): Promise<FleetResponse> {
  return apiJson(`/workspaces/${workspaceId}/fleet`);
}

/** Workspace-agnostic count of pending approvals the caller may answer. */
export async function getFleetBadge(): Promise<{ count: number }> {
  return apiJson(`/fleet/badge`);
}
