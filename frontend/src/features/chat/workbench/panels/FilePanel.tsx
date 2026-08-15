import { Button as UiButton } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ActionButton } from "@/components/ui/action-button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  TextQuote,
} from "lucide-react";
import type { WorkbenchContext } from "../context";
import type { FsEntry } from "../fsClient";
import { errMsg, useFileEditor } from "../jsonFile";
import { PinToggle } from "../PinToggle";
import { AttachContextButton } from "@/features/chat/context/ContextPickBar";
import { addToContextTitle } from "@/features/chat/context/contextLabels";
import {
  useContextPickStore,
  selectionLineRange,
  rangedFileContextItem,
} from "@/features/chat/context/contextPick";
import { previewOptions } from "../renderers/registry";
import { RendererHost } from "../renderers/RendererHost";
import { isComposing } from "@/lib/ime";
import { cn } from "@/lib/cn";
import { FileTreeItem } from "@/components/ui/item";

// Click-gated: the CodeMirror editor (its own chunk, incl. md/json language packs) only
// downloads when a user actually opens Raw mode — keeps it off the chat critical path, like
// the pdf/hljs viewers. Named export → default shim. Suspense falls back to a blank field.
const CodeEditor = lazy(() => import("../CodeEditor").then((m) => ({ default: m.CodeEditor })));

// Width thresholds for the file-reading layout inside the Workbench float.
// Below COMPACT the tree yields the column to the editor (overlay when reopened);
// below TIGHT the toolbar collapses secondary actions into a "…" menu.
const COMPACT_W = 520;
const TIGHT_W = 380;

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

function basename(path: string) {
  return path.split("/").pop() || path;
}

// The file browser IS the workbench body: browse the channel workspace (context_files)
// as a folder tree; a selected file has exactly three controls — PIN (inject into every
// bot prompt), PREVIEW (render with the bound or best content-matching renderer; a
// switcher appears when several match), RAW (plain <UiTextarea> editor, also the fallback
// when nothing matches). Raw content is rendered ONLY inside a <UiTextarea> (inert text —
// no HTML execution), so stored content cannot XSS co-channel users.
export function FilePanel({ ctx }: { ctx: WorkbenchContext }) {
  const { fs, rendererExtensions, bindings, setBinding, configs, pinned, togglePin } = ctx;
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // "auto" = preview when a renderer matches, raw otherwise; user toggle overrides
  // for the currently selected file (resets on selection change).
  const [mode, setMode] = useState<"auto" | "preview" | "raw">("auto");
  const [failedRenderers, setFailedRenderers] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<string | null>(null);
  const addContext = useContextPickStore((s) => s.add);
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
  // Compact reading: observe the panel box (not the viewport) so a narrow float /
  // mid-width lane adapts even on a large display.
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelW, setPanelW] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // Remember whether the user manually reopened the tree in compact mode so we
  // don't immediately auto-collapse it again on the next resize tick.
  const userTreeOverride = useRef(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setPanelW(w);
    });
    ro.observe(el);
    setPanelW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const compact = panelW > 0 && panelW < COMPACT_W;
  const tight = panelW > 0 && panelW < TIGHT_W;

  // Entering compact: auto-hide the tree so the editor/preview owns the column.
  // Leaving compact: clear the override flag; leave treeOpen as the user left it.
  useEffect(() => {
    if (compact && !userTreeOverride.current) setTreeOpen(false);
    if (!compact) userTreeOverride.current = false;
  }, [compact]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen]);

  const tree = useMemo(() => buildTree(entries), [entries]);

  // The selected file's content/edit/save (optimistic lock + conflict reload) is the shared
  // useFileEditor hook; FilePanel only adds the browser (tree / create / delete / pick).
  const editor = useFileEditor(fs, selected ?? "");

  useEffect(() => {
    setMode("auto");
    if (!selected) return;
    setFailedRenderers((current) => {
      if (!current[selected]) return current;
      const next = { ...current };
      delete next[selected];
      return next;
    });
  }, [selected]);

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

  const setTreeOpenUser = useCallback(
    (open: boolean) => {
      userTreeOverride.current = compact;
      setTreeOpen(open);
    },
    [compact]
  );

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
      // Compact overlay: picking/creating a file should return focus to the editor.
      if (compact) setTreeOpenUser(false);
    } catch (e) {
      setStatus(errMsg(e));
    }
  }, [creatingIn, newName, fs, refresh, expandAncestors, compact, setTreeOpenUser]);

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

  const pickFile = (path: string) => {
    setSelected(path);
    // Compact overlay: selecting a file dismisses the tree so reading gets the column.
    if (compact) setTreeOpenUser(false);
  };

  const createInput = (depth: number) => (
    <div className="flex items-center gap-2 px-2 py-1" style={{ paddingLeft: depth * 12 + 8 }}>
      <FileText className="w-3.5 h-3.5 flex-shrink-0 text-content-muted" />
      <UiInput
        autoFocus
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
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
        controlSize="regular" className="flex-1 bg-zinc-800 text-content-secondary text-compact rounded-sm outline-none"
      />
    </div>
  );

  const deleteControl = (path: string, recursive: boolean) =>
    confirmDel === path ? (
      // Confirm sits LEFT (far from where the Trash2 target was, on the right edge)
      // and the pair is spaced gap-2 with padded hit areas, so a near-miss after
      // arming delete lands on Cancel, never on the irreversible Confirm.
      <span className="flex items-center gap-2">
        <UiButton variant="plain"
          type="button"
          content="icon" controlSize="compact"
          aria-label={recursive ? "Confirm: delete entire folder" : "Confirm delete"}
          title={recursive ? "Confirm: delete entire folder" : "Confirm delete"}
          onClick={() => void doDelete(path, recursive)}
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Check className="w-3.5 h-3.5 text-danger-400 hover:text-danger-300" />
        </UiButton>
        <UiButton variant="plain"
          type="button"
          content="icon" controlSize="compact"
          aria-label="Cancel delete"
          title="Cancel"
          onClick={() => setConfirmDel(null)}
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <X className="w-3.5 h-3.5 text-content-muted hover:text-content-secondary" />
        </UiButton>
      </span>
    ) : (
      <UiButton variant="plain"
        type="button"
        content="icon" controlSize="compact"
        aria-label={recursive ? "Delete folder" : "Delete file"}
        title={recursive ? "Delete folder" : "Delete"}
        onClick={() => setConfirmDel(path)}
        className="rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <Trash2 className="w-3.5 h-3.5 text-content-muted hover:text-danger-400" />
      </UiButton>
    );

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.isDir) {
        const isCollapsed = collapsed.has(node.path);
        return (
          <div key={`d:${node.path}`}>
            {/* Row is a real disclosure <UiButton variant="plain"> (keyboard-operable, aria-expanded);
                the new-file/delete controls are sibling buttons, not nested, to keep
                interactives un-nested. */}
            <FileTreeItem
                depth={depth}
                title={node.name}
                onClick={() => toggleCollapse(node.path)}
                expanded={!isCollapsed}
                disclosure={isCollapsed ? (
                  <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-content-muted" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-content-muted" />
                )}
                leading={<Folder className="w-3.5 h-3.5 flex-shrink-0 text-accent-400/70" />}
                actions={<><UiButton variant="plain"
                type="button"
                content="icon" controlSize="compact"
                aria-label="New file in this folder"
                title="New file in this folder"
                onClick={() => {
                  if (isCollapsed) toggleCollapse(node.path);
                  beginCreate(node.path);
                }}
                className="rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Plus className="w-3.5 h-3.5 text-content-muted hover:text-content-secondary" />
              </UiButton>
              {deleteControl(node.path, true)}
              </>}
            />
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
        <FileTreeItem
          key={`f:${node.path}`}
          depth={depth}
          title={node.name}
          selected={selected === node.path}
          leading={<FileText className="w-3.5 h-3.5 flex-shrink-0 text-content-muted" />}
          actions={deleteControl(node.path, false)}
          onClick={() => pickFile(node.path)}
        />
      );
    });

  const treeColumn = (
    <div
      className={cn(
        "flex flex-col rounded-sm bg-zinc-900/50",
        // Compact: overlay drawer over the editor so reading width isn't halved.
        compact
          ? "absolute inset-y-1.5 left-1.5 z-10 w-[min(16rem,calc(100%-1.5rem))] shadow-xl shadow-black/40 ring-1 ring-zinc-700/80"
          : "w-52 flex-shrink-0"
      )}
    >
      <div className="mx-1 mt-1 flex h-9 flex-shrink-0 items-center gap-1 rounded-sm bg-zinc-800/50 px-2">
        <ActionButton action="add" context="toolbar"
          type="button"
          onClick={() => beginCreate("")}
          accessibleLabel="Create file"
          controlSize="regular"
          className="rounded-sm"
        />
        <div className="flex-1" />
        <UiButton variant="plain"
          type="button"
          content="icon" controlSize="compact"
          onClick={() => void refresh()}
          aria-label="Refresh file tree"
          title="Refresh"
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <RefreshCw className="w-3.5 h-3.5 text-content-muted hover:text-content-secondary" />
        </UiButton>
        <UiButton variant="plain"
          type="button"
          content="icon" controlSize="compact"
          onClick={() => setTreeOpenUser(false)}
          aria-label="Hide file tree"
          title="Hide file tree"
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <PanelLeftClose className="w-3.5 h-3.5 text-content-muted hover:text-content-secondary" />
        </UiButton>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {creatingIn === "" && createInput(0)}
        {tree.length === 0 && creatingIn === null && (
          <div className="px-2 py-3 text-compact text-content-muted">No files</div>
        )}
        {renderNodes(tree, 0)}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="relative flex h-full gap-2 p-2 text-regular min-w-0">
      {/* file tree — side column normally; overlay drawer when compact + open */}
      {treeOpen ? (
        treeColumn
      ) : (
        <UiButton action="expand" content="icon" variant="plain"
          type="button"
          onClick={() => setTreeOpenUser(true)}
          aria-label="Show file tree"
          title="Show file tree"
          className="flex flex-shrink-0 items-start justify-center rounded-sm bg-zinc-900/50 pt-2 text-content-primary hover:text-content-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        >
          <PanelLeftOpen className="w-3.5 h-3.5" />
        </UiButton>
      )}
      {/* Compact overlay scrim — tap outside the tree to return to the file. */}
      {compact && treeOpen && (
        <UiButton action="close" variant="plain"
          type="button"
          aria-label="Close file tree"
          onClick={() => setTreeOpenUser(false)}
          className="absolute inset-0 z-[5] bg-black/40"
        />
      )}

      {/* selected file: preview (matching renderer) or raw (textarea fallback) */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected === null ? (
          <div className="flex-1 flex items-center justify-center text-content-muted text-compact gap-2">
            <FolderOpen className="w-4 h-4" /> Select a file
          </div>
        ) : (
          (() => {
            // content-aware: only renderers that ACCEPT this file's content are offered.
            // The user's explicit binding (if resolvable) leads; otherwise best match.
            const options = previewOptions(
              selected,
              editor.content,
              rendererExtensions,
              bindings[selected],
              failedRenderers[selected]
            );
            const bound = bindings[selected] ? options.find((renderer) => renderer.id === bindings[selected]) : undefined;
            const previewRenderer = options[0];
            // no matching renderer => raw, whatever the toggle says — header (Save,
            // dirty dot) and body must agree on which mode is actually showing
            const effMode = mode !== "raw" && previewRenderer ? "preview" : "raw";
            const pathLabel = compact ? basename(selected) : selected;

            const secondaryActions = (
              <>
                <UiButton variant="plain"
                  onClick={() => {
                    downloadText(selected, editor.content);
                    setMoreOpen(false);
                  }}
                  title="Download this file (export)"
                  content="icon" controlSize="compact"
                  className="text-content-primary hover:text-content-strong"
                >
                  <Download className="w-3.5 h-3.5" />
                </UiButton>
                <PinToggle path={selected} pinned={pinned} togglePin={togglePin} />
                <AttachContextButton
                  channelId={ctx.channelId}
                  disabled={pinned.includes(selected)}
                  disabledTitle="Already pinned — sent in every prompt"
                  title={addToContextTitle("this file")}
                  item={{
                    id: `file:${selected}`,
                    verb: "fs.read",
                    params: { path: selected },
                    label: basename(selected),
                    kind: "file",
                  }}
                />
                <UiButton variant="plain"
                  type="button"
                  content="icon" controlSize="compact"
                  disabled={pinned.includes(selected)}
                  title={
                    pinned.includes(selected)
                      ? "Already pinned — sent in every prompt"
                      : `${addToContextTitle("the selected lines")} (select text first)`
                  }
                  onClick={() => {
                    const sel = window.getSelection()?.toString() ?? "";
                    const range = selectionLineRange(editor.content, sel);
                    if (!range) {
                      setStatus("Select some text in the file first, then attach.");
                      return;
                    }
                    addContext(
                      ctx.channelId,
                      rangedFileContextItem(selected, range.start, range.end)
                    );
                    setStatus(`Added ${basename(selected)}:${range.start}-${range.end} to context`);
                    setMoreOpen(false);
                  }}
                  className="rounded-sm text-content-primary hover:text-accent-300 disabled:opacity-50 disabled:hover:text-content-primary"
                >
                  <TextQuote className="w-3.5 h-3.5" />
                </UiButton>
              </>
            );

            return (
              <>
                <div
                  className={cn(
                    "mx-1 mt-1 flex flex-shrink-0 items-center gap-2 rounded-sm bg-zinc-900/50 px-3",
                    tight ? "min-h-9 flex-wrap py-1" : "h-9"
                  )}
                >
                  <span className="text-compact text-content-secondary truncate min-w-0" title={selected}>
                    {pathLabel}
                  </span>
                  {effMode === "raw" && editor.dirty && (
                    <span className="text-minimal text-warning-400 flex-shrink-0">●</span>
                  )}
                  <div className="flex-1 min-w-2" />
                  {/* the per-file mode: Preview (renderer) / Raw (textarea) */}
                  <div className="flex rounded-sm overflow-hidden bg-zinc-800 text-compact flex-shrink-0">
                    <UiButton variant="plain" role="tab" aria-selected={effMode === "preview"}
                      onClick={() => {
                        setFailedRenderers((current) => ({ ...current, [selected]: [] }));
                        setMode("preview");
                      }}
                      disabled={!previewRenderer}
                      title={
                        previewRenderer
                          ? `Preview with ${previewRenderer.title}`
                          : "No matching renderer — raw only"
                      }
                      controlSize="regular" className={`disabled:opacity-50 ${
 effMode === "preview"
 ? "bg-zinc-700 text-content-primary"
 : "text-content-primary hover:text-content-strong"
 }`}
                    >
                      Preview
                    </UiButton>
                    <UiButton variant="plain" role="tab" aria-selected={effMode === "raw"}
                      onClick={() => setMode("raw")}
                      controlSize="regular" className={`${
 effMode === "raw"
 ? "bg-zinc-700 text-content-primary"
 : "text-content-primary hover:text-content-strong"
 }`}
                    >
                      Raw
                    </UiButton>
                  </div>
                  {/* renderer picker: Auto = clear the binding, follow the best content
                      match. Shown whenever there is a binding to clear OR a real choice —
                      so a stale/wrong binding always has a UI way out. */}
                  {effMode === "preview" && (bound || options.length > 1) && !tight && (
                    <UiSelect
                      value={bound?.id ?? ""}
                      onChange={(e) => {
                        setFailedRenderers((current) => ({ ...current, [selected]: [] }));
                        setBinding(selected, e.target.value || null);
                      }}
                      title="Renderer for Preview (Auto = best content match)"
                      controlSize="regular" className="bg-zinc-800 text-content-secondary text-compact rounded-sm outline-none max-w-[110px]"
                    >
                      <option value="">Auto</option>
                      {options.map((r) => {
                        const p =
                          r.source === "extension"
                            ? rendererExtensions.find((pl) => pl.extensionId === r.extensionId)
                            : undefined;
                        const mark = p?.transient
                          ? "⏱ "
                          : p?.origin === "personal"
                            ? "💻 "
                            : "";
                        return (
                          <option key={r.id} value={r.id}>
                            {mark}
                            {r.title}
                            {r.source === "extension" ? ` · ${r.extensionId}` : ""}
                          </option>
                        );
                      })}
                    </UiSelect>
                  )}
                  {tight ? (
                    <div className="relative flex-shrink-0" ref={moreRef}>
                      <UiButton variant="plain"
                        type="button"
                        content="icon" controlSize="compact"
                        onClick={() => setMoreOpen((o) => !o)}
                        aria-expanded={moreOpen}
                        aria-label="More file actions"
                        title="More"
                        className="rounded-sm text-content-primary hover:text-content-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </UiButton>
                      {moreOpen && (
                        <div className="absolute right-0 top-6 z-20 flex items-center gap-1 rounded-sm bg-zinc-900 p-2 shadow-xl shadow-black/40 ring-1 ring-zinc-700/80">
                          {effMode === "preview" && (bound || options.length > 1) && (
                            <UiSelect
                              value={bound?.id ?? ""}
                              onChange={(e) => {
                                setFailedRenderers((current) => ({ ...current, [selected]: [] }));
                                setBinding(selected, e.target.value || null);
                              }}
                              title="Renderer for Preview (Auto = best content match)"
                              controlSize="regular" className="bg-zinc-800 text-content-secondary text-compact rounded-sm outline-none max-w-[110px]"
                            >
                              <option value="">Auto</option>
                              {options.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.title}
                                </option>
                              ))}
                            </UiSelect>
                          )}
                          {secondaryActions}
                        </div>
                      )}
                    </div>
                  ) : (
                    secondaryActions
                  )}
                  {effMode === "raw" && (
                    <IconButton label={`Save ${selected}`}
                      onClick={() => void onSave()}
                      disabled={!editor.dirty}
                      controlSize="compact"
                    >
                      <Save className="w-3.5 h-3.5" />
                    </IconButton>
                  )}
                </div>
                {effMode === "preview" && previewRenderer ? (
                  // the chosen renderer owns load/edit/save for this one file
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <RendererHost
                      ctx={ctx}
                      path={selected}
                      renderer={previewRenderer}
                      config={configs[selected]}
                      onFailure={(rendererId, reason) => {
                        setFailedRenderers((current) => ({
                          ...current,
                          [selected]: [...new Set([...(current[selected] ?? []), rendererId])],
                        }));
                        setStatus(`${previewRenderer.title} failed: ${reason}. Switched to the next available renderer.`);
                      }}
                    />
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
            className="mx-1 mb-1 rounded-sm bg-zinc-900/50 px-3 py-1 text-compact text-content-muted"
          >
            {editor.status || status}
          </div>
        )}
      </div>
    </div>
  );
}
