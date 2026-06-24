import { useCallback, useEffect, useState } from "react";
import { ResourceError } from "../hooks/useChatRealtime";
import type { FsClient } from "./fsClient";

export function errMsg(e: unknown): string {
  if (e instanceof ResourceError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : "error";
}

// ── Format layer: string <-> data, chosen by file extension ──────────────────
// JSON for structured boards, plain text for Markdown / prompts. (YAML can be
// added as another Format later; XML intentionally unsupported.)
interface Format {
  parse: (s: string) => unknown;
  serialize: (d: unknown) => string;
}
const JSON_FMT: Format = {
  parse: (s) => (s.trim() ? JSON.parse(s) : null),
  serialize: (d) => JSON.stringify(d, null, 2),
};
const TEXT_FMT: Format = {
  parse: (s) => s,
  serialize: (d) => (typeof d === "string" ? d : String(d)),
};
export function formatFor(path: string): Format {
  return path.endsWith(".json") ? JSON_FMT : TEXT_FMT;
}

// Generic file-backed state: load a workspace file (parsed by its format), edit in
// memory, save back under the server's optimistic lock (re-read on conflict).
// `version === null` => file doesn't exist yet (write with if_version=0 creates it).
export function useFile<T>(fs: FsClient, path: string, fallback: T) {
  const fmt = formatFor(path);
  const [data, setData] = useState<T>(fallback);
  const [version, setVersion] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const f = await fs.read(path);
      setData(fmt.parse(f.content) as T);
      setVersion(f.version);
    } catch (e) {
      if (e instanceof ResourceError && e.code === "NOT_FOUND") {
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
        const r = await fs.write(path, fmt.serialize(next), version ?? 0);
        setData(next);
        setVersion(r.version);
        setStatus("已保存");
      } catch (e) {
        if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") {
          setStatus("有冲突，已重载最新——请重新应用你的改动");
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

  const load = useCallback(async () => {
    if (!path) return;
    setStatus(null);
    try {
      const f = await fs.read(path);
      setContent(f.content);
      setVersion(f.version);
      setDirty(false);
    } catch (e) {
      if (e instanceof ResourceError && e.code === "NOT_FOUND") {
        setContent("");
        setVersion(null);
        setDirty(false);
      } else {
        setStatus(errMsg(e));
      }
    }
  }, [fs, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = useCallback((next: string) => {
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
      setStatus("已保存");
    } catch (e) {
      if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") {
        setStatus("有冲突，已重载——请重做改动");
        await load();
      } else {
        setStatus(errMsg(e));
      }
    }
  }, [fs, path, content, version, load]);

  return { content, edit, dirty, status, setStatus, save, reload: load };
}
