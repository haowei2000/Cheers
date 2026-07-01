import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
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

// The workspace (context_files) is a flat list of full paths; the backend has no real
// directory objects. We derive a folder TREE from the "/" in each path, so the panel
// behaves like a file browser (unlike the flat channel file list). A "folder" is any
// path prefix that has children (or an explicit is_dir row).
type TreeNode = { name: string; path: string; isDir: boolean; children: TreeNode[] };

function buildTree(entries: FsEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  // Return the children array of the dir at `path`, creating intermediate dirs.
  const dirChildren = (path: string): TreeNode[] => {
    if (path === "") return roots;
    const existing = dirs.get(path);
    if (existing) return existing.children;
    const parts = path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    const node: TreeNode = { name: parts[parts.length - 1], path, isDir: true, children: [] };
    dirs.set(path, node);
    dirChildren(parentPath).push(node);
    return node.children;
  };

  for (const e of entries) {
    if (e.is_dir) {
      dirChildren(e.path); // materialize an explicit (possibly empty) folder
      continue;
    }
    const parts = e.path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    dirChildren(parentPath).push({
      name: parts[parts.length - 1],
      path: e.path,
      isDir: false,
      children: [],
    });
  }

  const sort = (nodes: TreeNode[]) => {
    // folders first, then files, each alphabetical
    nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    nodes.forEach((n) => n.isDir && sort(n.children));
  };
  sort(roots);
  return roots;
}

// The File plugin: browse the channel workspace (context_files) as a folder tree, and
// open a file with a chosen RENDERER (default "原文" = raw textarea; or a built-in lens /
// installed renderer plugin). The renderer choice is a per-file binding (path -> renderer
// id) persisted in .workbench.json. Raw content is rendered ONLY inside a <textarea>
// (inert text — no HTML execution), so stored content cannot XSS co-channel users.
function FilePanel({ ctx }: { ctx: PanelContext }) {
  const { fs, plugins, bindings, setBinding, views, toggleView, pinned, togglePin } = ctx;
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Folder tree UI state. `collapsed` holds folder paths the user has folded shut
  // (default is expanded). `creatingIn` = the folder prefix a new file is being typed
  // into ("" = root, null = not creating). `confirmDel` = the path armed for delete.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);

  // The selected file's content/edit/save (optimistic lock + conflict reload) is the shared
  // useFileEditor hook; FilePanel only adds the browser (tree / create / delete / pick).
  const editor = useFileEditor(fs, selected ?? "");

  const refresh = useCallback(async () => {
    try {
      const res = await fs.ls("");
      setEntries(res.entries);
    } catch (e) {
      setStatus(errMsg(e));
    }
  }, [fs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const expandAncestors = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next.delete(acc);
      }
      return next;
    });
  }, []);

  // Deep-link: auto-select a file the user clicked elsewhere (e.g. a Desk ref in a
  // bot reply), expanding its folders so it's visible.
  useEffect(() => {
    if (ctx.openTarget) {
      setSelected(ctx.openTarget);
      expandAncestors(ctx.openTarget);
    }
  }, [ctx.openTarget, expandAncestors]);

  const toggleCollapse = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onSave = useCallback(async () => {
    await editor.save();
    void refresh(); // size/quota may have changed; keep the list fresh
  }, [editor, refresh]);

  // Inline create replaces window.prompt (which throws in embedded browsers). `parent`
  // is the folder prefix the file lands in; nested paths auto-create their folders.
  const beginCreate = (parent: string) => {
    setCreatingIn(parent);
    setNewName("");
  };

  const submitCreate = useCallback(async () => {
    const name = newName.trim();
    const parent = creatingIn ?? "";
    if (!name) {
      setCreatingIn(null);
      return;
    }
    const path = parent ? `${parent}/${name}` : name;
    setStatus(null);
    try {
      await fs.write(path, "", 0); // create-only
      setCreatingIn(null);
      setNewName("");
      expandAncestors(path);
      await refresh();
      setSelected(path); // hook loads it
    } catch (e) {
      setStatus(errMsg(e));
    }
  }, [creatingIn, newName, fs, refresh, expandAncestors]);

  // Inline delete confirm replaces window.confirm. `recursive` deletes a whole folder
  // subtree (server gates rm to owner/admin on the user path).
  const doDelete = useCallback(
    async (path: string, recursive: boolean) => {
      setStatus(null);
      setConfirmDel(null);
      try {
        await fs.rm(path, recursive);
        if (selected && (selected === path || selected.startsWith(`${path}/`))) setSelected(null);
        await refresh();
      } catch (e) {
        // PERMISSION_DENIED here = needs admin/owner (server-gated destructive op).
        setStatus(errMsg(e));
      }
    },
    [fs, refresh, selected]
  );

  const createInput = (depth: number) => (
    <div className="flex items-center gap-1.5 px-2 py-1" style={{ paddingLeft: depth * 12 + 8 }}>
      <FileText className="w-3.5 h-3.5 flex-shrink-0 text-zinc-600" />
      <input
        autoFocus
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submitCreate();
          } else if (e.key === "Escape") {
            setCreatingIn(null);
          }
        }}
        onBlur={() => {
          if (!newName.trim()) setCreatingIn(null);
        }}
        placeholder={creatingIn ? "文件名" : "路径，如 notes/todo.md"}
        className="flex-1 bg-zinc-800 text-zinc-200 text-xs rounded px-1 py-0.5 outline-none"
      />
    </div>
  );

  const deleteControl = (path: string, recursive: boolean) =>
    confirmDel === path ? (
      <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          title={recursive ? "确认删除整个文件夹" : "确认删除"}
          onClick={() => void doDelete(path, recursive)}
        >
          <Check className="w-3 h-3 text-red-400" />
        </button>
        <button title="取消" onClick={() => setConfirmDel(null)}>
          <X className="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
        </button>
      </span>
    ) : (
      <button
        title={recursive ? "删除文件夹" : "删除"}
        onClick={(ev) => {
          ev.stopPropagation();
          setConfirmDel(path);
        }}
        className="opacity-0 group-hover:opacity-100"
      >
        <Trash2 className="w-3 h-3 text-zinc-600 hover:text-red-400" />
      </button>
    );

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const pad = { paddingLeft: depth * 12 + 8 };
      if (node.isDir) {
        const isCollapsed = collapsed.has(node.path);
        return (
          <div key={`d:${node.path}`}>
            <div
              onClick={() => toggleCollapse(node.path)}
              style={pad}
              className="group flex items-center gap-1 pr-2 py-1 cursor-pointer hover:bg-zinc-800/60 text-zinc-300"
            >
              {isCollapsed ? (
                <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-500" />
              ) : (
                <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-500" />
              )}
              <Folder className="w-3.5 h-3.5 flex-shrink-0 text-sky-500/70" />
              <span className="truncate flex-1">{node.name}</span>
              <button
                title="在此文件夹新建文件"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (isCollapsed) toggleCollapse(node.path);
                  beginCreate(node.path);
                }}
                className="opacity-0 group-hover:opacity-100"
              >
                <Plus className="w-3 h-3 text-zinc-500 hover:text-zinc-200" />
              </button>
              {deleteControl(node.path, true)}
            </div>
            {!isCollapsed && (
              <>
                {renderNodes(node.children, depth + 1)}
                {creatingIn === node.path && createInput(depth + 1)}
              </>
            )}
          </div>
        );
      }
      return (
        <div
          key={`f:${node.path}`}
          onClick={() => setSelected(node.path)}
          style={pad}
          className={`group flex items-center gap-1.5 pr-2 py-1 cursor-pointer hover:bg-zinc-800/60 ${
            selected === node.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
          }`}
        >
          <FileText className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
          <span className="truncate flex-1">{node.name}</span>
          {deleteControl(node.path, false)}
        </div>
      );
    });

  return (
    <div className="flex h-full text-sm">
      {/* file tree */}
      <div className="w-52 flex-shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="flex items-center gap-1 px-2 h-8 border-b border-zinc-800 flex-shrink-0">
          <button
            onClick={() => beginCreate("")}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
          <div className="flex-1" />
          <button onClick={() => void refresh()} title="Refresh">
            <RefreshCw className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300" />
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {creatingIn === "" && createInput(0)}
          {tree.length === 0 && creatingIn === null && (
            <div className="px-2 py-3 text-xs text-zinc-600">No files</div>
          )}
          {renderNodes(tree, 0)}
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
