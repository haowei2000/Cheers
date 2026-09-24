import { useCallback, useEffect, useRef, useState } from "react";
import { parse as yamlParse } from "yaml";
import { ResourceError } from "../hooks/useChatRealtime";
import type { FsClient } from "./fsClient";
import { applyEdits } from "./yamlDoc";
import { applyPatchOps, type PatchOp } from "./patchOps";
import { merge3Way } from "./collab";

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

export function useFileSession(
  fs: FsClient,
  path: string,
  options?: FileSessionOptions
): FileSession {
  const [buffer, setBuffer] = useState<FileBuffer>(() => emptyBuffer(path));
  const [version, setVersion] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(options?.autoSave ?? true);
  const [conflictNotice, setConflictNotice] = useState<FileSessionConflict | null>(null);

  // Server baseline for 3-way merge
  const baseTextRef = useRef("");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delayMs = options?.autoSaveDelayMs ?? 800;

  // Mirror readable synchronously from async callbacks
  const bufferRef = useRef(buffer);
  const versionRef = useRef(version);
  versionRef.current = version;

  const write = useCallback((next: FileBuffer) => {
    bufferRef.current = next;
    setBuffer(next);
  }, []);

  // Path switch, applied during THIS render rather than in an effect
  const [openPath, setOpenPath] = useState(path);
  if (openPath !== path) {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    setOpenPath(path);
    bufferRef.current = emptyBuffer(path);
    setBuffer(bufferRef.current);
    baseTextRef.current = "";
    setVersion(null);
    setStatus(null);
    setConflictNotice(null);
  }

  const load = useCallback(
    async (skipIfDirty = false) => {
      if (!path) return;
      try {
        const f = await fs.read(path);
        if (skipIfDirty && bufferRef.current.dirty) {
          // Collaborative 3-way merge attempt
          const base = baseTextRef.current;
          const local = bufferRef.current.text;
          const remote = f.content;
          const res = merge3Way(base, local, remote);

          if (!res.hasConflict) {
            // Clean non-overlapping merge!
            write(adoptText(path, bufferRef.current, res.merged));
            baseTextRef.current = remote;
            setVersion(f.version);
            setStatus("Synced with collaborator");
            setConflictNotice(null);
          } else {
            // Overlapping concurrent edit
            setConflictNotice({
              remoteText: remote,
              localText: local,
              baseText: base,
              conflictsCount: res.conflictsCount,
            });
            setStatus("Collaborator edited this file — conflict detected");
          }
          return;
        }

        write(adoptText(path, bufferRef.current, f.content));
        baseTextRef.current = f.content;
        setVersion(f.version);
        setConflictNotice(null);
      } catch (e) {
        if (e instanceof ResourceError && e.code === "NOT_FOUND") {
          if (skipIfDirty && bufferRef.current.dirty) return;
          write(adoptText(path, bufferRef.current, ""));
          baseTextRef.current = "";
          setVersion(null);
          setConflictNotice(null);
        } else {
          setStatus(errMsg(e));
        }
      }
    },
    [fs, path, write]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Clean up autoSave timer on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, []);

  const save = useCallback(async () => {
    if (!path) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    setSaving(true);
    setStatus(null);
    try {
      const currentText = bufferRef.current.text;
      const r = await fs.write(path, currentText, versionRef.current ?? 0);
      write({ ...bufferRef.current, dirty: false });
      baseTextRef.current = currentText;
      setVersion(r.version);
      setConflictNotice(null);
      setStatus("Saved");
    } catch (e) {
      if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") {
        // Attempt automatic 3-way merge on write conflict
        try {
          const latest = await fs.read(path);
          const res = merge3Way(baseTextRef.current, bufferRef.current.text, latest.content);
          if (!res.hasConflict) {
            const retryWrite = await fs.write(path, res.merged, latest.version);
            write({ ...adoptText(path, bufferRef.current, res.merged), dirty: false });
            baseTextRef.current = res.merged;
            setVersion(retryWrite.version);
            setConflictNotice(null);
            setStatus("Auto-merged & saved");
            return;
          }
          setConflictNotice({
            remoteText: latest.content,
            localText: bufferRef.current.text,
            baseText: baseTextRef.current,
            conflictsCount: res.conflictsCount,
          });
          setStatus("Conflict — remote changes conflict with local edits");
        } catch {
          setStatus("Conflict — reloaded the latest version; please reapply your changes");
          await load();
        }
      } else {
        setStatus(errMsg(e));
      }
    } finally {
      setSaving(false);
    }
  }, [fs, path, load, write]);

  const scheduleAutoSave = useCallback(() => {
    if (!autoSaveEnabled) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      void save();
    }, delayMs);
  }, [autoSaveEnabled, delayMs, save]);

  const onEditText = useCallback(
    (next: string) => {
      write(editText(path, bufferRef.current, next));
      scheduleAutoSave();
    },
    [path, write, scheduleAutoSave]
  );

  const setData = useCallback(
    (next: unknown) => {
      if (!canEditData(bufferRef.current)) {
        setStatus("Fix the syntax error in Raw before editing the preview");
        return;
      }
      try {
        write(editData(path, bufferRef.current, next));
        scheduleAutoSave();
      } catch (e) {
        setStatus(errMsg(e));
      }
    },
    [path, write, scheduleAutoSave]
  );

  const resolveConflict = useCallback(
    async (choice: "local" | "remote" | "merged") => {
      if (!conflictNotice || !path) return;
      if (choice === "remote") {
        write(adoptText(path, bufferRef.current, conflictNotice.remoteText));
        baseTextRef.current = conflictNotice.remoteText;
        setConflictNotice(null);
        setStatus("Adopted remote changes");
        await load();
      } else if (choice === "local") {
        try {
          const latest = await fs.read(path);
          const r = await fs.write(path, conflictNotice.localText, latest.version);
          write({ ...bufferRef.current, dirty: false });
          baseTextRef.current = conflictNotice.localText;
          setVersion(r.version);
          setConflictNotice(null);
          setStatus("Preserved local changes");
        } catch (e) {
          setStatus(errMsg(e));
        }
      } else if (choice === "merged") {
        const res = merge3Way(conflictNotice.baseText, conflictNotice.localText, conflictNotice.remoteText);
        write(editText(path, bufferRef.current, res.merged));
        setConflictNotice(null);
        setStatus("Conflict markers inserted; please resolve in Raw editor");
      }
    },
    [conflictNotice, path, write, load, fs]
  );

  // Structured edit
  const applyOps = useCallback(
    async (ops: readonly PatchOp[]) => {
      if (ops.length === 0) return;
      if (version === null) {
        setStatus("Cannot patch a file that does not exist yet");
        return;
      }
      if (!canPatch(bufferRef.current)) {
        setStatus(
          bufferRef.current.parseError
            ? "Fix the syntax error in Raw first"
            : "Save or revert the unsaved text first"
        );
        return;
      }
      setStatus(null);
      try {
        write(patchData(bufferRef.current, ops));
        await patchWithVersionCheck(fs, path, ops, version);
        setStatus("Saved");
      } catch (e) {
        setStatus(
          e instanceof ResourceError && e.code === "VERSION_CONFLICT"
            ? "Conflict — reloaded the latest version; please repeat your change"
            : errMsg(e)
        );
      } finally {
        await load();
      }
    },
    [fs, path, version, load, write]
  );

  return {
    ...buffer,
    path,
    version,
    status,
    setStatus,
    editText: onEditText,
    setData,
    applyOps,
    save,
    reload: load,
    saving,
    autoSave: autoSaveEnabled,
    setAutoSave: setAutoSaveEnabled,
    conflictNotice,
    resolveConflict,
  };
}
