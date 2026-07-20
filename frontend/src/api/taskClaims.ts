import { apiJson } from "./client";

export type MonitoringMode = "off" | "text" | "text_and_transcript" | "all_activity";
export interface BotMonitoring {
  channel_id: string; bot_id: string; mode: MonitoringMode; scope: string;
  debounce_seconds: number; min_interval_seconds: number;
  max_evaluations_per_hour: number; batch_size: number; confidence_threshold: number;
}
export interface TaskClaim {
  claim_id: string; evaluation_id: string; channel_id: string; bot_id: string;
  bot_name: string; summary: string; proposed_action: string; confidence: number;
  impact: "low" | "medium" | "high"; status: string; created_at: string;
  resolved_at?: string | null; execution_msg_id?: string | null;
}
export const getBotMonitoring = (channelId: string, botId: string) =>
  apiJson<BotMonitoring>(`/channels/${channelId}/bots/${botId}/monitoring`);
export const updateBotMonitoring = (channelId: string, botId: string, policy: Omit<BotMonitoring,"channel_id"|"bot_id">) =>
  apiJson<BotMonitoring>(`/channels/${channelId}/bots/${botId}/monitoring`, { method:"PUT", body:JSON.stringify(policy) });
export async function listTaskClaims(channelId: string, status?: string) {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return (await apiJson<{claims:TaskClaim[]}>(`/channels/${channelId}/task-claims${q}`)).claims;
}
export const resolveTaskClaim = (channelId:string, claimId:string, decision:"accept"|"reject") =>
  apiJson(`/channels/${channelId}/task-claims/${claimId}/resolve`, { method:"POST", body:JSON.stringify({decision}) });
