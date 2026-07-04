import { apiJson } from "./client";
import type { Channel, MemberItem } from "@/types";

export async function listChannels(workspaceId?: string): Promise<Channel[]> {
  const qs = workspaceId ? `?workspace_id=${workspaceId}` : "";
  return apiJson<Channel[]>(`/channels${qs}`);
}

/**
 * Channels the caller belongs to WITHOUT being a member of their workspace
 * (invited into the channel from outside). They never appear under a rail
 * workspace, so the sidebar shows them in a separate "shared with you" section;
 * each carries `workspace_name` as its label.
 */
export async function listGuestChannels(): Promise<Channel[]> {
  return apiJson<Channel[]>("/channels?guest=true");
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

/** One row of the channel invite picker (a user OR a bot the caller may invite). */
export interface InvitableItem {
  member_id: string;
  member_type: "user" | "bot";
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** Bots: connector liveness (non-null). Users: may be null. */
  is_online: boolean | null;
  already_member: boolean;
}

/** Channel admin: search users + bots invitable into a channel (substring on name). */
export async function searchInvitable(
  channelId: string,
  q: string
): Promise<InvitableItem[]> {
  const data = await apiJson<{ results: InvitableItem[] }>(
    `/channels/${channelId}/invitable?q=${encodeURIComponent(q)}`
  );
  return data.results;
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
  member: {
    member_id: string;
    member_type: "user" | "bot";
    role?: string;
    /** Bot only: pin the primary session's ACP working dir here (absolute path). */
    cwd?: string;
    /** Bot only: extra roots for the primary session (ACP additionalDirectories). */
    additional_dirs?: string[];
  }
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

/** Change a channel member's role (admin/owner only; refuses to demote the last owner). */
export async function setChannelMemberRole(
  channelId: string,
  memberId: string,
  role: string
): Promise<void> {
  await apiJson(`/channels/${channelId}/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/** The caller leaves a channel (any member except the last owner; not for DMs). */
export async function leaveChannel(channelId: string): Promise<void> {
  await apiJson(`/channels/${channelId}/leave`, { method: "POST" });
}
