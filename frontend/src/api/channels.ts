import { apiJson } from "./client";
import type { Channel, MemberItem } from "@/types";

export async function listChannels(workspaceId?: string): Promise<Channel[]> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  return apiJson<Channel[]>(`/channels${qs}`);
}

export async function getChannel(channelId: string): Promise<Channel> {
  return apiJson<Channel>(`/channels/${channelId}`);
}

/** The caller's DMs (type='dm' channels). Each carries `peer_name` (the other party). */
export async function listDms(): Promise<Channel[]> {
  return apiJson<Channel[]>("/channels/dm");
}

/** Find-or-create the DM with one target (a user OR a bot). Returns the dm channel. */
export async function createDm(target: {
  target_user_id?: string;
  target_bot_id?: string;
}): Promise<Channel> {
  return apiJson<Channel>("/channels/dm", {
    method: "POST",
    body: JSON.stringify(target),
  });
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
  initial_bot_ids?: string[];
}): Promise<Channel> {
  return apiJson<Channel>("/channels", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function addChannelMember(
  channelId: string,
  member: { member_id: string; member_type: "user" | "bot"; role?: string }
): Promise<void> {
  await apiJson(`/channels/${channelId}/members`, {
    method: "POST",
    body: JSON.stringify(member),
  });
}

export async function removeChannelMember(
  channelId: string,
  memberId: string
): Promise<void> {
  await apiJson(`/channels/${channelId}/members/${memberId}`, {
    method: "DELETE",
  });
}

export async function updateChannel(
  channelId: string,
  patch: {
    name?: string;
    purpose?: string | null;
    type?: string;
    auto_assist?: boolean;
    allow_member_invites?: boolean;
    allow_bot_adds?: boolean;
  }
): Promise<Channel> {
  return apiJson<Channel>(`/channels/${channelId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteChannel(channelId: string): Promise<void> {
  await apiJson(`/channels/${channelId}`, { method: "DELETE" });
}

/** Clear the caller's unread badge for a channel (stamps last_read_at server-side). */
export async function markChannelRead(channelId: string): Promise<void> {
  await apiJson(`/channels/${channelId}/read`, { method: "POST" });
}
