import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { WorkbenchContext } from "../context";
import type { FsEntry } from "../fsClient";
import { errMsg, useFileEditor } from "../jsonFile";
import { PinToggle } from "../PinToggle";
import { candidatesFor, getRenderer, type RendererDesc } from "../renderers/registry";
import { RendererHost } from "../renderers/RendererHost";

// Click-gated: the CodeMirror editor (its own chunk, incl. md/json language packs) only
// downloads when a user actually opens Raw mode — keeps it off the chat critical path, like
// the pdf/hljs viewers. Named export → default shim. Suspense falls back to a blank field.
const CodeEditor = lazy(() => import("../CodeEditor").then((m) => ({ default: m.CodeEditor })));

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

// The file browser IS the workbench body: browse the channel workspace (context_files)
// as a folder tree; a selected file has exactly three controls — PIN (inject into every
// bot prompt), PREVIEW (render with the bound or best content-matching renderer; a
// switcher appears when several match), RAW (plain <textarea> editor, also the fallback
// when nothing matches). Raw content is rendered ONLY inside a <textarea> (inert text —
// no HTML execution), so stored content cannot XSS co-channel users.
export function FilePanel({ ctx }: { ctx: WorkbenchContext }) {
  const { fs, plugins, bindings, setBinding, configs, pinned, togglePin } = ctx;
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // "auto" = preview when a renderer matches, raw otherwise; user toggle overrides
  // for the currently selected file (resets on selection change).
  const [mode, setMode] = useState<"auto" | "preview" | "raw">("auto");
  const [status, setStatus] = useState<string | null>(null);
  // Folder tree UI state. `collapsed` holds folder paths the user has folded shut
  // (default is expanded). `creatingIn` = the folder prefix a new file is being typed
  // into ("" = root, null = not creating). `confirmDel` = the path armed for delete.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // The tree column is collapsible so a preview (table/chart/kanban) can take the
  // drawer's full width — the price of tree-flanks-everything is otherwise ~40%.
  const [treeOpen, setTreeOpen] = useState(true);

  const tree = useMemo(() => buildTree(entries), [entries]);

  // The selected file's content/edit/save (optimistic lock + conflict reload) is the shared
  // useFileEditor hook; FilePanel only adds the browser (tree / create / delete / pick).
  const editor = useFileEditor(fs, selected ?? "");

  useEffect(() => setMode("auto"), [selected]);

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

  // Live-push: the Desk ("files" board) changed on the server (a bot finished writing).
  // Re-pull the tree and reload a clean open file in place, but NEVER clobber unsaved
  // edits — a dirty buffer only gets a non-destructive "changed on server" hint.
  const filesTick = ctx.filesTick ?? 0;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const seenFilesTick = useRef(filesTick);
  useEffect(() => {
    if (filesTick === seenFilesTick.current) return;
    seenFilesTick.current = filesTick;
    void refresh();
    if (!selected) return;
    const ed = editorRef.current;
    if (ed.dirty) ed.setStatus("⟳ 此文件已在服务器上更新(你有未保存改动,未自动覆盖)");
    else void ed.reload();
  }, [filesTick, refresh, selected]);

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
  // bot reply, or a just-activated scenario's first file), expanding its folders.
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
      <FileText className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
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
        placeholder={creatingIn ? "File name" : "Path, e.g. notes/todo.md"}
        className="flex-1 bg-zinc-800 text-zinc-200 text-xs rounded px-1 py-0.5 outline-none"
      />
    </div>
  );

  const deleteControl = (path: string, recursive: boolean) =>
    confirmDel === path ? (
      // Confirm sits LEFT (far from where the Trash2 target was, on the right edge)
      // and the pair is spaced gap-2 with padded hit areas, so a near-miss after
      // arming delete lands on Cancel, never on the irreversible Confirm.
      <span className="flex items-center gap-2">
        <button
          type="button"
          aria-label={recursive ? "Confirm: delete entire folder" : "Confirm delete"}
          title={recursive ? "Confirm: delete entire folder" : "Confirm delete"}
          onClick={() => void doDelete(path, recursive)}
          className="p-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Check className="w-3 h-3 text-red-400 hover:text-red-300" />
        </button>
        <button
          type="button"
          aria-label="Cancel delete"
          title="Cancel"
          onClick={() => setConfirmDel(null)}
          className="p-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <X className="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
        </button>
      </span>
    ) : (
      <button
        type="button"
        aria-label={recursive ? "Delete folder" : "Delete file"}
        title={recursive ? "Delete folder" : "Delete"}
        onClick={() => setConfirmDel(path)}
        className="p-1.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <Trash2 className="w-3 h-3 text-zinc-500 hover:text-red-400" />
      </button>
    );

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const pad = { paddingLeft: depth * 12 + 8 };
      if (node.isDir) {
        const isCollapsed = collapsed.has(node.path);
        return (
          <div key={`d:${node.path}`}>
            {/* Row is a real disclosure <button> (keyboard-operable, aria-expanded);
                the new-file/delete controls are sibling buttons, not nested, to keep
                interactives un-nested. */}
            <div
              style={pad}
              className="group flex items-center gap-1 pr-2 hover:bg-zinc-800/60 text-zinc-300"
            >
              <button
                type="button"
                onClick={() => toggleCollapse(node.path)}
                aria-expanded={!isCollapsed}
                className="flex-1 flex items-center gap-1 min-w-0 py-1 text-left cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-500" />
                ) : (
                  <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-500" />
                )}
                <Folder className="w-3.5 h-3.5 flex-shrink-0 text-indigo-400/70" />
                <span className="truncate flex-1">{node.name}</span>
              </button>
              <button
                type="button"
                aria-label="New file in this folder"
                title="New file in this folder"
                onClick={() => {
                  if (isCollapsed) toggleCollapse(node.path);
                  beginCreate(node.path);
                }}
                className="p-1.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
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
          style={pad}
          className={`group flex items-center gap-1.5 pr-2 hover:bg-zinc-800/60 ${
            selected === node.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
          }`}
        >
          <button
            type="button"
            onClick={() => setSelected(node.path)}
            aria-current={selected === node.path ? "true" : undefined}
            className="flex-1 flex items-center gap-1.5 min-w-0 py-1 text-left cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
          >
            <FileText className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
            <span className="truncate flex-1">{node.name}</span>
          </button>
          {deleteControl(node.path, false)}
        </div>
      );
    });

  return (
    <div className="flex h-full text-sm">
      {/* file tree (collapsible — previews get the full drawer width when hidden) */}
      {treeOpen ? (
        <div className="w-52 flex-shrink-0 border-r border-zinc-800 flex flex-col">
          <div className="flex items-center gap-1 px-2 h-8 border-b border-zinc-800 flex-shrink-0">
            <button
              type="button"
              onClick={() => beginCreate("")}
              className="flex items-center gap-1 rounded p-1 -ml-1 text-xs text-zinc-400 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <Plus className="w-3.5 h-3.5" /> New
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh file tree"
              title="Refresh"
              className="rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <RefreshCw className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300" />
            </button>
            <button
              type="button"
              onClick={() => setTreeOpen(false)}
              aria-label="Hide file tree"
              title="Hide file tree"
              className="rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <PanelLeftClose className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300" />
            </button>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {creatingIn === "" && createInput(0)}
            {tree.length === 0 && creatingIn === null && (
              <div className="px-2 py-3 text-xs text-zinc-400">No files</div>
            )}
            {renderNodes(tree, 0)}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setTreeOpen(true)}
          aria-label="Show file tree"
          title="Show file tree"
          className="w-6 flex-shrink-0 border-r border-zinc-800 flex items-start justify-center pt-2 text-zinc-500 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        >
          <PanelLeftOpen className="w-3.5 h-3.5" />
        </button>
      )}

      {/* selected file: preview (matching renderer) or raw (textarea fallback) */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected === null ? (
          <div className="flex-1 flex items-center justify-center text-zinc-400 text-xs gap-2">
            <FolderOpen className="w-4 h-4" /> Select a file
          </div>
        ) : (
          (() => {
            // content-aware: only renderers that ACCEPT this file's content are offered.
            // The user's explicit binding (if resolvable) leads; otherwise best match.
            const candidates = candidatesFor(selected, editor.content, plugins);
            const bound = bindings[selected] ? getRenderer(bindings[selected], plugins) : undefined;
            const options = [bound, ...candidates.filter((c) => c.id !== bound?.id)].filter(
              (r): r is RendererDesc => !!r
            );
            const previewRenderer = options[0];
            // no matching renderer => raw, whatever the toggle says — header (Save,
            // dirty dot) and body must agree on which mode is actually showing
            const effMode = mode !== "raw" && previewRenderer ? "preview" : "raw";
            return (
              <>
                <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
                  <span className="text-xs text-zinc-300 truncate">{selected}</span>
                  {effMode === "raw" && editor.dirty && <span className="text-[10px] text-amber-400">●</span>}
                  <div className="flex-1" />
                  {/* the per-file mode: Preview (renderer) / Raw (textarea) */}
                  <div className="flex rounded overflow-hidden bg-zinc-800 text-[11px] flex-shrink-0">
                    <button
                      onClick={() => setMode("preview")}
                      disabled={!previewRenderer}
                      title={previewRenderer ? `Preview with ${previewRenderer.title}` : "No matching renderer — raw only"}
                      className={`px-2 py-0.5 disabled:opacity-40 ${
                        effMode === "preview" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      Preview
                    </button>
                    <button
                      onClick={() => setMode("raw")}
                      className={`px-2 py-0.5 ${
                        effMode === "raw" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      Raw
                    </button>
                  </div>
                  {/* renderer picker: Auto = clear the binding, follow the best content
                      match. Shown whenever there is a binding to clear OR a real choice —
                      so a stale/wrong binding always has a UI way out. */}
                  {effMode === "preview" && (bound || options.length > 1) && (
                    <select
                      value={bound?.id ?? ""}
                      onChange={(e) => setBinding(selected, e.target.value || null)}
                      title="Renderer for Preview (Auto = best content match)"
                      className="bg-zinc-800 text-zinc-300 text-[11px] rounded px-1 py-0.5 outline-none max-w-[110px]"
                    >
                      <option value="">Auto</option>
                      {options.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.title}
                          {r.source === "plugin" ? ` · ${r.pluginId}` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {/* export bridge: download this context file as a real file */}
                  <button
                    onClick={() => downloadText(selected, editor.content)}
                    title="Download this file (export)"
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  {/* pin this file's content into every bot prompt (toggle) */}
                  <PinToggle path={selected} pinned={pinned} togglePin={togglePin} />
                  {effMode === "raw" && (
                    <button
                      onClick={() => void onSave()}
                      disabled={!editor.dirty}
                      className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
                    >
                      <Save className="w-3.5 h-3.5" /> Save
                    </button>
                  )}
                </div>
                {effMode === "preview" && previewRenderer ? (
                  // the chosen renderer owns load/edit/save for this one file
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <RendererHost ctx={ctx} path={selected} renderer={previewRenderer} config={configs[selected]} />
                  </div>
                ) : (
                  // CodeMirror in raw mode: still inert text (no HTML execution, no XSS), now
                  // with line numbers, undo history and md/json syntax highlighting.
                  <Suspense
                    fallback={<div className="flex-1 min-h-0 bg-zinc-950" aria-busy="true" />}
                  >
                    <CodeEditor
                      value={editor.content}
                      onChange={editor.edit}
                      path={selected}
                      className="flex-1 min-h-0 overflow-hidden"
                    />
                  </Suspense>
                )}
              </>
            );
          })()
        )}
        {(editor.status || status) && (
          <div
            aria-live="polite"
            className="px-3 py-1 text-[11px] text-zinc-400 border-t border-zinc-800 flex-shrink-0"
          >
            {editor.status || status}
          </div>
        )}
      </div>
    </div>
  );
}
