import type { Message } from "@/types";

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
    currentIndex === index ? { ...message, ...incoming } : message,
  );
  return reorder ? sortMessages(next) : next;
}

export function mergeMessages(messages: Message[], incoming: Message[]): Message[] {
  return incoming.reduce(upsertMessage, messages);
}
