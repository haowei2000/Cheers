import { apiJson } from "./client";
import type { Message } from "@/types";

export interface TaskClaimUpdate {
  claim_id: string;
  channel_id: string;
  status: string;
  execution_msg_id: string | null;
  confirmation_message: { msg_id: string; content_data: Message["content_data"] } | null;
}

export type MonitoringMode = "off" | "text" | "text_and_transcript" | "all_activity";
export interface BotMonitoring {
  channel_id: string; bot_id: string; mode: MonitoringMode; scope: string;
  debounce_seconds: number; min_interval_seconds: number;
  max_evaluations_per_hour: number; batch_size: number; confidence_threshold: number;
  /** Runtime policy: `immediate_triggers` (keywords bypass debounce) and
   *  `quiet_hours` (`{"start":"22:00","end":"07:00"}` pauses evaluation). */
  policy?: Record<string, unknown>;
}
export interface TaskClaim {
  claim_id: string; evaluation_id: string; channel_id: string; bot_id: string;
  bot_name: string; summary: string; proposed_action: string; confidence: number;
  impact: "low" | "medium" | "high"; status: string; created_at: string;
  resolved_at?: string | null; execution_msg_id?: string | null;
  requester_id?: string | null; source_message_id?: string | null;
  confirmation_message_id?: string | null;
}
export const getBotMonitoring = (channelId: string, botId: string) =>
  apiJson<BotMonitoring>(`/channels/${channelId}/bots/${botId}/monitoring`);
export const updateBotMonitoring = (
  channelId: string,
  botId: string,
  policy: Omit<BotMonitoring, "channel_id" | "bot_id">,
) =>
  apiJson<BotMonitoring>(`/channels/${channelId}/bots/${botId}/monitoring`, {
    method: "PUT",
    body: JSON.stringify(policy),
  });
export async function listTaskClaims(channelId: string, status?: string) {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return (await apiJson<{claims:TaskClaim[]}>(`/channels/${channelId}/task-claims${q}`)).claims;
}
export const resolveTaskClaim = (channelId:string, claimId:string, decision:"accept"|"reject") =>
  apiJson<TaskClaimUpdate>(`/channels/${channelId}/task-claims/${claimId}/resolve`, { method:"POST", body:JSON.stringify({decision}) });
export const cancelTaskClaim = (channelId: string, claimId: string) =>
  apiJson<TaskClaimUpdate>(`/channels/${channelId}/task-claims/${claimId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
