import type { Message } from "@/types";
import { mergeMessageContentData } from "./taskClaimProjection";

// In-flight bot placeholders have no channel sequence and remain newest until finalized.
const SEQ_MAX = Number.MAX_SAFE_INTEGER;
const sequence = (message: Message): number =>
  typeof message.channel_seq === "number" ? message.channel_seq : SEQ_MAX;

export function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => sequence(left) - sequence(right));
}

export function upsertMessage(
  messages: Message[],
  incoming: Partial<Message> & { msg_id: string },
): Message[] {
  const index = messages.findIndex((message) => message.msg_id === incoming.msg_id);
  if (index === -1) return sortMessages([...messages, incoming as Message]);
  const reorder =
    incoming.channel_seq !== undefined &&
    messages[index].channel_seq !== incoming.channel_seq;
  const next = messages.map((message, currentIndex) =>
    currentIndex === index ? {
      ...message, ...incoming,
      content_data: mergeMessageContentData(message.content_data, incoming.content_data),
      ...(message.is_deleted ? { is_deleted: true, content: "" } : {}),
    } : message,
  );
  return reorder ? sortMessages(next) : next;
}

export function patchMessageContentData(messages: Message[], msgId: string, contentData: Message["content_data"]): Message[] {
  return messages.map((message) => message.msg_id === msgId
    ? { ...message, content_data: mergeMessageContentData(message.content_data, contentData) }
    : message);
}

export function mergeMessages(messages: Message[], incoming: Message[]): Message[] {
  return incoming.reduce(upsertMessage, messages);
}
