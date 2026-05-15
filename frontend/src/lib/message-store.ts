import type { Message } from "../types";

export interface MessageStore {
  ids: string[];
  byId: Record<string, Message>;
}

export type MessageUpdater = (message: Message) => Message;

export interface MessagePatchEntry {
  msgId: string;
  update: MessageUpdater;
}

export function emptyMessageStore(): MessageStore {
  return { ids: [], byId: {} };
}

export function messagesToStore(messages: Message[]): MessageStore {
  if (messages.length === 0) return emptyMessageStore();

  const ids: string[] = [];
  const byId: Record<string, Message> = {};
  for (const message of messages) {
    if (!byId[message.msg_id]) ids.push(message.msg_id);
    byId[message.msg_id] = message;
  }
  return { ids, byId };
}

export function storeToMessages(store: MessageStore): Message[] {
  return store.ids.map((id) => store.byId[id]).filter(Boolean);
}

export function trimMessageStoreToRecent(store: MessageStore, maxMessages: number): MessageStore {
  if (store.ids.length <= maxMessages) return store;
  const ids = store.ids.slice(-maxMessages);
  const byId: Record<string, Message> = {};
  for (const id of ids) {
    const message = store.byId[id];
    if (message) byId[id] = message;
  }
  return { ids, byId };
}

export function upsertMessage(
  store: MessageStore,
  message: Message,
  maxMessages?: number,
): MessageStore {
  const current = store.byId[message.msg_id];
  if (current === message) return store;

  const exists = Boolean(current);
  const byId = {
    ...store.byId,
    [message.msg_id]: current ? { ...current, ...message } : message,
  };
  const ids = exists ? store.ids : [...store.ids, message.msg_id];
  const next = { ids, byId };
  return maxMessages ? trimMessageStoreToRecent(next, maxMessages) : next;
}

export function patchMessage(
  store: MessageStore,
  msgId: string,
  update: MessageUpdater,
): MessageStore {
  const current = store.byId[msgId];
  if (!current) return store;

  const nextMessage = update(current);
  if (nextMessage === current) return store;
  return {
    ids: store.ids,
    byId: {
      ...store.byId,
      [msgId]: nextMessage,
    },
  };
}

export function patchMessages(
  store: MessageStore,
  patches: MessagePatchEntry[],
): MessageStore {
  if (patches.length === 0) return store;

  let byId: Record<string, Message> | null = null;
  for (const { msgId, update } of patches) {
    const current = (byId ?? store.byId)[msgId];
    if (!current) continue;
    const nextMessage = update(current);
    if (nextMessage === current) continue;
    if (!byId) byId = { ...store.byId };
    byId[msgId] = nextMessage;
  }

  return byId ? { ids: store.ids, byId } : store;
}
