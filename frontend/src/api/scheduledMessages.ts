import { apiJson } from "./client";

export interface ScheduledMessageSchedule {
  kind: "once" | "interval" | "daily";
  runAt?: string;
  everyMinutes?: number;
  startAt?: string;
  localTime?: string;
  timezone?: string;
}

export interface ScheduledMessageInput {
  title: string;
  channelId: string;
  content: string;
  mentionIds: string[];
  schedule: ScheduledMessageSchedule;
  enabled: boolean;
  sourceExtensionId?: string;
  sourceAutomationId?: string;
}

export interface ScheduledMessage extends Omit<ScheduledMessageInput, "schedule"> {
  id: string;
  channelName: string;
  schedule: Omit<ScheduledMessageSchedule, "startAt">;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastError?: string | null;
  consecutiveFailures: number;
  retryAttempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledMessageRun {
  id: string;
  scheduledFor: string;
  trigger: "schedule" | "manual";
  status: "running" | "succeeded" | "failed";
  attempt: number;
  messageId?: string | null;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export async function listScheduledMessages(): Promise<ScheduledMessage[]> {
  return (await apiJson<{ tasks: ScheduledMessage[] }>("/scheduled-messages")).tasks;
}

export function createScheduledMessage(input: ScheduledMessageInput): Promise<ScheduledMessage> {
  return apiJson("/scheduled-messages", { method: "POST", body: JSON.stringify(input) });
}

export function updateScheduledMessage(id: string, input: ScheduledMessageInput): Promise<ScheduledMessage> {
  return apiJson(`/scheduled-messages/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function deleteScheduledMessage(id: string): Promise<void> {
  await apiJson(`/scheduled-messages/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function runScheduledMessageNow(id: string): Promise<string> {
  return (await apiJson<{ messageId: string }>(`/scheduled-messages/${encodeURIComponent(id)}/run`, { method: "POST" })).messageId;
}

export async function listScheduledMessageRuns(id: string): Promise<ScheduledMessageRun[]> {
  return (await apiJson<{ runs: ScheduledMessageRun[] }>(`/scheduled-messages/${encodeURIComponent(id)}/runs`)).runs;
}
