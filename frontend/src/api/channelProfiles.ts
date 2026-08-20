import { apiJson } from "./client";

export interface ChannelProfile {
  profile: "code" | string;
  config: Record<string, unknown> & {
    integration_id?: string;
    installation_id?: string;
    repository?: string;
    branch?: string;
    bot_id?: string;
  };
  status: Record<string, unknown> & {
    state?: "pending" | "importing" | "ready" | "syncing" | "error";
    workspace_path?: string;
    head_commit?: string;
    last_error?: string;
  };
}

export interface CodeProfileConfig {
  installation_id: string;
  repository: string;
  branch: string;
  bot_id?: string;
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
