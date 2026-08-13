/** @file Build compact, plain-text previews for reply banners and quoted messages. */

import type { Message } from "@/types";

const FILE_TOKEN_RE = /<#file:[^>]+>/g;

/** Strip rich-message syntax and return a stable sender label and short excerpt. */
export function replyPreviewOf(message: Message, senderName?: string) {
  const content = (message.content ?? "")
    .replace(FILE_TOKEN_RE, "")
    .replace(/```[\s\S]*?```/g, " Code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/(?:\*\*|__|~~)/g, "")
    .replace(/(^|\s)[#>*-]+\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return {
    sender:
      message.sender_name || senderName || message.sender_id.slice(0, 8),
    excerpt:
      content.slice(0, 140) ||
      (message.files?.length ? "Attachment" : "Empty message"),
  };
}
