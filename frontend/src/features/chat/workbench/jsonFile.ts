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
