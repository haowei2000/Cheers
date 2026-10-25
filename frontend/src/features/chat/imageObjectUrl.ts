import { apiFetch } from "@/api/client";

// A file_id always names the same bytes, so one download can back every view of an
// image for the whole session: the inline thumbnail and the full preview share it,
// and a message scrolled back into view (or a revisited channel) renders instantly.
// An <img src> can't carry the Bearer, hence blob → object URL. Bounded by total
// bytes, least-recently-used first, so an image-heavy session can't pin unbounded
// memory.
const BUDGET_BYTES = 150 * 1024 * 1024;

interface Entry {
  url: Promise<string>;
  bytes: number;
}

const cache = new Map<string, Entry>();
let totalBytes = 0;

function evict() {
  for (const [id, entry] of cache) {
    if (totalBytes <= BUDGET_BYTES || cache.size <= 1) return;
    cache.delete(id);
    totalBytes -= entry.bytes;
    void entry.url.then(URL.revokeObjectURL, () => {});
  }
}

export function loadImageObjectUrl(fileId: string): Promise<string> {
  const hit = cache.get(fileId);
  if (hit) {
    // Re-insert to mark as most recently used.
    cache.delete(fileId);
    cache.set(fileId, hit);
    return hit.url;
  }
  const entry: Entry = { url: Promise.resolve(""), bytes: 0 };
  entry.url = apiFetch(`/files/${fileId}/preview`)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("dl"))))
    .then((blob) => {
      if (cache.get(fileId) === entry) {
        entry.bytes = blob.size;
        totalBytes += blob.size;
        evict();
      }
      return URL.createObjectURL(blob);
    });
  // A failed load must not stick: the next view retries.
  entry.url.catch(() => {
    if (cache.get(fileId) === entry) cache.delete(fileId);
  });
  cache.set(fileId, entry);
  return entry.url;
}
