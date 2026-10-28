import type { Message, MemberItem } from "@/types";
import { clientSessionGeneration } from "@/lib/clientSession";
import { upsertMessage } from "./messageCollection";

/** Per-channel in-memory cache (Discord/Telegram-style): re-entering a channel
 *  renders the cached window instantly, then a `since_seq` catch-up merges
 *  anything that landed while we were away. Session-scoped by design — a page
 *  reload starts cold, so there is no staleness to persist or invalidate. */
export interface ChannelCacheEntry {
  messages: Message[];
  hasMore: boolean;
  members: MemberItem[] | null;
}

/** LRU bound on cached channels — enough to cover normal channel-hopping
 *  without letting a long session pin every visited channel's history. */
const MAX_CHANNELS = 30;

/** Cap on messages re-hydrated per entry: a long scrollback session can
 *  accumulate many pages, and remounting hundreds of Markdown rows would trade
 *  the network stall for a render stall. Older pages stay reachable via the
 *  existing infinite scroll (`hasMore` flips back on when we trim). */
const MAX_SEED_MESSAGES = 100;

const cache = new Map<string, ChannelCacheEntry>();
let sessionGeneration = clientSessionGeneration();
function currentSession() {
  if (sessionGeneration === clientSessionGeneration()) return;
  cache.clear();
  sessionGeneration = clientSessionGeneration();
}

export function getChannelCache(channelId: string): ChannelCacheEntry | null {
  currentSession();
  const entry = cache.get(channelId);
  if (!entry) return null;
  // LRU touch: re-insert so iteration order stays least-recent-first.
  cache.delete(channelId);
  cache.set(channelId, entry);
  return entry;
}

export function setChannelCache(
  channelId: string,
  patch: Partial<ChannelCacheEntry>
): void {
  currentSession();
  const prev = cache.get(channelId);
  if (prev) cache.delete(channelId);
  cache.set(channelId, {
    messages: prev?.messages ?? [],
    hasMore: prev?.hasMore ?? false,
    members: prev?.members ?? null,
    ...patch,
    ...(patch.messages ? { messages: patch.messages.map((message) => {
      const previous = prev?.messages.find((item) => item.msg_id === message.msg_id);
      return previous ? upsertMessage([previous], message)[0] : message;
    }) } : {}),
  });
  while (cache.size > MAX_CHANNELS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function patchCachedMessageContentData(channelId: string, msgId: string, data: Message["content_data"]): void {
  patchCachedMessage(channelId, { msg_id: msgId, content_data: data });
}

export function patchCachedMessage(channelId: string, update: Partial<Message> & { msg_id: string }): void {
  currentSession();
  const entry = cache.get(channelId);
  if (entry?.messages.some((message) => message.msg_id === update.msg_id)) entry.messages = upsertMessage(entry.messages, update);
}

/** The message window to seed a re-entered channel with: trimmed to the newest
 *  MAX_SEED_MESSAGES, with any interrupted stream flags cleared (the finalized
 *  row arrives via catch-up and upserts by msg_id). Returns null when there is
 *  nothing cached — the caller falls back to a cold history load. */
export function seedFromCache(
  channelId: string
): { messages: Message[]; hasMore: boolean } | null {
  const entry = getChannelCache(channelId);
  if (!entry || entry.messages.length === 0) return null;
  const trimmed = entry.messages.length > MAX_SEED_MESSAGES;
  const window = trimmed
    ? entry.messages.slice(-MAX_SEED_MESSAGES)
    : entry.messages;
  return {
    messages: window.map((m) => (m._streaming ? { ...m, _streaming: false } : m)),
    hasMore: trimmed || entry.hasMore,
  };
}
