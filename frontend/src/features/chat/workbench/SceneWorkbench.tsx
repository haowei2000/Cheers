import { Button as UiButton } from "@/components/ui/button";
import { AdaptiveControlGroup, type AdaptiveControlPresentation } from "@/components/ui/adaptive-control-group";
import { DropdownSelect } from "@/components/ui/dropdown-select";
import { MenuOption } from "@/components/ui/menu-option";
import { Select as UiSelect } from "@/components/ui/select";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Atom,
  Boxes,
  CheckSquare2,
  Code2,
  Eye,
  EyeOff,
  FileQuestion,
  Folder,
  FolderPlus,
  Frame,
  LayoutGrid,
  Paperclip,
  Save,
  Server,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  pointRect,
  preservesNativeContextMenu,
  useContextActions,
  useContextSurface,
  type ContextAction,
} from "@/components/ui/context-actions";
import {
  rangedFileContextItem,
  selectionLineRange,
  useContextPickStore,
  usePendingContext,
  workbenchFileContextItem,
} from "@/features/chat/context/contextPick";
import type { WorkbenchContext } from "./context";
import type { FsEntry } from "./fsClient";
import { useFileSession } from "./jsonFile";
import { useAnnotations } from "./annotations";
import { AnnotationComposer, AnnotationList, type PendingAnnotation } from "./AnnotationBar";
import type { LensContextTarget } from "./lens/registry";
import type { TemplateManifest } from "./manifest";
import { IconButton } from "@/components/ui/icon-button";
import { RendererHost } from "./renderers/RendererHost";
import { getRenderer, previewOptions, type RendererDesc } from "./renderers/registry";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";
import { workbenchControlSize } from "./workbench-control";
import {
  FloatingPanelActionPortal,
  FloatingPanelContextPortal,
  FloatingPanelPrimaryNavigation,
} from "@/components/ui/floating-panel";

const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

const OTHER_SCENE = "__other__";

// A canvas is the successor to a scene: a named collection of channel content, but one
// that lives in its own file instead of in `scene_state` (docs/arch/CANVAS.md). So it
// takes a slot in the SAME primary navigation, as a scene whose only item is that file
// — which is why the canvas itself becomes the navigation and the item tabs go quiet.
//
// Flat coexistence rather than a mode switch: while both concepts exist, a channel
// should be able to migrate one scene at a time and always see both.
const CANVAS_SCENE = "canvas:";
const canvasSceneId = (path: string) => `${CANVAS_SCENE}${path}`;
const canvasScenePath = (id: string) => (id.startsWith(CANVAS_SCENE) ? id.slice(CANVAS_SCENE.length) : null);
const isCanvasPath = (path: string) => /\.canvas\.(ya?ml|json)$/i.test(path);

const sceneMeta: Record<string, { subtitle: string; Icon: typeof Code2; color: string }> = {
  "cheers-code-project": { subtitle: "Plan, fix, and ship", Icon: Code2, color: "text-accent-300" },
  "cheers-research-lab": { subtitle: "Experiments and submissions", Icon: Atom, color: "text-research-300" },
  "cheers-task-board": { subtitle: "Turn intent into progress", Icon: CheckSquare2, color: "text-info-300" },
  "cheers-team-ops": { subtitle: "Systems and ownership", Icon: Server, color: "text-warning-300" },
  [OTHER_SCENE]: { subtitle: "Renderable items outside scenes", Icon: Boxes, color: "text-category-300" },
};

function metaFor(id: string) {
  return sceneMeta[id] ?? { subtitle: "Native workspace", Icon: LayoutGrid, color: "text-content-secondary" };
}

export function sceneTabContextActions(
  label: string,
  onSelect: () => void,
  onShowRaw: () => void,
  onAddToContext: () => void,
  contextAdded = false,
  contextAvailable = true,
): ContextAction[] {
  return [
    {
      id: "open-scene",
      label: `Open ${label}`,
      icon: <LayoutGrid className="h-4 w-4" />,
      run: onSelect,
    },
    {
      id: "add-context",
      label: !contextAvailable
        ? "No scene files to add"
        : contextAdded
          ? "Already added to context"
          : "Add scene to context",
      icon: <Paperclip className="h-4 w-4" />,
      disabled: !contextAvailable || contextAdded,
      group: "secondary",
      run: onAddToContext,
    },
    {
      id: "raw",
      label: "Raw",
      icon: <Folder className="h-4 w-4" />,
      group: "secondary",
      run: onShowRaw,
    },
  ];
}

function SceneTab({
  label,
  Icon,
  iconColor,
  selected,
  presentation,
  onSelect,
  onShowRaw,
  onAddToContext,
  contextAdded,
  contextAvailable,
}: {
  label: string;
  Icon: typeof Code2;
  iconColor: string;
  selected: boolean;
  presentation: Exclude<AdaptiveControlPresentation, "collapsed">;
  onSelect: () => void;
  onShowRaw: () => void;
  onAddToContext: () => void;
  contextAdded: boolean;
  contextAvailable: boolean;
}) {
  const surfaceRef = useRef<HTMLButtonElement>(null);
  const contextSurface = useContextSurface({
    surfaceRef,
    actions: () => sceneTabContextActions(label, onSelect, onShowRaw, onAddToContext, contextAdded, contextAvailable),
  });
  const contextHandlers = {
    onContextMenu: contextSurface.onContextMenu,
    onKeyDown: contextSurface.onKeyDown,
    onPointerDown: contextSurface.onPointerDown,
    onPointerMove: contextSurface.onPointerMove,
    onPointerUp: contextSurface.onPointerUp,
    onPointerCancel: contextSurface.onPointerCancel,
    onPointerLeave: contextSurface.onPointerLeave,
    onClickCapture: contextSurface.onClickCapture,
  };

  const iconOnly = presentation === "icon";
  return (
    <UiButton
      ref={surfaceRef}
      variant="plain"
      content={iconOnly ? "icon" : "text"}
      role="tab"
      aria-selected={selected}
      selected={selected}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      type="button"
      onClick={onSelect}
      controlSize={workbenchControlSize.tab}
      className="flex-shrink-0 gap-1 rounded-sm text-content-primary hover:text-content-strong"
      {...contextHandlers}
    >
      {presentation !== "text" && <Icon className={cn("h-4 w-4", selected && iconColor)} />}
      {!iconOnly && <span className="truncate">{label}</span>}
    </UiButton>
  );
}

function AddSceneControl({
  available,
  onSelect,
}: {
  available: TemplateManifest[];
  onSelect: (manifest: TemplateManifest) => void;
}) {
  if (available.length === 0) return null;

  return (
    <DropdownSelect
        ariaLabel="Add scene"
        label="Add scene"
        leading={<FolderPlus className="h-4 w-4 text-content-secondary" aria-hidden="true" />}
        options={available.map((template) => ({ value: template.id, label: template.title }))}
        onSelect={(value) => {
          const manifest = available.find((candidate) => candidate.id === value);
          if (manifest) onSelect(manifest);
        }}
        placement="up"
        controlSize={workbenchControlSize.tab}
        controlWidth="fill"
        className="flex-shrink-0"
      />
  );
}

function basename(path: string) {
  return path.split("/").pop() || path;
}

function fallbackItemTitle(path: string) {
  const file = basename(path);
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
  return stem.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ItemTab({
  label,
  selected,
  presentation,
  contextAdded,
  onSelect,
  onAddToContext,
}: {
  label: string;
  selected: boolean;
  presentation: Exclude<AdaptiveControlPresentation, "collapsed">;
  contextAdded: boolean;
  onSelect: () => void;
  onAddToContext: () => void;
}) {
  const surfaceRef = useRef<HTMLButtonElement>(null);
  const contextSurface = useContextSurface({
    surfaceRef,
    actions: () => [{
      id: "add-context",
      label: contextAdded ? "Already added to context" : "Add to context",
      icon: <Paperclip className="h-4 w-4" />,
      disabled: contextAdded,
      run: onAddToContext,
    }],
  });

  return (
    <UiButton
      ref={surfaceRef}
      variant="plain"
      role="tab"
      aria-selected={selected}
      selected={selected}
      aria-label={presentation === "icon" ? label : undefined}
      title={presentation === "icon" ? label : undefined}
      content={presentation === "icon" ? "icon" : "text"}
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      controlSize={workbenchControlSize.tab}
      className={cn(
        "flex-shrink-0 gap-1 rounded-sm text-content-primary hover:text-content-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500",
      )}
      onContextMenu={contextSurface.onContextMenu}
      onKeyDown={contextSurface.onKeyDown}
      onPointerDown={contextSurface.onPointerDown}
      onPointerMove={contextSurface.onPointerMove}
      onPointerUp={contextSurface.onPointerUp}
      onPointerCancel={contextSurface.onPointerCancel}
      onPointerLeave={contextSurface.onPointerLeave}
      onClickCapture={contextSurface.onClickCapture}
    >
      {presentation === "icon" ? <LayoutGrid className="h-4 w-4" aria-hidden="true" /> : label}
    </UiButton>
  );
}

function ContextPickSurface({
  channelId,
  path,
  content,
  children,
  onAdded,
}: {
  channelId: string;
  path: string;
  content: string;
  children: ReactNode;
  onAdded: (label: string) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { open } = useContextActions();
  const addContext = useContextPickStore((state) => state.add);
  const picked = usePendingContext(channelId);
  const item = workbenchFileContextItem(path);
  const added = picked.some((candidate) => candidate.id === item.id);
  const actions = () => [{
    id: "add-context",
    label: added ? "Already added to context" : "Add to context",
    icon: <Paperclip className="h-4 w-4" />,
    disabled: added,
    run: () => {
      addContext(channelId, item);
      onAdded(item.label);
    },
  } satisfies ContextAction];
  const contextSurface = useContextSurface({
    surfaceRef,
    actions,
    selectionActions: (selection) => {
      const range = selectionLineRange(content, selection.text);
      return [{
        id: "add-lines",
        label: "Add selected lines to context",
        icon: <Paperclip className="h-4 w-4" />,
        disabled: !range,
        run: () => {
          if (!range) throw new Error("The selected text could not be mapped to file lines");
          const ranged = rangedFileContextItem(path, range.start, range.end);
          addContext(channelId, ranged);
          onAdded(ranged.label);
        },
      } satisfies ContextAction];
    },
  });

  const onContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-workbench-context-target]")) return;
    if (!preservesNativeContextMenu(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    open({
      actions: actions(),
      anchor: pointRect(event.clientX, event.clientY),
      source: "pointer",
      restoreFocus: event.target instanceof HTMLElement ? event.target : surfaceRef.current,
    });
  };

  return (
    <div
      ref={surfaceRef}
      className="h-full min-h-0"
      tabIndex={0}
      onContextMenuCapture={onContextMenuCapture}
      onContextMenu={contextSurface.onContextMenu}
      onMouseUp={contextSurface.onMouseUp}
      onKeyDown={contextSurface.onKeyDown}
      onPointerDown={contextSurface.onPointerDown}
      onPointerMove={contextSurface.onPointerMove}
      onPointerUp={contextSurface.onPointerUp}
      onPointerCancel={contextSurface.onPointerCancel}
      onPointerLeave={contextSurface.onPointerLeave}
      onClickCapture={contextSurface.onClickCapture}
    >
      {children}
    </div>
  );
}

export function reconcileSceneItems(
  sceneState: WorkbenchSceneState | undefined,
  templates: TemplateManifest[],
  legacyEnvironment?: string | null
): WorkbenchSceneState {
  const order = sceneState?.order?.length
    ? [...sceneState.order]
    : legacyEnvironment
      ? [legacyEnvironment]
      : [];
  const titles = { ...(sceneState?.titles ?? {}) };
  const items = Object.fromEntries(
    Object.entries(sceneState?.items ?? {}).map(([id, paths]) => [id, [...paths]])
  );
  for (const id of order) {
    const template = templates.find((candidate) => candidate.id === id);
    if (!template) continue;
    titles[id] ??= template.title;
    const paths = items[id] ?? [];
    for (const item of template.items) if (!paths.includes(item.source.path)) paths.push(item.source.path);
    items[id] = paths;
  }
  return { version: 1, order, titles, items };
}

function itemTitle(sceneId: string, path: string, templates: TemplateManifest[]) {
  return (
    templates
      .find((template) => template.id === sceneId)
      ?.items.find((item) => item.source.path === path)?.title ?? fallbackItemTitle(path)
  );
}

function rendererFor(
  path: string,
  content: string | undefined,
  ctx: WorkbenchContext,
  failed: string[] = []
): RendererDesc | undefined {
  if (content === undefined) {
    const bound = ctx.bindings[path] ? getRenderer(ctx.bindings[path], ctx.rendererExtensions) : undefined;
    return bound && !failed.includes(bound.id) ? bound : undefined;
  }
  return previewOptions(path, content, ctx.rendererExtensions, ctx.bindings[path], failed)[0];
}

async function readDiscoverableFiles(
  entries: FsEntry[],
  ctx: WorkbenchContext,
  onBatch: (values: Record<string, string>) => void
) {
  const candidates = entries.filter((entry) => {
    if (entry.is_dir || entry.path === ".workbench.json") return false;
    if (ctx.bindings[entry.path] && getRenderer(ctx.bindings[entry.path], ctx.rendererExtensions)) return false;
    return /\.(md|markdown|json|ya?ml)$/i.test(entry.path);
  });
  for (let start = 0; start < candidates.length; start += 4) {
    const batch = candidates.slice(start, start + 4);
    const results = await Promise.all(
      batch.map(async (entry) => {
        try {
          return [entry.path, (await ctx.fs.read(entry.path)).content] as const;
        } catch {
          return null;
        }
      })
    );
    onBatch(Object.fromEntries(results.filter((value): value is readonly [string, string] => value !== null)));
  }
}

export function SceneWorkbench({
  ctx,
  sceneState,
  legacyEnvironment,
  templates,
  onAddScene,
  onShowRaw,
}: {
  ctx: WorkbenchContext;
  sceneState?: WorkbenchSceneState;
  legacyEnvironment?: string | null;
  templates: TemplateManifest[];
  onAddScene: (manifest: TemplateManifest) => Promise<boolean>;
  onShowRaw: () => void;
}) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [failedRenderers, setFailedRenderers] = useState<Record<string, string[]>>({});
  const reconciled = useMemo(
    () => reconcileSceneItems(sceneState, templates, legacyEnvironment),
    [sceneState, templates, legacyEnvironment]
  );
  const storagePrefix = `cheers.workbench.${ctx.channelId}`;
  const [activeScene, setActiveScene] = useState(
    () => localStorage.getItem(`${storagePrefix}.scene`) || reconciled.order[0] || ""
  );
  const [selectedByScene, setSelectedByScene] = useState<Record<string, string>>({});
  const addContext = useContextPickStore((state) => state.add);
  const picked = usePendingContext(ctx.channelId);
  const pickedIds = useMemo(() => new Set(picked.map((item) => item.id)), [picked]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const listing = await ctx.fs.ls("");
      setEntries(listing.entries);
      setStatus(null);
      void readDiscoverableFiles(listing.entries, ctx, (values) =>
        setContents((previous) => ({ ...previous, ...values }))
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn’t load Workbench items");
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    if (ctx.filesTick !== undefined) void refresh();
  }, [ctx.filesTick, refresh]);

  const existing = useMemo(
    () => new Set(entries.filter((entry) => !entry.is_dir).map((entry) => entry.path)),
    [entries]
  );
  const renderers = useMemo(() => {
    const found: Record<string, RendererDesc> = {};
    for (const path of existing) {
      const renderer = rendererFor(path, contents[path], ctx, failedRenderers[path]);
      if (renderer) found[path] = renderer;
    }
    return found;
  }, [existing, contents, ctx, failedRenderers]);
  const claimed = useMemo(
    () => new Set(reconciled.order.flatMap((id) => reconciled.items[id] ?? [])),
    [reconciled]
  );
  const otherPaths = useMemo(
    () => Object.keys(renderers).filter((path) => !claimed.has(path)).sort((a, b) => a.localeCompare(b)),
    [renderers, claimed]
  );
  const canvasPaths = useMemo(
    () => [...existing].filter(isCanvasPath).sort((a, b) => a.localeCompare(b)),
    [existing]
  );
  const sceneIds = useMemo(
    () => [...reconciled.order, ...canvasPaths.map(canvasSceneId), ...(otherPaths.length ? [OTHER_SCENE] : [])],
    [reconciled.order, canvasPaths, otherPaths.length]
  );

  useEffect(() => {
    if (!sceneIds.length) {
      setActiveScene("");
      return;
    }
    if (!sceneIds.includes(activeScene)) setActiveScene(sceneIds[0]);
  }, [sceneIds, activeScene]);
  useEffect(() => {
    if (!activeScene) return;
    localStorage.setItem(`${storagePrefix}.scene`, activeScene);
  }, [activeScene, storagePrefix]);

  const activePaths = useMemo(() => {
    const canvas = canvasScenePath(activeScene);
    if (canvas) return existing.has(canvas) ? [canvas] : [];
    const paths = activeScene === OTHER_SCENE ? otherPaths : reconciled.items[activeScene] ?? [];
    return paths.filter((path) => existing.has(path) && (activeScene !== OTHER_SCENE || renderers[path]));
  }, [activeScene, otherPaths, reconciled.items, existing, renderers]);
  const storedSelection = activeScene
    ? localStorage.getItem(`${storagePrefix}.item.${activeScene}`)
    : null;
  const selectedPath =
    (selectedByScene[activeScene] && activePaths.includes(selectedByScene[activeScene])
      ? selectedByScene[activeScene]
      : storedSelection && activePaths.includes(storedSelection)
        ? storedSelection
        : activePaths[0]) ?? null;

  // ONE session for the selected item, shared by this scene's two views: Raw edits
  // `text`, Preview renders `data` parsed from it. See FileSession.
  const session = useFileSession(ctx.fs, selectedPath ?? "");
  // Notes anchored into this item — a separate file, so annotating never touches the
  // document being annotated. Same store the file browser reads.
  const annotations = useAnnotations(ctx.fs, selectedPath ?? "");
  const [pendingNote, setPendingNote] = useState<PendingAnnotation | null>(null);
  const onAnnotate = useCallback(
    (target: LensContextTarget) => selectedPath && setPendingNote({ target, path: selectedPath }),
    [selectedPath]
  );
  const onRemoveNote = useCallback((id: string) => void annotations.remove(id), [annotations]);
  const [revealLine, setRevealLine] = useState<number | undefined>();
  // Paths the user has forced to Raw; everything else follows the content.
  const [rawPaths, setRawPaths] = useState<ReadonlySet<string>>(() => new Set());
  const showRaw = useCallback((path: string, raw: boolean) => {
    setRawPaths((current) => {
      if (current.has(path) === raw) return current;
      const next = new Set(current);
      if (raw) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  // The session has already read the selected file, so feed the discovery map from it
  // rather than issuing a second read for the same bytes — and so an edit does not leave
  // the map (which decides what counts as a scene item at all) describing an old file.
  useEffect(() => {
    if (!selectedPath || session.path !== selectedPath || session.version === null) return;
    const text = session.parsedText;
    setContents((current) => (current[selectedPath] === text ? current : { ...current, [selectedPath]: text }));
  }, [selectedPath, session.path, session.version, session.parsedText]);

  useEffect(() => setPendingNote(null), [selectedPath]);

  const selectPath = (path: string) => {
    setSelectedByScene((previous) => ({ ...previous, [activeScene]: path }));
    localStorage.setItem(`${storagePrefix}.item.${activeScene}`, path);
  };

  const addPathToContext = (path: string) => {
    const item = workbenchFileContextItem(path);
    addContext(ctx.channelId, item);
    setStatus(`Added ${item.label} to context`);
  };

  const addSceneToContext = (id: string) => {
    const paths = id === OTHER_SCENE ? otherPaths : reconciled.items[id] ?? [];
    const existingPaths = paths.filter((path) => existing.has(path));
    for (const path of existingPaths) addContext(ctx.channelId, workbenchFileContextItem(path));
    if (existingPaths.length) {
      setStatus(`Added ${existingPaths.length} ${existingPaths.length === 1 ? "file" : "files"} to context`);
    }
  };

  useEffect(() => {
    const target = ctx.openTarget;
    if (!target || !renderers[target]) return;
    const owner = reconciled.order.find((id) => (reconciled.items[id] ?? []).includes(target));
    setActiveScene(owner ?? OTHER_SCENE);
    setSelectedByScene((previous) => ({ ...previous, [owner ?? OTHER_SCENE]: target }));
  }, [ctx.openTarget, renderers, reconciled]);

  const available = templates.filter((template) => !reconciled.order.includes(template.id));
  const title =
    activeScene === OTHER_SCENE
      ? "Other"
      : reconciled.titles[activeScene] ?? templates.find((template) => template.id === activeScene)?.title ?? activeScene;

  const sceneTabs = () => sceneIds.map((id) => {
    const meta = metaFor(id);
    const label = id === OTHER_SCENE ? "Other" : reconciled.titles[id] ?? id;
    const contextPaths = (id === OTHER_SCENE ? otherPaths : reconciled.items[id] ?? [])
      .filter((path) => existing.has(path));
    return (
      <SceneTab
        key={id}
        label={label}
        Icon={meta.Icon}
        iconColor={meta.color}
        selected={activeScene === id}
        presentation="iconText"
        onSelect={() => setActiveScene(id)}
        onShowRaw={onShowRaw}
        onAddToContext={() => addSceneToContext(id)}
        contextAdded={contextPaths.length > 0
          && contextPaths.every((path) => pickedIds.has(workbenchFileContextItem(path).id))}
        contextAvailable={contextPaths.length > 0}
      />
    );
  });

  const sceneNavigationItems = sceneIds.map((id) => {
    const canvasPath = canvasScenePath(id);
    const meta = canvasPath
      ? { subtitle: "Canvas", Icon: Frame, color: "text-accent-300" }
      : metaFor(id);
    const label = canvasPath
      ? (canvasPath.split("/").pop() ?? canvasPath).replace(/\.canvas\.(ya?ml|json)$/i, "")
      : id === OTHER_SCENE
        ? "Other"
        : reconciled.titles[id] ?? id;
    const contextPaths = (id === OTHER_SCENE ? otherPaths : reconciled.items[id] ?? [])
      .filter((path) => existing.has(path));
    return {
      id,
      label,
      icon: meta.Icon,
      selected: activeScene === id,
      onSelect: () => setActiveScene(id),
      control: (presentation: Exclude<AdaptiveControlPresentation, "collapsed">) => (
        <SceneTab
          label={label}
          Icon={meta.Icon}
          iconColor={meta.color}
          selected={activeScene === id}
          presentation={presentation}
          onSelect={() => setActiveScene(id)}
          onShowRaw={onShowRaw}
          onAddToContext={() => addSceneToContext(id)}
          contextAdded={contextPaths.length > 0
            && contextPaths.every((path) => pickedIds.has(workbenchFileContextItem(path).id))}
          contextAvailable={contextPaths.length > 0}
        />
      ),
    };
  });

  const addSceneAction = useMemo(() => ({
    id: "add-scene",
    label: "Add scene",
    priority: "secondary" as const,
    icon: FolderPlus,
    control: <AddSceneControl available={available} onSelect={(manifest) => void onAddScene(manifest)} />,
    overflow: (
      <>
        {available.map((manifest) => (
          <MenuOption
            key={manifest.id}
            label={manifest.title}
            leading={<FolderPlus className="h-4 w-4" />}
            onClick={() => void onAddScene(manifest)}
          />
        ))}
      </>
    ),
  }), [available, onAddScene]);

  // A canvas navigates itself — you click a node, not a tab — so the item strip that a
  // scene fills stays empty here. This is the same shape the ViewBoard already has.
  const itemNavigationItems = (canvasScenePath(activeScene) ? [] : activePaths).map((path) => ({
    id: path,
    label: itemTitle(activeScene, path, templates),
    selected: path === selectedPath,
    onSelect: () => selectPath(path),
    control: (presentation: Exclude<AdaptiveControlPresentation, "collapsed">) => (
      <ItemTab
        label={itemTitle(activeScene, path, templates)}
        selected={path === selectedPath}
        presentation={presentation}
        onSelect={() => selectPath(path)}
        onAddToContext={() => addPathToContext(path)}
        contextAdded={pickedIds.has(workbenchFileContextItem(path).id)}
      />
    ),
  }));

  if (loading && entries.length === 0) {
    return <div className="flex h-full items-center justify-center text-compact text-content-muted">Preparing Workbench…</div>;
  }

  if (sceneIds.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <LayoutGrid className="h-5 w-5 text-content-muted" />
        <div>
          <div className="text-regular font-medium text-content-secondary">Choose a scene</div>
          <p className="mt-1 max-w-sm text-compact leading-5 text-content-muted">
            Scenes turn workspace data into focused tabs. Unsupported files remain available in Raw.
          </p>
        </div>
        {available.length > 0 && (
          <UiSelect
            defaultValue=""
            onChange={(event) => {
              const manifest = templates.find((candidate) => candidate.id === event.target.value);
              if (manifest) void onAddScene(manifest);
              event.currentTarget.value = "";
            }}
            controlSize={workbenchControlSize.tab} className="rounded-sm bg-indigo-600 text-compact font-medium text-content-on-accent outline-none"
          >
            <option value="" disabled>Add a scene…</option>
            {available.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
          </UiSelect>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FloatingPanelPrimaryNavigation
        ariaLabel="Scenes"
        items={sceneNavigationItems}
        presentationOrder={["iconText", "text", "icon", "collapsed"]}
        mobile={(
          <div role="tablist" aria-label="Scenes" className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-zinc-800/80 px-2 py-2">
            {sceneTabs()}
            <AddSceneControl available={available} onSelect={(manifest) => void onAddScene(manifest)} />
          </div>
        )}
      />
      <FloatingPanelActionPortal action={addSceneAction} active={available.length > 0} />
      {itemNavigationItems.length > 0 && (
        <FloatingPanelContextPortal>
          <AdaptiveControlGroup
            kind="navigation"
            ariaLabel={`${title} items`}
            items={itemNavigationItems}
            presentationOrder={["iconText", "text", "collapsed"]}
          />
        </FloatingPanelContextPortal>
      )}
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            {selectedPath ? (
              (() => {
                const renderer = renderers[selectedPath];
                // Same rule as the file browser: a path the user forced to Raw, or one no
                // renderer accepts, shows its text. Everything else previews.
                const effMode = rawPaths.has(selectedPath) || !renderer ? "raw" : "preview";
                return (
                  <div className="flex h-full min-h-0 flex-col">
                    {/* The file's controls are CHROME, so they live in the panel's
                        top-right corner with the rest of it — not in a body row beneath
                        it. A row here is drawn under the floating islands and its buttons
                        stop being clickable the moment the chrome fades in, which is
                        exactly when the pointer is over the panel. What is left in the
                        body is content; what names and acts on the file is in a corner. */}
                    <FloatingPanelActionPortal
                      action={{
                        id: "view-mode",
                        label: !renderer
                          ? "No matching renderer — raw only"
                          : effMode === "preview"
                            ? `Showing the ${renderer.title} preview — switch to raw`
                            : "Showing raw text — switch to the preview",
                        priority: "primary",
                        icon: effMode === "preview" ? Eye : EyeOff,
                        selected: effMode === "preview",
                        disabled: !renderer,
                        onSelect: () => showRaw(selectedPath, effMode === "preview"),
                      }}
                    />
                    <FloatingPanelActionPortal
                      action={{
                        id: "save-file",
                        label: session.parseError
                          ? `Save ${selectedPath} — the text does not parse`
                          : `Save ${selectedPath}`,
                        priority: "primary",
                        icon: Save,
                        disabled: !session.dirty,
                        onSelect: () => void session.save(),
                      }}
                      active={session.dirty || Boolean(session.parseError)}
                    />
                    {pendingNote && (
                      <AnnotationComposer
                        pending={pendingNote}
                        onCancel={() => setPendingNote(null)}
                        onSubmit={(entry) => {
                          void annotations.add(entry);
                          setPendingNote(null);
                        }}
                      />
                    )}
                    <AnnotationList
                      notes={annotations.notes}
                      text={session.parsedText}
                      onRemove={onRemoveNote}
                      onReveal={(range) => {
                        showRaw(selectedPath, true);
                        setRevealLine(range.start);
                      }}
                    />
                    <div className="min-h-0 flex-1">
                      <ContextPickSurface
                        channelId={ctx.channelId}
                        path={selectedPath}
                        content={session.text}
                        onAdded={(label) => setStatus(`Added ${label} to context`)}
                      >
                        {effMode === "preview" && renderer ? (
                          <RendererHost
                            ctx={ctx}
                            path={selectedPath}
                            renderer={renderer}
                            config={ctx.configs[selectedPath]}
                            session={session}
                            annotations={{ doc: annotations.doc, onAnnotate, onRemove: onRemoveNote }}
                            onFailure={(rendererId, reason) => {
                              setFailedRenderers((current) => ({
                                ...current,
                                [selectedPath]: [...new Set([...(current[selectedPath] ?? []), rendererId])],
                              }));
                              setStatus(`${renderer.title} failed: ${reason}. Switched to a built-in renderer or Raw.`);
                            }}
                          />
                        ) : (
                          <Suspense fallback={<div className="h-full bg-canvas" aria-busy="true" />}>
                            <CodeEditor
                              value={session.text}
                              onChange={session.editText}
                              path={selectedPath}
                              scrollToLine={revealLine}
                              className="h-full min-h-0 overflow-hidden"
                            />
                          </Suspense>
                        )}
                      </ContextPickSurface>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-compact text-content-muted">
                <FileQuestion className="h-5 w-5 text-content-muted" />
                <span>No native items in this scene.</span>
                <span className="max-w-xs text-compact leading-4 text-content-muted">Unsupported files stay hidden here and remain available from Raw.</span>
              </div>
            )}
          </div>
          {/* Bottom strip: the one place nothing floats over. Carries what the file is
              and what state it is in, so neither has to sit under the chrome. */}
          {(selectedPath || status || session.status || annotations.status) && (
            <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2 text-compact">
              {selectedPath && (
                <span className="min-w-0 truncate text-content-muted" title={selectedPath}>{selectedPath}</span>
              )}
              {session.dirty && <span className="flex-shrink-0 text-minimal text-warning-400" title="Unsaved changes">●</span>}
              {session.parseError && (
                <span
                  className="flex-shrink-0 text-minimal text-warning-400"
                  title={`${session.parseError} — the preview is showing the last version that parsed`}
                >
                  syntax error
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-right text-warning-300">
                {status || session.status || annotations.status}
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
