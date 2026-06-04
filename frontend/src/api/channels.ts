import { apiJson } from "./client";
import type { Channel, MemberItem } from "@/types";

export async function listChannels(workspaceId?: string): Promise<Channel[]> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  return apiJson<Channel[]>(`/channels${qs}`);
}

export async function getChannel(channelId: string): Promise<Channel> {
  return apiJson<Channel>(`/channels/${channelId}`);
}

export async function listChannelMembers(
  channelId: string
): Promise<MemberItem[]> {
  return apiJson<MemberItem[]>(`/channels/${channelId}/members`);
}

export async function createChannel(data: {
  workspace_id: string;
  name: string;
  type?: string;
  purpose?: string;
}): Promise<Channel> {
  return apiJson<Channel>("/channels", {
    method: "POST",
    body: JSON.stringify(data),
  });
}
