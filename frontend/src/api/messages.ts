import { apiJson } from "./client";
import type { Message } from "@/types";

interface MessagesResponse {
  messages: Message[];
  data: Message[];
  meta: {
    has_more_before: boolean;
    has_more_after: boolean;
    has_more: boolean;
    limit: number;
  };
}

export async function listMessages(
  channelId: string,
  opts: { before?: string; after?: string; since_seq?: number; limit?: number } = {}
): Promise<MessagesResponse> {
  const params = new URLSearchParams();
  if (opts.before) params.set("before", opts.before);
  if (opts.after) params.set("after", opts.after);
  if (opts.since_seq !== undefined) params.set("since_seq", String(opts.since_seq));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params}` : "";
  return apiJson<MessagesResponse>(
    `/channels/${channelId}/messages${qs}`
  );
}

export async function sendMessage(
  channelId: string,
  content: string,
  opts: {
    file_ids?: string[];
    mention_ids?: string[];
    reply_to_msg_id?: string;
    // Route the prompt to a specific session in this channel (a bot's "other" or
    // primary session). Omit to use mention-based routing → the channel primary.
    session_id?: string;
  } = {}
): Promise<Message> {
  return apiJson<Message>(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, ...opts }),
  });
}

export async function cancelMessage(
  channelId: string,
  msgId: string
): Promise<void> {
  await apiJson(`/channels/${channelId}/messages/${msgId}/cancel`, {
    method: "POST",
  });
}
