import { parse as yamlParse } from "yaml";
import { ResourceError } from "@/lib/realtimeTransport";
import type { FsClient } from "./fsClient";
import { applyEdits } from "./yamlDoc";
import { applyPatchOps, type PatchOp } from "./patchOps";

export function errMsg(e: unknown): string {
  if (e instanceof ResourceError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : "error";
}

// ── Format layer: string <-> data, chosen by file extension ──────────────────
// JSON and YAML for structured boards, plain text for Markdown / prompts.
// (XML intentionally unsupported.) `serialize` receives the previously loaded
// text so a format can round-trip what plain data can't carry — YAML uses it
// to preserve comments/blank lines across machine rewrites (see yamlDoc.ts).
interface Format {
  parse: (s: string) => unknown;
  serialize: (d: unknown, prevText?: string) => string;
}
const JSON_FMT: Format = {
  parse: (s) => (s.trim() ? JSON.parse(s) : null),
  serialize: (d) => JSON.stringify(d, null, 2),
};
const YAML_FMT: Format = {
  parse: (s) => (s.trim() ? (yamlParse(s) as unknown) : null),
  serialize: (d, prevText) => applyEdits(prevText ?? "", d),
};
const TEXT_FMT: Format = {
  parse: (s) => s,
  serialize: (d) => (typeof d === "string" ? d : String(d)),
};
export function isStructuredPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".json") || p.endsWith(".yaml") || p.endsWith(".yml");
}
export function formatFor(path: string): Format {
  const p = path.toLowerCase();
  if (p.endsWith(".json")) return JSON_FMT;
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return YAML_FMT;
  return TEXT_FMT;
}

// ── One file, one session ────────────────────────────────────────────────────
//
// `text` is the truth. The file IS text on the server; `data` is a lossy projection of
// it — comments, key order and blank lines survive only in the text. So Raw edits `text`
// and reparses, while a lens edits `data` and serializes back INTO `text` (YAML through
// the CST patch in yamlDoc.ts, which is what keeps the comments).
//
// One buffer, one version, one dirty flag. Before this, Raw and Preview each ran their
// own `fs.read` and held their own version, which meant: unsaved edits vanished on a
// mode switch, a save on one side left the other's version stale, and the renderer was
// MATCHED against one buffer while being RENDERED from the other.

/** The pure half of a session: what the two views show, and whether the text still
 *  parses. Separated from the hook so the rules that actually matter are testable
 *  without a DOM — this codebase has no jsdom, and these are the rules a Raw/Preview
 *  switch gets wrong when they live inline in an effect. */
export interface FileBuffer {
  text: string;
  data: unknown;
  /** The text `data` was parsed from. Equal to `text` except in two windows: while
   *  `parseError` is set (`data` is one edit behind the text), and between an optimistic
   *  `applyOps` and the reload after it (`data` is one op batch ahead). Renderer matching
   *  and source-line lookup use THIS, never `text`: a renderer must be chosen against the
   *  bytes it will be handed, and a lens's `sourcePath` can only resolve to lines in the
   *  text its own data came from. */
  parsedText: string;
  parseError: string | null;
  dirty: boolean;
}

/** An absent or empty file is not a parse failure: `null` for the structured formats,
 *  `""` for text — exactly what each format's parser returns for "". */
export function emptyBuffer(path: string): FileBuffer {
  return { text: "", data: formatFor(path).parse(""), parsedText: "", parseError: null, dirty: false };
}

function reparse(path: string, previous: FileBuffer, text: string): Omit<FileBuffer, "dirty"> {
  try {
    const data = formatFor(path).parse(text);
    return { text, data, parsedText: text, parseError: null };
  } catch (e) {
    // Half-typed YAML is invalid for most of the time you spend typing it. Keep the last
    // text that parsed on screen rather than blanking the preview per keystroke — and say
    // so, because a preview one edit behind is only safe if the reader knows it is.
    return { text, data: previous.data, parsedText: previous.parsedText, parseError: errMsg(e) };
  }
}

/** Take `content` as the file's current text (loaded, or written by someone else). A
 *  parse failure is reported WITHOUT hiding the text — a malformed file is precisely the
 *  one you need Raw for. */
export function adoptText(path: string, previous: FileBuffer, content: string): FileBuffer {
  return { ...reparse(path, previous, content), dirty: false };
}

/** Raw typed. */
export function editText(path: string, previous: FileBuffer, next: string): FileBuffer {
  return { ...reparse(path, previous, next), dirty: true };
}

/** A lens replaced the document; serialize it back into the text it came from. */
export function editData(path: string, previous: FileBuffer, next: unknown): FileBuffer {
  const text = formatFor(path).serialize(next, previous.text);
  return { text, data: next, parsedText: text, parseError: null, dirty: true };
}

/** Optimistic half of `applyOps`. `text` deliberately stays put: fs.patch returns a
 *  version, not content, and the reload after it brings back the bytes the SERVER wrote
 *  — comments included, which a local re-serialize would have lost. */
export function patchData(previous: FileBuffer, ops: readonly PatchOp[]): FileBuffer {
  return { ...previous, data: applyPatchOps(previous.data, ops) };
}

/** A stale `data` is safe to LOOK at and unsafe to write from: serializing it back would
 *  overwrite the half-typed text it no longer matches. */
export function canEditData(buffer: FileBuffer): boolean {
  return buffer.parseError === null;
}

/** An op is addressed against the SERVER's document. Unsaved text means the server holds
 *  something else, so patching would splice the edit into a document the user is no
 *  longer looking at — and the next Save would then conflict against the version the
 *  patch itself bumped. */
export function canPatch(buffer: FileBuffer): boolean {
  return buffer.parseError === null && !buffer.dirty;
}

export interface FileSessionConflict {
  remoteText: string;
  localText: string;
  baseText: string;
  conflictsCount: number;
}

export interface FileSessionOptions {
  autoSave?: boolean;
  autoSaveDelayMs?: number;
}

export interface FileSession extends FileBuffer {
  resourceUri?:string;
  /** Provider revision used by interactive execution; editor version may be a catalog version. */
  sourceVersion?: number;
  path: string;
  /** null => the file does not exist yet (a write with if_version 0 creates it). */
  version: number | null;
  status: string | null;
  setStatus: (next: string | null) => void;
  editText: (next: string) => void;
  setData: (next: unknown) => void;
  applyOps: (ops: readonly PatchOp[]) => Promise<void>;
  save: () => Promise<void>;
  /** `skipIfDirty` is for the live-push path only: keep an unsaved buffer rather than
   *  clobbering it with what a bot just wrote. When 3-way merge is available, clean
   *  non-overlapping edits are seamlessly merged. */
  reload: (skipIfDirty?: boolean) => Promise<void>;

  // Collaborative real-time additions
  saving: boolean;
  autoSave: boolean;
  setAutoSave: (enabled: boolean) => void;
  conflictNotice: FileSessionConflict | null;
  resolveConflict: (choice: "local" | "remote" | "merged") => Promise<void>;
}

/** Execute a structured edit against exactly the version it was authored from.
 *
 * Patch paths may contain array indexes. After a concurrent insert, remove, or move,
 * replaying those indexes against a newer version can target a different object while
 * still succeeding. A conflict therefore stays a conflict: the session reloads the
 * fresh document and asks the person to repeat the intent against what is now visible. */
export async function patchWithVersionCheck(
  fs: FsClient,
  path: string,
  ops: readonly PatchOp[],
  version: number
): Promise<{ path: string; version: number }> {
  return fs.patch(path, ops, version);
}

