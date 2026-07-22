import { apiJson } from "./client";
import type {
  Channel,
  MemberItem,
  VoicePresenceSnapshot,
  VoiceTranscriptSegment,
} from "@/types";

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
  kind?: "text" | "voice";
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

export interface VoiceJoinResponse {
  url: string;
  token: string;
  room_name: string;
  voice_session_id: string;
  participant_identity: string;
  can_publish: boolean;
  expires_at: number;
}

export interface VoiceStateResponse {
  enabled: boolean;
  channel_kind: string;
  /** Server-authoritative owner/admin permission for caption controls. */
  can_manage: boolean;
  session: {
    voice_session_id: string;
    status: string;
    transcription_status: "off" | "starting" | "active" | "failed";
    started_at: string;
  } | null;
}

export interface VoiceTranscriptionControlResponse {
  voice_session_id: string;
  transcription_status: "off" | "starting" | "active" | "failed";
}

export interface DictationCapabilityResponse {
  adapter_configured: boolean;
  adapter_kind?: "stepfun" | "openai";
}

export interface DictationTranscriptResponse {
  transcript: string;
}

export function getDictationCapability(channelId: string): Promise<DictationCapabilityResponse> {
  return apiJson<DictationCapabilityResponse>(
    `/channels/${channelId}/voice/dictation-capability`,
  );
}

export function transcribeDictation(
  channelId: string,
  audio: Blob,
): Promise<DictationTranscriptResponse> {
  return apiJson<DictationTranscriptResponse>(`/channels/${channelId}/voice/dictation`, {
    method: "POST",
    headers: { "Content-Type": audio.type || "audio/webm" },
    body: audio,
  });
}

/** Authorize this member and mint a short-lived, room-scoped LiveKit token. */
export async function joinVoiceChannel(channelId: string): Promise<VoiceJoinResponse> {
  return apiJson<VoiceJoinResponse>(`/channels/${channelId}/voice/join`, {
    method: "POST",
  });
}

export interface VoiceConsentResponse {
  consented: boolean;
  publish_token: string | null;
  can_publish: boolean;
}

/** Accept the transcription disclosure; returns a publishable token to upgrade
 *  from listen-only to mic publish. */
export async function grantVoiceConsent(channelId: string): Promise<VoiceConsentResponse> {
  return apiJson<VoiceConsentResponse>(`/channels/${channelId}/voice/consent`, {
    method: "POST",
  });
}

/** Withdraw transcription consent (the client must mute its mic immediately). */
export async function withdrawVoiceConsent(channelId: string): Promise<VoiceConsentResponse> {
  return apiJson<VoiceConsentResponse>(`/channels/${channelId}/voice/consent`, {
    method: "DELETE",
  });
}

export async function getVoiceState(channelId: string): Promise<VoiceStateResponse> {
  return apiJson<VoiceStateResponse>(`/channels/${channelId}/voice/state`);
}

export async function setVoiceTranscription(
  channelId: string,
  enabled: boolean
): Promise<VoiceTranscriptionControlResponse> {
  return apiJson<VoiceTranscriptionControlResponse>(
    `/channels/${channelId}/voice/transcription/${enabled ? "start" : "stop"}`,
    { method: "POST" }
  );
}

/** Initial app-wide occupancy for voice channels visible to the caller. */
export async function listVoicePresence(): Promise<VoicePresenceSnapshot[]> {
  return apiJson<VoicePresenceSnapshot[]>("/voice/presence");
}

export async function listVoiceTranscript(
  channelId: string,
  afterSeq = 0,
  limit = 100
): Promise<VoiceTranscriptSegment[]> {
  return apiJson<VoiceTranscriptSegment[]>(
    `/channels/${channelId}/voice/transcript?after_seq=${afterSeq}&limit=${limit}`
  );
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

/** Self-serve join for a PUBLIC channel — active workspace members only.
 * Private channels stay invite-only (accept/decline below). */
export async function joinChannel(channelId: string): Promise<void> {
  await apiJson(`/channels/${channelId}/join`, { method: "POST" });
}

/** Accept a pending channel invite — materializes the caller's membership. */
export async function acceptChannelInvite(channelId: string): Promise<void> {
  await apiJson(`/channels/${channelId}/accept`, { method: "POST" });
}

/** Decline a pending channel invite. */
export async function declineChannelInvite(channelId: string): Promise<void> {
  await apiJson(`/channels/${channelId}/decline`, { method: "POST" });
}
