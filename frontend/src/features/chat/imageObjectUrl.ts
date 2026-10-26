import { useEffect, useState } from "react";
import { apiFetch } from "@/api/client";
import { clientSessionGeneration } from "@/lib/clientSession";

// A file_id always names the same bytes, so one download can back every view of an
// image: the inline thumbnail and the full preview share it, and a message scrolled
// back into view (or a revisited channel) renders instantly. An <img src> can't carry
// the Bearer, hence blob → object URL.
//
// Views hold a lease while mounted. Only settled entries nobody holds are evicted
// (least-recently-used first, past a total byte budget), so a URL is never revoked
// under a mounted <img> or before its download lands. The cache is per account:
// cleared on logout / account switch.
const BUDGET_BYTES = 150 * 1024 * 1024;
/** An unheld image is fetched again after this, so a deleted or expired file, or a
 * channel the user lost access to, stops rendering instead of living for the tab. */
const MAX_REUSE_MS = 10 * 60 * 1000;

interface Entry {
  url: Promise<string>;
  /** Set once the download lands; null while in flight. */
  objectUrl: string | null;
  bytes: number;
  holders: number;
  loadedAt: number;
  generation: number;
}

export interface ImageLease {
  url: Promise<string>;
  /** Drop this view's hold; idempotent. */
  release: () => void;
}

const cache = new Map<string, Entry>();
let totalBytes = 0;

function drop(fileId: string, entry: Entry) {
  cache.delete(fileId);
  totalBytes -= entry.bytes;
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
}

function evict() {
  for (const [fileId, entry] of cache) {
    if (totalBytes <= BUDGET_BYTES) return;
    if (entry.holders > 0 || !entry.objectUrl) continue;
    drop(fileId, entry);
  }
}

function load(fileId: string, generation: number): Entry {
  const entry: Entry = {
    url: Promise.resolve(""),
    objectUrl: null,
    bytes: 0,
    holders: 0,
    loadedAt: 0,
    generation,
  };
  entry.url = apiFetch(`/files/${fileId}/preview`)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`image preview ${r.status}`))))
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      if (cache.get(fileId) !== entry) {
        // The cache was cleared (account change) while this was in flight.
        URL.revokeObjectURL(url);
        throw new Error("image cache cleared");
      }
      entry.objectUrl = url;
      entry.bytes = blob.size;
      entry.loadedAt = Date.now();
      totalBytes += blob.size;
      evict();
      return url;
    });
  // A failed load must not stick: the next view retries.
  entry.url.catch(() => {
    if (cache.get(fileId) === entry) cache.delete(fileId);
  });
  return entry;
}

/** Revoke every cached image; called when the signed-in account changes. */
export function clearImageObjectUrls() {
  for (const [fileId, entry] of cache) drop(fileId, entry);
}

if (typeof window !== "undefined") {
  window.addEventListener("cheers:session-cleared", clearImageObjectUrls);
}

/** Share one authorized download of an image; call `release` when the view unmounts. */
export function acquireImageObjectUrl(fileId: string): ImageLease {
  const generation = clientSessionGeneration();
  let entry = cache.get(fileId);
  if (
    entry &&
    (entry.generation !== generation ||
      (entry.holders === 0 && entry.objectUrl && Date.now() - entry.loadedAt > MAX_REUSE_MS))
  ) {
    drop(fileId, entry);
    entry = undefined;
  }
  if (entry) {
    // Re-insert to mark as most recently used.
    cache.delete(fileId);
  } else {
    entry = load(fileId, generation);
  }
  cache.set(fileId, entry);
  entry.holders += 1;
  const held = entry;
  let released = false;
  return {
    url: held.url,
    release: () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (cache.get(fileId) === held) evict();
    },
  };
}

/** Object URL for an image file while the calling view is mounted. `retry` re-runs
 * a failed load; `enabled` defers the download (e.g. until the tile nears view). */
export function useImageObjectUrl(fileId: string, enabled = true) {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({
    src: null,
    failed: false,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const lease = acquireImageObjectUrl(fileId);
    let alive = true;
    setState({ src: null, failed: false });
    lease.url.then(
      (src) => alive && setState({ src, failed: false }),
      () => alive && setState({ src: null, failed: true }),
    );
    return () => {
      alive = false;
      lease.release();
    };
  }, [fileId, enabled, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
