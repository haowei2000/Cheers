import { apiJson } from "./client";
import type { Message } from "@/types";

export interface DiscussionReplyPreview {
  msg_id: string;
  sender_id: string;
  sender_type: "user" | "bot";
  sender_name: string;
  content: string;
  created_at: string;
}

export interface DiscussionParticipant {
  member_id: string;
  member_type: "user" | "bot";
  name: string;
  avatar_url?: string | null;
}

export interface DiscussionSummary {
  root: Message;
  reply_count: number;
  last_activity_at: string;
  last_reply?: DiscussionReplyPreview | null;
  participants: DiscussionParticipant[];
  participant_count: number;
}

export interface ListDiscussionsResponse {
  discussions: DiscussionSummary[];
  meta: { next_cursor?: string | null; has_more: boolean };
}

export interface DiscussionDetailResponse {
  root: Message;
  replies: Message[];
  meta: { has_more_before: boolean; limit: number };
}

export async function listDiscussions(
  channelId: string,
  opts: { cursor?: string; limit?: number; q?: string } = {},
): Promise<ListDiscussionsResponse> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  const suffix = params.size ? `?${params}` : "";
  return apiJson(`/channels/${channelId}/discussions${suffix}`);
}

export async function getDiscussion(
  channelId: string,
  rootMessageId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<DiscussionDetailResponse> {
  const params = new URLSearchParams();
  if (opts.before) params.set("before", opts.before);
  if (opts.limit) params.set("limit", String(opts.limit));
  const suffix = params.size ? `?${params}` : "";
  return apiJson(
    `/channels/${channelId}/discussions/${rootMessageId}${suffix}`,
  );
}
