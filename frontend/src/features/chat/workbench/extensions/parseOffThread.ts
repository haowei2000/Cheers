import type { PersonalExtension } from "@/lib/desktop";
import type { ParsedExtension } from "./package";
import type { ParseRequest, ParseResponse } from "./package.worker";

/** Longer than any honest package needs by two orders of magnitude — the 8 MiB
 * expanded cap inflates in about 25 ms — and short enough that a crafted one
 * cannot hold a thread for a noticeable stretch. */
const PARSE_TIMEOUT_MS = 5_000;

interface Pending {
  resolve: (parsed: ParsedExtension) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function discardWorker(reason: Error): void {
  worker?.terminate();
  worker = null;
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(reason);
  }
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL("./package.worker.ts", import.meta.url), { type: "module" });
  created.onmessage = (event: MessageEvent<ParseResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    clearTimeout(entry.timer);
    if (event.data.ok) entry.resolve(event.data.parsed);
    else entry.reject(new Error(event.data.message));
  };
  created.onerror = () => discardWorker(new Error("Extension parser stopped unexpectedly"));
  worker = created;
  return created;
}

/** Parse a package on a worker thread, under a wall-clock bound.
 *
 * Inflation is the reason this is not just a nicety. `fflate` walks the entire
 * compressed stream even when its output buffer is already full, so bounding the
 * output bounds memory but not time: 256 MiB of zeros compresses to 262 KB, and a
 * package inside the 4 MiB limit can carry several GiB — seconds of solid work
 * that on the main thread is a frozen window. Terminating the worker is the only
 * bound available, since there is nothing to check before doing the work.
 *
 * A timeout terminates the worker, which necessarily fails every parse in flight
 * on it. That is the right trade for a batch: one hostile package in a set is
 * reason enough to distrust the set, and a legitimate one never comes close. */
export function parseExtensionPackageOffThread(
  input: ArrayBuffer | Uint8Array,
  scope: "global" | "personal" | "temporary",
): Promise<ParsedExtension> {
  return new Promise<ParsedExtension>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => discardWorker(new Error("Extension took too long to parse and was rejected")),
      PARSE_TIMEOUT_MS,
    );
    pending.set(id, { resolve, reject, timer });
    try {
      ensureWorker().postMessage({ id, input, scope } satisfies ParseRequest);
    } catch (error) {
      discardWorker(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Parsed packages, keyed by the bytes they came from. */
const parsed = new Map<string, Promise<ParsedExtension>>();

/** Enough for every extension a person has installed, several versions over. The
 * cap exists so a long session that keeps replacing a package does not retain
 * every version's bytes — each entry holds up to 4 MiB. */
const CACHE_LIMIT = 16;

/** Parse a package stored on this Mac, reusing the last result for the same bytes.
 *
 * Worth caching because the same handful of packages is re-parsed constantly: on
 * every drawer open, on every `cheers:extensions-changed`, and by the scheduled
 * messages screen, which inflates up to 8 MiB per package to read a list of
 * `{id, title}`. Each parse is a base64 decode, a central-directory walk, an
 * inflate, a JSON parse, a UTF-8 decode and a SHA-256.
 *
 * The identity is free: `plugins.rs` already hashes each file when it lists them,
 * so the key needs no work here — which is the only reason a cache is possible at
 * all, since the parse is what would otherwise produce the digest. Scope is part
 * of the key because the same bytes legitimately parse into different scenes
 * under different scopes.
 *
 * Referential stability is the second reason. `SandboxRenderer` memoizes its
 * iframe document on the renderer extension's identity, so a fresh object per
 * parse rebuilt the document and rebooted the iframe on every drawer open. */
export function parsePersonalExtension(stored: PersonalExtension): Promise<ParsedExtension> {
  const key = `personal:${stored.id}:${stored.sha256}`;
  const hit = parsed.get(key);
  if (hit) return hit;
  const binary = atob(stored.contentBase64);
  const pending = parseExtensionPackageOffThread(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    "personal",
  );
  // A failed parse is not cached: it holds a rejected promise nobody may await,
  // and re-reading a package the user has since replaced should try again.
  pending.catch(() => parsed.delete(key));
  parsed.set(key, pending);
  if (parsed.size > CACHE_LIMIT) parsed.delete(parsed.keys().next().value!);
  return pending;
}
