import { useCallback, useEffect, useState } from "react";
import { Save } from "lucide-react";
import { ResourceError } from "../../hooks/useChatRealtime";
import type { PanelContext, PanelDef } from "../panelRegistry";
import type { FsClient } from "../fsClient";
import { RendererHost } from "./RendererHost";
import { getRenderer } from "./registry";

function errMsg(e: unknown): string {
  if (e instanceof ResourceError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : "error";
}

// Raw text view for a single file — the safe default when a tab's file has no renderer
// binding (mirrors the File panel's "原文" mode). Always treats content as text (no
// format parsing), rendered inert in a <textarea>.
function RawFileView({ fs, path }: { fs: FsClient; path: string }) {
  const [content, setContent] = useState("");
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const f = await fs.read(path);
      setContent(f.content);
      setVersion(f.version);
      setDirty(false);
    } catch (e) {
      if (!(e instanceof ResourceError && e.code === "NOT_FOUND")) setStatus(errMsg(e));
    }
  }, [fs, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    try {
      const r = await fs.write(path, content, version);
      setVersion(r.version);
      setDirty(false);
      setStatus("已保存");
    } catch (e) {
      if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") {
        setStatus("有冲突，已重载——请重做改动");
        await load();
      } else setStatus(errMsg(e));
    }
  }, [fs, path, content, version, load]);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
        <span className="text-zinc-600 text-[10px] truncate">{path}</span>
        <div className="flex-1" />
        <button
          onClick={() => void save()}
          disabled={!dirty}
          className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
        >
          <Save className="w-3.5 h-3.5" /> 保存
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        spellCheck={false}
        className="flex-1 resize-none bg-zinc-950 text-zinc-200 font-mono text-xs p-3 outline-none"
      />
      {status && (
        <div className="px-3 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 flex-shrink-0">
          {status}
        </div>
      )}
    </div>
  );
}

// A workbench tab declared in .workbench.json `views`: render the file with its bound
// renderer; if unbound, fall back to the raw text view. The tab layout is per-channel
// workbench config — the file itself stays pure content.
export function viewToTab(view: { path: string; title?: string }): PanelDef {
  return {
    id: `view:${view.path}`,
    title: view.title || view.path.split("/").pop() || view.path,
    render: (ctx: PanelContext) => {
      const rid = ctx.bindings[view.path];
      const renderer = rid ? getRenderer(rid, ctx.plugins) : undefined;
      return renderer ? (
        <RendererHost ctx={ctx} path={view.path} renderer={renderer} />
      ) : (
        <RawFileView fs={ctx.fs} path={view.path} />
      );
    },
  };
}
