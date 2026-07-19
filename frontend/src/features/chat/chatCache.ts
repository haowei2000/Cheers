import type { Message, MemberItem } from "@/types";

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

export function getChannelCache(channelId: string): ChannelCacheEntry | null {
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
  const prev = cache.get(channelId);
  if (prev) cache.delete(channelId);
  cache.set(channelId, {
    messages: prev?.messages ?? [],
    hasMore: prev?.hasMore ?? false,
    members: prev?.members ?? null,
    ...patch,
  });
  while (cache.size > MAX_CHANNELS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
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
