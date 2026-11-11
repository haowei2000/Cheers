import type { SendResourceReq } from "../workbench/fsClient";
import { makeArtifactClient, type Artifact, type ArtifactClient } from "./client";

/** What a surface that REFERENCES an artifact knows about it: the catalog entry and, for
 *  a ready text artifact, the head of its source. `missing` covers both an id the channel
 *  does not have and one this viewer may not read — a reference must not say which. */
export interface ArtifactReference {
  artifact?: Artifact;
  missing?: boolean;
  /** The first HEAD_CHARS of a text artifact's source, as of `artifact.version`. */
  head?: string;
  loading: boolean;
}

/** Enough for a card excerpt or a collapsed preview; the full source belongs to an
 *  editing session, not to every surface that mentions the artifact. */
export const HEAD_CHARS = 4096;
const MAX_IDLE_ENTRIES = 256;
const EMPTY: ArtifactReference = { loading: false };

interface Entry {
  snapshot: ArtifactReference;
  listeners: Set<() => void>;
  pending?: Promise<void>;
  /** The invalidation this entry last loaded for. */
  epoch?: object;
  headVersion?: number;
}

export function quotable(artifact: Artifact): boolean {
  return artifact.availability === "ready" && artifact.source_kind === "text";
}

/** One reference cache per channel, keyed by artifact id. Message cards, canvas nodes and
 *  any other surface that points at an artifact read it here, so the same artifact is
 *  fetched once, described the same way everywhere, and refreshed by one signal. */
export function createArtifactReferenceStore(client: Pick<ArtifactClient, "get" | "read">) {
  const entries = new Map<string, Entry>();
  // Compared by identity. The first tick a host reports names the state the store has
  // been loading all along, so it labels the current epoch instead of starting a new one.
  let epoch: { tick?: number } = {};
  let revision = 0;
  const entry = (id: string) => {
    let value = entries.get(id);
    if (!value) {
      value = { snapshot: EMPTY, listeners: new Set() };
      entries.set(id, value);
    }
    return value;
  };
  const update = (value: Entry, snapshot: ArtifactReference) => {
    value.snapshot = snapshot;
    revision++;
    value.listeners.forEach((notify) => notify());
  };
  const load = (id: string): Promise<void> => {
    const value = entry(id);
    if (value.pending) return value.pending;
    const loadingFor = epoch;
    update(value, { ...value.snapshot, loading: true });
    const pending = (async () => {
      let artifact: Artifact;
      try {
        artifact = await client.get(id);
      } catch {
        // A reference that has resolved before keeps its last answer: one dropped
        // request must not turn a real artifact into "Unavailable". The epoch is left
        // unset so the next subscriber or invalidation asks again.
        update(value, value.snapshot.artifact ? { ...value.snapshot, loading: false } : { missing: true, loading: false });
        return;
      }
      value.epoch = loadingFor;
      const keepHead = quotable(artifact) && value.headVersion === artifact.version;
      update(value, { artifact, head: keepHead ? value.snapshot.head : undefined, loading: quotable(artifact) && !keepHead });
      if (!quotable(artifact) || keepHead) return;
      // The head is a second read, so a slow or failed one never holds back the title.
      const content = await client.read(id).catch(() => null);
      if (content?.kind === "text" && typeof content.content === "string") {
        value.headVersion = content.artifact.version;
        update(value, { artifact: content.artifact, head: content.content.slice(0, HEAD_CHARS), loading: false });
      } else {
        update(value, { artifact, loading: false });
      }
    })().finally(() => {
      value.pending = undefined;
      // An invalidation that arrived mid-load asked about a newer state.
      if (value.epoch !== undefined && value.epoch !== epoch && value.listeners.size) void load(id);
    });
    value.pending = pending;
    return pending;
  };
  return {
    snapshot: (id: string): ArtifactReference => entries.get(id)?.snapshot ?? EMPTY,
    /** Changes whenever any reference does; lets one subscriber watch many ids. */
    revision: () => revision,
    subscribe(id: string, notify: () => void) {
      const value = entry(id);
      value.listeners.add(notify);
      if (value.epoch !== epoch) void load(id);
      return () => {
        value.listeners.delete(notify);
        if (entries.size > MAX_IDLE_ENTRIES) for (const [key, item] of entries) {
          if (!item.listeners.size && !item.pending) entries.delete(key);
          if (entries.size <= MAX_IDLE_ENTRIES) break;
        }
      };
    },
    /** The channel's files changed: every reference on screen is asked again, and idle
     *  ones on their next subscription. Repeating a tick is a no-op, so every host that
     *  sees the same change may report it. */
    invalidate(tick: number) {
      if (tick === epoch.tick) return;
      if (epoch.tick === undefined) { epoch.tick = tick; return; }
      epoch = { tick };
      for (const [id, value] of entries) if (value.listeners.size) void load(id);
    },
    load,
  };
}

export type ArtifactReferenceStore = ReturnType<typeof createArtifactReferenceStore>;

const stores = new WeakMap<SendResourceReq, Map<string, ArtifactReferenceStore>>();
export function artifactReferenceStore(send: SendResourceReq, channelId: string): ArtifactReferenceStore {
  let channels = stores.get(send);
  if (!channels) { channels = new Map(); stores.set(send, channels); }
  let store = channels.get(channelId);
  if (!store) { store = createArtifactReferenceStore(makeArtifactClient(send, channelId)); channels.set(channelId, store); }
  return store;
}
