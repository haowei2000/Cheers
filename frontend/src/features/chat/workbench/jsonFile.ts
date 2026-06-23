import { useCallback, useEffect, useState } from "react";
import { ResourceError } from "../hooks/useChatRealtime";
import type { FsClient } from "./fsClient";

export function errMsg(e: unknown): string {
  if (e instanceof ResourceError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : "error";
}

// Shared board-panel plumbing: load a JSON file from the channel workspace, edit
// in memory, save back with the server's optimistic lock (re-read on conflict).
// `version === null` means the file doesn't exist yet (write with if_version=0 to create).
export function useJsonFile<T>(fs: FsClient, path: string, fallback: T) {
  const [data, setData] = useState<T>(fallback);
  const [version, setVersion] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const f = await fs.read(path);
      setData(JSON.parse(f.content) as T);
      setVersion(f.version);
    } catch (e) {
      if (e instanceof ResourceError && e.code === "NOT_FOUND") {
        setVersion(null);
        setData(fallback);
      } else {
        setStatus(errMsg(e));
      }
    }
    // fallback is intentionally not a dep — it's a constant default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: T) => {
      setStatus(null);
      try {
        const r = await fs.write(path, JSON.stringify(next, null, 2), version ?? 0);
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
    [fs, path, version, load]
  );

  return { data, setData, save, status, version, reload: load };
}
