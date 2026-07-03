import { Save } from "lucide-react";
import type { PanelContext, PanelDef } from "../panelRegistry";
import type { FsClient } from "../fsClient";
import { useFileEditor } from "../jsonFile";
import { RendererHost } from "./RendererHost";
import { getRenderer } from "./registry";

// Raw text view for a single file — the safe default when a tab's file has no renderer
// binding (mirrors the File panel's "Raw" mode). Content is rendered inert in a <textarea>.
function RawFileView({ fs, path }: { fs: FsClient; path: string }) {
  const { content, edit, dirty, status, save } = useFileEditor(fs, path);

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
          <Save className="w-3.5 h-3.5" /> Save
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => edit(e.target.value)}
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

// A workbench tab declared in .workbench.json `views`: render the file with the view's
// renderer (a template migrates its lens+config here) — or, failing that, the file's
// binding; if neither, fall back to raw text. The tab layout is per-channel workbench
// config — the file itself stays pure content.
export function viewToTab(view: {
  path: string;
  title?: string;
  renderer?: string;
  config?: unknown;
}): PanelDef {
  return {
    id: `view:${view.path}`,
    title: view.title || view.path.split("/").pop() || view.path,
    render: (ctx: PanelContext) => {
      const rid = view.renderer ?? ctx.bindings[view.path];
      const renderer = rid ? getRenderer(rid, ctx.plugins) : undefined;
      return renderer ? (
        <RendererHost ctx={ctx} path={view.path} renderer={renderer} config={view.config} />
      ) : (
        <RawFileView fs={ctx.fs} path={view.path} />
      );
    },
  };
}
