import type { FileContent, FsClient } from "./fsClient";

export interface FileResourceSnapshot {
  file?: FileContent;
  loading: boolean;
  error?: unknown;
}
interface Entry {
  snapshot: FileResourceSnapshot;
  listeners: Set<() => void>;
  pending?: Promise<FileContent>;
  generation: number;
  refreshToken?: number;
}

/** Server snapshots only. Raw editor buffers and form drafts remain view-local.
 * The host shares one FsClient across chat and Workbench, scoped to its channel
 * and authenticated resource transport. No second data endpoint or store. */
export function createFileResourceStore(fs: FsClient) {
  const entries = new Map<string, Entry>();
  const entry = (path: string) => {
    let value = entries.get(path);
    if (!value) {
      value = { snapshot: { loading: false }, listeners: new Set(), generation: 0 };
      entries.set(path, value);
    }
    return value;
  };
  const update = (value: Entry, snapshot: FileResourceSnapshot) => {
    value.snapshot = snapshot;
    value.listeners.forEach((notify) => notify());
  };
  const read = (path: string): Promise<FileContent> => {
    const value = entry(path);
    if (value.pending) return value.pending;
    const generation = ++value.generation;
    update(value, { ...value.snapshot, loading: true, error: undefined });
    const pending = Promise.resolve().then(() => fs.read(path)).then((file) => {
      if (generation === value.generation) update(value, { file, loading: false });
      return value.snapshot.file ?? file;
    }, (error: unknown) => {
      if (generation !== value.generation && value.snapshot.file) return value.snapshot.file;
      if (generation === value.generation) update(value, { loading: false, error });
      throw error;
    }).finally(() => {
      if (value.pending === pending) value.pending = undefined;
    });
    value.pending = pending;
    return pending;
  };
  return {
    active: () => [...entries.values()].some((value) => value.listeners.size > 0 || value.pending),
    snapshot: (path: string) => entry(path).snapshot,
    subscribe(path: string, notify: () => void) {
      const value = entry(path);
      value.listeners.add(notify);
      return () => {
        value.listeners.delete(notify);
        // Keep active resources; bound cached history for a long-running channel.
        if (entries.size > 128) for (const [key, item] of entries) {
          if (!item.listeners.size && !item.pending) entries.delete(key);
          if (entries.size <= 128) break;
        }
      };
    },
    read,
    refresh(path: string, token: number) {
      const value = entry(path);
      if (value.refreshToken === token) return value.pending ?? Promise.resolve(value.snapshot.file);
      const previous = value.refreshToken;
      value.refreshToken = token;
      // A signal during a read requires another read after it settles. The first
      // mount can join the Workbench's pending read; it is not an invalidation.
      if (previous !== undefined && value.pending) return value.pending.catch(() => undefined).then(() => read(path));
      return read(path);
    },
    publish(path: string, file: FileContent) {
      const value = entry(path);
      ++value.generation;
      value.pending = undefined;
      update(value, { file, loading: false });
    },
  };
}
const stores = new WeakMap<FsClient, ReturnType<typeof createFileResourceStore>>();
export function fileResourceStore(fs: FsClient) {
  let store = stores.get(fs);
  if (!store) { store = createFileResourceStore(fs); stores.set(fs, store); }
  return store;
}
