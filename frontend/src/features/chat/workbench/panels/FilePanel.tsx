import { useCallback, useEffect, useState } from "react";
import { Download, FileText, FolderOpen, RefreshCw, Save, Trash2 } from "lucide-react";
import { registerPanel, type PanelContext } from "../panelRegistry";
import type { FsEntry } from "../fsClient";
import { errMsg, useFileEditor } from "../jsonFile";
import { PinToggle } from "../PinToggle";
import { candidatesFor, getRenderer } from "../renderers/registry";
import { RendererHost } from "../renderers/RendererHost";

// Export bridge: a context file is TEXT, so "download" = save its content as a blob
// client-side (filename = the path's basename). No backend round-trip needed.
function downloadText(path: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || path;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// The File plugin: browse the channel workspace (context_files), and open a file with
// a chosen RENDERER (default "原文" = raw textarea; or a built-in lens / installed
// renderer plugin). The renderer choice is a per-file binding (path -> renderer id)
// persisted in .workbench.json. Raw content is rendered ONLY inside a <textarea>
// (inert text — no HTML execution), so stored content cannot XSS co-channel users.
function FilePanel({ ctx }: { ctx: PanelContext }) {
  const { fs, plugins, bindings, setBinding, views, toggleView, pinned, togglePin } = ctx;
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // The selected file's content/edit/save (optimistic lock + conflict reload) is the shared
  // useFileEditor hook; FilePanel only adds the browser (list / create / delete / pick).
  const editor = useFileEditor(fs, selected ?? "");

  const refresh = useCallback(async () => {
    try {
      const res = await fs.ls("");
      setEntries(res.entries.filter((e) => !e.is_dir));
    } catch (e) {
      setStatus(errMsg(e));
    }
  }, [fs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Deep-link: auto-select a file the user clicked elsewhere (e.g. a Desk ref in a
  // bot reply). Fires whenever the target path changes.
  useEffect(() => {
    if (ctx.openTarget) setSelected(ctx.openTarget);
  }, [ctx.openTarget]);

  const onSave = useCallback(async () => {
    await editor.save();
    void refresh(); // size/quota may have changed; keep the list fresh
  }, [editor, refresh]);

  const create = useCallback(async () => {
    const path = window.prompt("New file path (e.g. notes/todo.md)");
    if (!path) return;
    setStatus(null);
    try {
      await fs.write(path, "", 0); // create-only
      await refresh();
      setSelected(path); // hook loads it
    } catch (e) {
      setStatus(errMsg(e));
    }
  }, [fs, refresh]);

  const remove = useCallback(
    async (path: string) => {
      if (!window.confirm(`Delete ${path}?`)) return;
      setStatus(null);
      try {
        await fs.rm(path);
        if (selected === path) setSelected(null);
        await refresh();
      } catch (e) {
        // PERMISSION_DENIED here = needs admin/owner (server-gated destructive op).
        setStatus(errMsg(e));
      }
    },
    [fs, refresh, selected]
  );

  return (
    <div className="flex h-full text-sm">
      {/* file list */}
      <div className="w-44 flex-shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="flex items-center gap-1 px-2 h-8 border-b border-zinc-800 flex-shrink-0">
          <button
            onClick={() => void create()}
            className="text-xs text-zinc-400 hover:text-zinc-100"
          >
            + New
          </button>
          <div className="flex-1" />
          <button onClick={() => void refresh()} title="Refresh">
            <RefreshCw className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300" />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {entries.length === 0 && (
            <div className="px-2 py-3 text-xs text-zinc-600">No files</div>
          )}
          {entries.map((e) => (
            <div
              key={e.path}
              onClick={() => setSelected(e.path)}
              className={`group flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-zinc-800/60 ${
                selected === e.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
              }`}
            >
              <FileText className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
              <span className="truncate flex-1">{e.path}</span>
              <button
                onClick={(ev) => {
                  ev.stopPropagation();
                  void remove(e.path);
                }}
                title="Delete"
                className="opacity-0 group-hover:opacity-100"
              >
                <Trash2 className="w-3 h-3 text-zinc-600 hover:text-red-400" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected === null ? (
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-xs gap-2">
            <FolderOpen className="w-4 h-4" /> Select a file
          </div>
        ) : (
          (() => {
            // content-aware: only renderers that ACCEPT this file's content are offered
            const candidates = candidatesFor(selected, editor.content, plugins);
            const boundId = bindings[selected];
            const renderer = boundId ? getRenderer(boundId, plugins) : undefined;
            return (
              <>
                <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
                  <span className="text-xs text-zinc-300 truncate">{selected}</span>
                  {!renderer && editor.dirty && <span className="text-[10px] text-amber-500">●</span>}
                  <div className="flex-1" />
                  {/* renderer picker: default 原文 (raw textarea), or a lens / plugin renderer */}
                  <select
                    value={boundId ?? ""}
                    onChange={(e) => setBinding(selected, e.target.value || null)}
                    title="用哪个渲染器打开此文件（默认：原文）"
                    className="bg-zinc-800 text-zinc-300 text-[11px] rounded px-1 py-0.5 outline-none max-w-[120px]"
                  >
                    <option value="">原文</option>
                    {/* most-specific first; plugin source shown so same-named ones differ */}
                    {candidates.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                        {r.source === "plugin" ? ` · ${r.pluginId}` : ""}
                      </option>
                    ))}
                  </select>
                  {/* export bridge: download this context file as a real file */}
                  <button
                    onClick={() => downloadText(selected, editor.content)}
                    title="下载此文件（导出为文件）"
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  {/* pin this file's content into every bot prompt (toggle) */}
                  <PinToggle path={selected} pinned={pinned} togglePin={togglePin} />
                  {/* surface this file as a workbench tab (toggle), persisted in views */}
                  <button
                    onClick={() => toggleView(selected)}
                    title={views.some((v) => v.path === selected) ? "从顶部 tab 移除" : "把此文件设为顶部 tab"}
                    className={`text-xs ${
                      views.some((v) => v.path === selected)
                        ? "text-amber-400"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {views.some((v) => v.path === selected) ? "✓ Tab" : "设为 Tab"}
                  </button>
                  {!renderer && (
                    <button
                      onClick={() => void onSave()}
                      disabled={!editor.dirty}
                      className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
                    >
                      <Save className="w-3.5 h-3.5" /> Save
                    </button>
                  )}
                </div>
                {renderer ? (
                  // the chosen renderer owns load/edit/save for this one file
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <RendererHost ctx={ctx} path={selected} renderer={renderer} />
                  </div>
                ) : (
                  // textarea = inert text rendering; never dangerouslySetInnerHTML
                  <textarea
                    value={editor.content}
                    onChange={(e) => editor.edit(e.target.value)}
                    spellCheck={false}
                    className="flex-1 resize-none bg-zinc-950 text-zinc-200 font-mono text-xs p-3 outline-none"
                  />
                )}
              </>
            );
          })()
        )}
        {(editor.status || status) && (
          <div className="px-3 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 flex-shrink-0">
            {editor.status || status}
          </div>
        )}
      </div>
    </div>
  );
}

registerPanel({
  id: "files",
  title: "Files",
  render: (ctx) => <FilePanel ctx={ctx} />,
});

export default FilePanel;
