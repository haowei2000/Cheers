import { useCallback, useEffect, useRef, useState } from "react";
import { parse as yamlParse } from "yaml";
import { ResourceError } from "../hooks/useChatRealtime";
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
   *  clobbering it with what a bot just wrote. */
  reload: (skipIfDirty?: boolean) => Promise<void>;
}

export function useFileSession(fs: FsClient, path: string): FileSession {
  const [buffer, setBuffer] = useState<FileBuffer>(() => emptyBuffer(path));
  const [version, setVersion] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Mirror readable synchronously from async callbacks, which cannot see a state update
  // made after they closed over it: an in-flight `fs.read` may resolve after a keystroke,
  // and would otherwise clobber it.
  const bufferRef = useRef(buffer);
  const write = useCallback((next: FileBuffer) => {
    bufferRef.current = next;
    setBuffer(next);
  }, []);

  // Path switch, applied during THIS render rather than in an effect: both views read
  // this one buffer, so a frame of the previous file's content would be a frame of the
  // wrong file rendered by the new file's renderer.
  const [openPath, setOpenPath] = useState(path);
  if (openPath !== path) {
    setOpenPath(path);
    bufferRef.current = emptyBuffer(path);
    setBuffer(bufferRef.current);
    setVersion(null);
    setStatus(null);
  }

  const load = useCallback(
    async (skipIfDirty = false) => {
      if (!path) return;
      try {
        const f = await fs.read(path);
        if (skipIfDirty && bufferRef.current.dirty) return;
        write(adoptText(path, bufferRef.current, f.content));
        setVersion(f.version);
      } catch (e) {
        if (e instanceof ResourceError && e.code === "NOT_FOUND") {
          if (skipIfDirty && bufferRef.current.dirty) return;
          write(adoptText(path, bufferRef.current, ""));
          setVersion(null);
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

  const onEditText = useCallback(
    (next: string) => write(editText(path, bufferRef.current, next)),
    [path, write]
  );

  const setData = useCallback(
    (next: unknown) => {
      if (!canEditData(bufferRef.current)) {
        setStatus("Fix the syntax error in Raw before editing the preview");
        return;
      }
      try {
        write(editData(path, bufferRef.current, next));
      } catch (e) {
        // Serializing can fail against the text it has to patch — a YAML document whose
        // root is a scalar cannot take a key, for instance. Reported, not thrown: this
        // runs inside a lens's event handler, where an exception becomes a rejected
        // promise nobody is awaiting and the user sees nothing happen at all.
        setStatus(errMsg(e));
      }
    },
    [path, write]
  );

  const save = useCallback(async () => {
    if (!path) return;
    setStatus(null);
    try {
      const r = await fs.write(path, bufferRef.current.text, version ?? 0);
      write({ ...bufferRef.current, dirty: false });
      setVersion(r.version);
      setStatus("Saved");
    } catch (e) {
      if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") {
        setStatus("Conflict — reloaded the latest version; please reapply your changes");
        await load();
      } else {
        setStatus(errMsg(e));
      }
    }
  }, [fs, path, version, load, write]);

  // Structured edit, for callers that know WHICH part changed (a canvas node moving, a
  // row being inserted). Distinct from `save` in two ways that matter: it preserves YAML
  // comments through an array length change, which the whole-document path documents as
  // a loss; and a VERSION_CONFLICT is recoverable, because the ops are still meaningful
  // against the newer document and can be replayed once — a stale document cannot.
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
        // Optimistic, so the gesture moves now. Inside the try because a batch can be
        // invalid against THIS document (an index out of range, a key op on a document
        // with no root object) — that has to surface as a status, not escape as a
        // rejected promise no caller is awaiting.
        write(patchData(bufferRef.current, ops));
        try {
          await fs.patch(path, ops, version);
        } catch (e) {
          if (!(e instanceof ResourceError && e.code === "VERSION_CONFLICT")) throw e;
          const fresh = await fs.read(path);
          await fs.patch(path, ops, fresh.version);
        }
        setStatus("Saved");
      } catch (e) {
        setStatus(errMsg(e));
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
  };
}
