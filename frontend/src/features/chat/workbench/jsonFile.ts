import { useCallback, useEffect, useRef, useState } from "react";
import { parse as yamlParse } from "yaml";
import { ResourceError } from "../hooks/useChatRealtime";
import type { FsClient } from "./fsClient";
import { applyEdits } from "./yamlDoc";

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

// Generic file-backed state: load a workspace file (parsed by its format), edit in
// memory, save back under the server's optimistic lock (re-read on conflict).
// `version === null` => file doesn't exist yet (write with if_version=0 creates it).
export function useFile<T>(fs: FsClient, path: string, fallback: T) {
  const fmt = formatFor(path);
  const [data, setData] = useState<T>(fallback);
  const [version, setVersion] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Last text loaded from / written to the server — the serialize round-trip context
  // (YAML patches this text to keep comments; JSON/TEXT ignore it).
  const rawRef = useRef<string>("");

  const load = useCallback(async () => {
    try {
      const f = await fs.read(path);
      rawRef.current = f.content;
      setData(fmt.parse(f.content) as T);
      setVersion(f.version);
    } catch (e) {
      if (e instanceof ResourceError && e.code === "NOT_FOUND") {
        rawRef.current = "";
        setVersion(null);
        setData(fallback);
      } else {
        setStatus(errMsg(e));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: T) => {
      setStatus(null);
      try {
        const body = fmt.serialize(next, rawRef.current);
        const r = await fs.write(path, body, version ?? 0);
        rawRef.current = body;
        setData(next);
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fs, path, version, load]
  );

  return { data, setData, save, status, version, reload: load };
}

// Back-compat alias for imperative panels that hand-roll JSON state.
export const useJsonFile = useFile;

// Raw-TEXT file editor state (no format parsing): load a file as a string, edit, save under
// the server's optimistic lock (re-read on conflict). Shared by the File panel and the raw
// view-tab fallback. An empty `path` is inert (nothing to load). `dirty` tracks unsaved edits.
export function useFileEditor(fs: FsClient, path: string) {
  const [content, setContent] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Mirror of `dirty` readable synchronously inside async callbacks: a live-push reload
  // (fs.read) may be in flight when the user types, and the stale `dirty` closed over by
  // `load` would otherwise let the resolved read clobber the just-typed keystroke.
  const dirtyRef = useRef(false);

  // Path switch: blank the buffer synchronously so consumers never see the PREVIOUS
  // file's content under the new selection (renderer matching, raw view) while the
  // async load below is still in flight.
  useEffect(() => {
    setContent("");
    setVersion(null);
    setDirty(false);
    dirtyRef.current = false;
  }, [path]);

  // `skipIfDirty` is set only by the live-push `reload` path: if the user typed while the
  // fs.read was in flight, keep their unsaved buffer instead of clobbering it. The mount
  // load and the conflict-recovery reload pass it false — they intentionally overwrite the
  // buffer with the server's latest.
  const load = useCallback(
    async (skipIfDirty = false) => {
      if (!path) return;
      setStatus(null);
      try {
        const f = await fs.read(path);
        if (skipIfDirty && dirtyRef.current) return;
        setContent(f.content);
        setVersion(f.version);
        setDirty(false);
        dirtyRef.current = false;
      } catch (e) {
        if (e instanceof ResourceError && e.code === "NOT_FOUND") {
          if (skipIfDirty && dirtyRef.current) return;
          setContent("");
          setVersion(null);
          setDirty(false);
          dirtyRef.current = false;
        } else {
          setStatus(errMsg(e));
        }
      }
    },
    [fs, path]
  );
  // Live-push reload (Desk files tick): must not overwrite an in-progress edit.
  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = useCallback((next: string) => {
    dirtyRef.current = true;
    setContent(next);
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!path) return;
    setStatus(null);
    try {
      const r = await fs.write(path, content, version ?? 0);
      setVersion(r.version);
      setDirty(false);
      dirtyRef.current = false;
      setStatus("Saved");
    } catch (e) {
      if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") {
        setStatus("Conflict — reloaded; please redo your changes");
        await load();
      } else {
        setStatus(errMsg(e));
      }
    }
  }, [fs, path, content, version, load]);

  return { content, edit, dirty, status, setStatus, save, reload };
}
