import { getChannelProfile, type ChannelProfile } from "@/api/channelProfiles";
import { clientSessionGeneration } from "@/lib/clientSession";

const POLL_INTERVAL_MS = 5_000;
const MAX_CACHED_CHANNELS = 30;

/** Shared REST snapshots. Only enabled consumers retain polling; an invalidation
 * during a request schedules one fresh read after that request settles. */
export function createChannelProfileStore(load: typeof getChannelProfile) {
  type Entry = ReturnType<typeof createEntry>;
  const entries = new Map<string, Entry>();
  let generation = clientSessionGeneration();

  const prune = (protectedEntry?: Entry) => {
    if (entries.size <= MAX_CACHED_CHANNELS) return;
    for (const [channelId, entry] of entries) {
      if (entry !== protectedEntry && entry.idle()) { entry.close(); entries.delete(channelId); }
      if (entries.size <= MAX_CACHED_CHANNELS) break;
    }
  };

  function createEntry(channelId: string) {
    const session = generation;
    let profile: ChannelProfile | null = null;
    const listeners = new Map<symbol, () => void>();
    let enabledConsumers = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending: Promise<void> | undefined;
    let refreshPending = false;
    let activation = 0;
    let revision = 0;
    let closed = false;
    let hasRefreshKey = false;
    let lastRefreshKey: unknown;
    const current = () => !closed && session === clientSessionGeneration();
    const publish = (next: ChannelProfile | null) => {
      profile = next;
      listeners.forEach((notify) => notify());
    };
    const request = (): Promise<void> => {
      if (!current() || !enabledConsumers || !channelId) return Promise.resolve();
      if (pending) return pending;
      const started = activation;
      const observed = revision;
      const operation = Promise.resolve().then(() => {
        if (!current() || !enabledConsumers || started !== activation || observed !== revision) return undefined;
        return load(channelId);
      }).then((value) => {
        if (value !== undefined && current() && enabledConsumers && started === activation && observed === revision) publish(value);
      }, () => {
        if (current() && enabledConsumers && started === activation && observed === revision) publish(null);
      }).finally(() => {
        if (pending === operation) pending = undefined;
        if (refreshPending && current() && enabledConsumers) {
          refreshPending = false;
          void request();
        }
        prune();
      });
      pending = operation;
      return operation;
    };
    const invalidate = (key: unknown) => {
      // Undefined means this consumer has no event cursor. It must not replace
      // the cursor supplied by a board consumer of this same channel.
      if (!current() || key === undefined || (hasRefreshKey && Object.is(lastRefreshKey, key))) return;
      hasRefreshKey = true;
      lastRefreshKey = key;
      revision++;
      if (!enabledConsumers) return;
      if (pending) refreshPending = true;
      else void request();
    };

    return {
      snapshot: () => current() ? profile : null,
      subscribe(notify: () => void, enabled: boolean, refreshKey?: unknown) {
        const id = Symbol();
        listeners.set(id, notify);
        const retained = enabled && !!channelId && current();
        if (retained) {
          // Register the first consumer's cursor before its initial request, so
          // that its effect cannot invalidate the request it just started.
          invalidate(refreshKey);
          if (enabledConsumers++ === 0) {
            activation++;
            if (pending) refreshPending = true; // an earlier mount's read is obsolete
            else void request();
            timer = setInterval(() => { void request(); }, POLL_INTERVAL_MS);
          }
        }
        return () => {
          if (!listeners.delete(id)) return;
          if (retained && --enabledConsumers === 0) {
            activation++;
            refreshPending = false;
            if (timer !== undefined) clearInterval(timer);
            timer = undefined;
          }
          prune();
        };
      },
      invalidate,
      idle: () => !listeners.size && !pending,
      close() {
        closed = true;
        activation++;
        refreshPending = false;
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        publish(null);
      },
    };
  }

  const clear = () => {
    generation = clientSessionGeneration();
    const previous = [...entries.values()];
    entries.clear();
    previous.forEach((entry) => entry.close());
  };
  const target = typeof window === "undefined" ? undefined : window;
  target?.addEventListener("cheers:session-cleared", clear);

  return {
    resource(channelId: string) {
      if (generation !== clientSessionGeneration()) clear();
      let entry = entries.get(channelId);
      if (!entry) entry = createEntry(channelId);
      entries.delete(channelId);
      entries.set(channelId, entry);
      prune(entry);
      return entry;
    },
    clear,
    dispose() { target?.removeEventListener("cheers:session-cleared", clear); clear(); },
  };
}

export const channelProfileStore = createChannelProfileStore(getChannelProfile);
