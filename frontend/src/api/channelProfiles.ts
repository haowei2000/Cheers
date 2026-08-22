import { apiJson } from "./client";

export interface ChannelProfile {
  profile: "code" | string;
  config: Record<string, unknown> & {
    remote_source?: CodeRemoteSource;
    execution_target?: CodeExecutionTarget;
  };
  status: Record<string, unknown> & {
    state?: "unconfigured" | "pending" | "importing" | "ready" | "syncing" | "error";
    head_commit?: string;
    last_error?: string;
    target_online?: boolean;
    target_device?: string;
    target_bot_name?: string;
  };
}

export interface CodeRemoteSource {
  kind: "github";
  installation_id: string;
  repository: string;
  branch: string;
}

export interface CodeExecutionTarget {
  bot_id: string;
  host_id: string;
  checkout_id?: string;
}

export interface CodeProfileConfig {
  remote_source?: CodeRemoteSource;
  execution_target?: Omit<CodeExecutionTarget, "checkout_id">;
}

export function getChannelProfile(channelId: string): Promise<ChannelProfile | null> {
  return apiJson(`/channels/${channelId}/profile`);
}

export function putCodeProfile(channelId: string, config: CodeProfileConfig): Promise<ChannelProfile> {
  return apiJson(`/channels/${channelId}/profile/code`, {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export function putCodeStatus(
  channelId: string,
  status: ChannelProfile["status"],
): Promise<ChannelProfile> {
  return apiJson(`/channels/${channelId}/profile/code/status`, {
    method: "PUT",
    body: JSON.stringify(status),
  });
}
