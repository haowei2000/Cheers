/** @file Merge REST discussion detail with live channel messages for one topic. */

import type { Message } from "@/types";

/** Whether a message belongs to a discussion root (including the root itself). */
export function inDiscussionThread(message: Message, rootId: string): boolean {
  if (message.msg_id === rootId) return true;
  if (message.thread_root_msg_id === rootId) return true;
  return false;
}

/** Overlay live WS rows (partials, permission cards) onto the REST thread. */
export function mergeDiscussionMessages(
  root: Message,
  replies: Message[],
  live: Message[],
): Message[] {
  const byId = new Map<string, Message>();
  byId.set(root.msg_id, root);
  for (const message of replies) byId.set(message.msg_id, message);

  const consider = (message: Message) => {
    if (byId.has(message.msg_id)) {
      const previous = byId.get(message.msg_id)!;
      if (
        message.is_partial ||
        (message.channel_seq ?? 0) >= (previous.channel_seq ?? 0)
      ) {
        byId.set(message.msg_id, { ...previous, ...message });
      }
      return;
    }
    if (
      inDiscussionThread(message, root.msg_id) ||
      (message.reply_to_msg_id != null && byId.has(message.reply_to_msg_id))
    ) {
      byId.set(message.msg_id, message);
    }
  };

  for (const message of live) consider(message);
  // Streaming bot turns often arrive with only reply_to set; walk until stable.
  let grew = true;
  while (grew) {
    grew = false;
    for (const message of live) {
      if (byId.has(message.msg_id)) continue;
      if (message.reply_to_msg_id && byId.has(message.reply_to_msg_id)) {
        byId.set(message.msg_id, message);
        grew = true;
      }
    }
  }

  // A row that is still streaming has no channel_seq yet. Coalescing that to 0
  // sorted the newest turn to the very top of the thread; it belongs last,
  // after every row the server has already sequenced.
  const order = (message: Message) =>
    message.channel_seq ?? Number.MAX_SAFE_INTEGER;
  return [...byId.values()].sort((a, b) => order(a) - order(b));
}
