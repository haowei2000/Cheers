import { Button as UiButton } from "@/components/ui/button";
import {
  AddContextIcon,
  AnnotationIcon,
  CollectionIcon,
  TabIcon,
} from "@/components/ui/editorial-icons";
import { AdaptiveControlGroup, type AdaptiveControlPresentation } from "@/components/ui/adaptive-control-group";
import { DropdownSelect, type DropdownSelectOption } from "@/components/ui/dropdown-select";
import { Select as UiSelect } from "@/components/ui/select";
import { ResponsiveActionButton } from "@/components/ui/responsive-action-button";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent, type ReactNode } from "react";
import {
  Atom,
  Boxes,
  CheckSquare2,
  Code2,
  Crosshair,
  Eye,
  EyeOff,
  FileQuestion,
  Folder,
  Frame,
  Lock,
  Save,
  Server,
} from "lucide-react";
import { LockOff } from "@/components/ui/slashed-icon";
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
import { AnnotationComposer, AnnotationsButton, type PendingAnnotation } from "./AnnotationBar";
import type { LensContextTarget } from "./lens/registry";
import type { TemplateManifest } from "./manifest";
import { RendererHost } from "./renderers/RendererHost";
import { getRenderer, previewOptions, type RendererDesc } from "./renderers/registry";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";
import { workbenchControlSize } from "./workbench-control";
import {
  FloatingPanelActionPortal,
  FloatingPanelNavigationPortal,
} from "@/components/ui/floating-panel";
import { WorkbenchTabLocator } from "./WorkbenchTabLocator";
import { WorkbenchCardDeck } from "./WorkbenchCardDeck";

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

export function canAddTabToCollection(state: WorkbenchSceneState, collectionId: string): boolean {
  return collectionId !== OTHER_SCENE && !canvasScenePath(collectionId) && state.order.includes(collectionId);
}

export function unclaimedRenderableTabs(paths: string[], state: WorkbenchSceneState): string[] {
  const claimed = new Set(state.order.flatMap((id) => state.items[id] ?? []));
  return paths.filter((path) => !claimed.has(path) && !isCanvasPath(path)).sort((a, b) => a.localeCompare(b));
}

const sceneMeta: Record<string, { subtitle: string; Icon: typeof Code2; color: string }> = {
  "cheers-code-project": { subtitle: "Plan, fix, and ship", Icon: Code2, color: "text-accent-300" },
  "cheers-research-lab": { subtitle: "Experiments and submissions", Icon: Atom, color: "text-research-300" },
  "cheers-task-board": { subtitle: "Turn intent into progress", Icon: CheckSquare2, color: "text-info-300" },
  "cheers-team-ops": { subtitle: "Systems and ownership", Icon: Server, color: "text-warning-300" },
  [OTHER_SCENE]: { subtitle: "Renderable tabs outside Collections", Icon: Boxes, color: "text-category-300" },
};

function metaFor(id: string) {
  return sceneMeta[id] ?? { subtitle: "Native workspace", Icon: CollectionIcon as unknown as typeof Code2, color: "text-content-secondary" };
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
      id: "open-collection",
      label: `Open ${label}`,
      icon: <CollectionIcon className="h-4 w-4" />,
      run: onSelect,
    },
    {
      id: "add-context",
      label: !contextAvailable
        ? "No Collection files to add"
        : contextAdded
          ? "Already added to context"
          : "Add Collection to context",
      icon: <AddContextIcon className="h-4 w-4" />,
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
      className={cn(
        "flex-shrink-0 gap-1 rounded-none border-b-2 bg-transparent ring-0 shadow-none -mb-px transition-colors hover:bg-transparent",
        selected
          ? "border-content-strong text-content-strong font-semibold"
          : "border-transparent text-content-primary hover:text-content-strong",
      )}
      {...contextHandlers}
    >
      {presentation !== "text" && <Icon className={cn("h-4 w-4", selected && iconColor)} />}
      {!iconOnly && <span className="truncate">{label}</span>}
    </UiButton>
  );
}

function AddCollectionControl({
  available,
  onSelect,
  onLoad,
  content = "icon",
}: {
  available: TemplateManifest[];
  onSelect: (manifest: TemplateManifest) => void;
  onLoad: () => void;
  content?: "text" | "icon";
}) {
  return (
    <DropdownSelect
        ariaLabel="Add Collection"
        label="Add Collection"
        leading={<CollectionIcon className="h-4 w-4 text-content-secondary" aria-hidden="true" />}
        content={content}
        options={[]}
        actions={[
          ...available.map((template) => ({
            value: `template:${template.id}`,
            label: template.title,
            leading: <CollectionIcon className="h-4 w-4 text-content-secondary" aria-hidden="true" />,
          })),
          { value: "load-extension", label: "Load .cheers-extension…", leading: <Folder className="h-4 w-4" aria-hidden="true" /> },
        ]}
        onSelect={() => undefined}
        onAction={(value) => {
          if (value === "load-extension") return onLoad();
          const manifest = available.find((candidate) => `template:${candidate.id}` === value);
          if (manifest) onSelect(manifest);
        }}
        placement="up"
        controlSize={workbenchControlSize.tab}
        controlWidth="fill"
        className="flex-shrink-0"
      />
  );
}

function AddTabControl({
  candidates,
  onSelect,
  content = "icon",
}: {
  candidates: string[];
  onSelect: (path: string) => void;
  content?: "text" | "icon";
}) {
  if (!candidates.length) return null;
  return (
    <DropdownSelect
      ariaLabel="Open Tab"
      label="Open Tab"
      leading={<TabIcon className="h-4 w-4 text-content-secondary" aria-hidden="true" />}
      content={content}
      options={[]}
      actions={candidates.map((path) => ({
        value: path,
        label: basename(path),
        leading: <TabIcon className="h-4 w-4 text-content-secondary" aria-hidden="true" />,
      }))}
      onSelect={() => undefined}
      onAction={onSelect}
      placement="up"
      controlSize={workbenchControlSize.tab}
      controlWidth="fill"
      className="flex-shrink-0"
    />
  );
}

function WorkbenchHierarchyNavigation({
  availableWidth,
  collections,
  activeCollection,
  collectionTitle,
  collectionIcon,
  availableTemplates,
  onSelectCollection,
  onAddCollection,
  onLoadCollection,
  onShowRaw,
}: {
  availableWidth: number;
  collections: Array<{ id: string; label: string; Icon: typeof Code2 | ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }> }>;
  activeCollection: string;
  collectionTitle: string;
  collectionIcon: typeof Code2 | ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  availableTemplates: TemplateManifest[];
  onSelectCollection: (id: string) => void;
  onAddCollection: (manifest: TemplateManifest) => void;
  onLoadCollection: () => void;
  onShowRaw: () => void;
}) {
  const textProbe = useRef<HTMLDivElement>(null);
  const [requiredTextWidth, setRequiredTextWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const measure = () => setRequiredTextWidth(textProbe.current?.scrollWidth ?? Number.POSITIVE_INFINITY);
    measure();
    const observer = new ResizeObserver(measure);
    if (textProbe.current) observer.observe(textProbe.current);
    return () => observer.disconnect();
  }, [collections.length, collectionTitle]);
  const iconOnly = availableWidth < requiredTextWidth;
  const CollectionIcon = collectionIcon;

  const collectionActions: DropdownSelectOption[] = [
    ...availableTemplates.map((template) => ({
      value: `add:${template.id}`,
      label: `New ${template.title}`,
      leading: <CollectionIcon className="h-4 w-4" aria-hidden="true" />,
    })),
    { value: "load", label: "Load .cheers-extension…", leading: <Folder className="h-4 w-4" aria-hidden="true" /> },
  ];
  const collectionOptions: DropdownSelectOption[] = [
    ...collections.map(({ id, label }) => ({
      value: `collection:${id}`,
      label,
      leading: <CollectionIcon className="h-4 w-4" aria-hidden="true" />,
    })),
    { value: "raw", label: "Raw workspace files", leading: <Folder className="h-4 w-4" aria-hidden="true" /> },
  ];
  const chooseCollection = (value: string) => {
    if (value === "raw") return onShowRaw();
    onSelectCollection(value.slice("collection:".length));
  };
  const runCollectionAction = (value: string) => {
    if (value === "load") return onLoadCollection();
    if (value.startsWith("add:")) {
      const manifest = availableTemplates.find((candidate) => candidate.id === value.slice(4));
      if (manifest) onAddCollection(manifest);
    }
  };
  const controls = (probe = false, icons = iconOnly) => (
    <div className="flex min-w-0 flex-nowrap items-center gap-1" aria-hidden={probe || undefined}>
      <DropdownSelect
        ariaLabel={`Collection: ${collectionTitle}`}
        label={collectionTitle || "Collections"}
        leading={<CollectionIcon className="h-4 w-4" aria-hidden="true" />}
        content={icons ? "icon" : "text"}
        value={`collection:${activeCollection}`}
        options={collectionOptions}
        onSelect={chooseCollection}
        actions={collectionActions}
        onAction={runCollectionAction}
        placement="up"
        controlWidth="slot"
        className="max-w-64 bg-transparent hover:bg-control/50 text-content-primary hover:text-content-strong"
      />
    </div>
  );

  return (
    <div className="relative min-w-0 max-w-full overflow-hidden">
      {controls()}
      <div {...({ inert: "" } as Record<string, string>)} className="pointer-events-none absolute invisible w-max" ref={textProbe}>{controls(true, false)}</div>
    </div>
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
      icon: <AddContextIcon className="h-4 w-4" />,
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
        "flex-shrink-0 gap-1 rounded-none border-b-2 bg-transparent ring-0 shadow-none -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-700/60 dark:focus-visible:ring-zinc-300/60 hover:bg-transparent",
        selected
          ? "border-content-strong text-content-strong font-semibold"
          : "border-transparent text-content-primary hover:text-content-strong",
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
      {presentation === "icon" ? <TabIcon className="h-4 w-4" aria-hidden="true" /> : label}
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
    icon: <AddContextIcon className="h-4 w-4" />,
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
        icon: <AddContextIcon className="h-4 w-4" />,
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
  onAddTab,
  onLoadCollection,
  onShowRaw,
}: {
  ctx: WorkbenchContext;
  sceneState?: WorkbenchSceneState;
  legacyEnvironment?: string | null;
  templates: TemplateManifest[];
  onAddScene: (manifest: TemplateManifest) => Promise<boolean>;
  onAddTab: (collectionId: string, path: string) => Promise<boolean>;
  onLoadCollection: () => void;
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
  const otherPaths = useMemo(
    () => unclaimedRenderableTabs(Object.keys(renderers), reconciled),
    [renderers, reconciled]
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

  const [isTabLocked, setIsTabLocked] = useState(false);
  const [shakeNonce, setShakeNonce] = useState(0);
  const triggerLockedShake = useCallback(() => setShakeNonce((n) => n + 1), []);

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
    (target: LensContextTarget, at: { x: number; y: number }) =>
      selectedPath && setPendingNote({ target, path: selectedPath, at }),
    [selectedPath]
  );
  const onRemoveNote = useCallback((id: string) => void annotations.remove(id), [annotations]);
  const [isInspectorActive, setIsInspectorActive] = useState(false);
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

  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  useEffect(() => {
    setPendingNote(null);
    setActiveAnnotationId(null);
  }, [selectedPath]);

  const selectPath = useCallback((path: string, sceneId = activeScene) => {
    setSelectedByScene((previous) => ({ ...previous, [sceneId]: path }));
    localStorage.setItem(`${storagePrefix}.item.${sceneId}`, path);
  }, [activeScene, storagePrefix]);

  const onSelectAnnotationFile = useCallback(
    (path: string) => {
      const owner = reconciled.order.find((id) => (reconciled.items[id] ?? []).includes(path));
      const targetScene = owner ?? OTHER_SCENE;
      setActiveScene(targetScene);
      selectPath(path, targetScene);
      showRaw(path, true);
    },
    [reconciled.items, reconciled.order, selectPath, showRaw]
  );

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

  const collectionTabs = () => sceneIds.map((id) => {
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

  const collectionNavigationItems = sceneIds.map((id) => {
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
  const canAddTab = canAddTabToCollection(reconciled, activeScene);
  const tabCandidates = canAddTab
    ? Object.keys(renderers)
      .filter((path) => !isCanvasPath(path) && !(reconciled.items[activeScene] ?? []).includes(path))
      .sort((a, b) => a.localeCompare(b))
    : [];
  const collectionMenuItems = collectionNavigationItems.map((item) => ({
    id: item.id,
    label: item.label,
    Icon: item.icon,
  }));
  const activeCollectionIcon = collectionMenuItems.find((item) => item.id === activeScene)?.Icon ?? CollectionIcon;
  const addTabAndSelect = (path: string) => {
    void onAddTab(activeScene, path).then((added) => {
      if (!added) return;
      setSelectedByScene((previous) => ({ ...previous, [activeScene]: path }));
      localStorage.setItem(`${storagePrefix}.item.${activeScene}`, path);
    });
  };

  if (loading && entries.length === 0) {
    return <div className="flex h-full items-center justify-center text-compact text-content-muted">Preparing Workbench…</div>;
  }

  if (sceneIds.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <CollectionIcon className="h-5 w-5 text-content-muted" />
        <div>
          <div className="text-regular font-medium text-content-secondary">Choose a Collection</div>
          <p className="mt-1 max-w-sm text-compact leading-5 text-content-muted">
            Collections turn workspace data into focused Tabs. Unsupported files remain available in Raw workspace files.
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
            controlSize={workbenchControlSize.tab} className="rounded-sm bg-content-strong text-compact font-medium text-content-on-light outline-none"
          >
            <option value="" disabled>Add a Collection…</option>
            {available.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}
          </UiSelect>
        )}
        <ResponsiveActionButton
          action="upload"
          context="toolbar"
          wideLabel="Load .cheers-extension…"
          onClick={onLoadCollection}
          controlSize={workbenchControlSize.tab}
          className="rounded-sm bg-control text-content-primary ring-1 ring-inset ring-zinc-300/80 dark:ring-zinc-700/80 hover:bg-control-hover hover:text-content-strong active:bg-control-active"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FloatingPanelNavigationPortal
        mobile={(
          <div role="tablist" aria-label="Collections" className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-control/80 px-2 py-2">
            {collectionTabs()}
            <AddCollectionControl available={available} onSelect={(manifest) => void onAddScene(manifest)} onLoad={onLoadCollection} />
          </div>
        )}
      >
        {(availableWidth) => (
          <WorkbenchHierarchyNavigation
            availableWidth={availableWidth}
            collections={collectionMenuItems}
            activeCollection={activeScene}
            collectionTitle={title}
            collectionIcon={activeCollectionIcon}
            availableTemplates={available}
            onSelectCollection={setActiveScene}
            onAddCollection={(manifest) => void onAddScene(manifest)}
            onLoadCollection={onLoadCollection}
            onShowRaw={onShowRaw}
          />
        )}
      </FloatingPanelNavigationPortal>
      {itemNavigationItems.length > 0 && (
        <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-control/80 px-2 py-2 md:hidden">
          <AdaptiveControlGroup kind="navigation" ariaLabel={`${title} Tabs`} controlSize={workbenchControlSize.tab} items={itemNavigationItems} presentationOrder={["iconText", "collapsed"]} />
          {canAddTab && <AddTabControl candidates={tabCandidates} onSelect={addTabAndSelect} />}
        </div>
      )}
      {/* Floating Panel Action Portals for Chrome Header */}
      {selectedPath && (
        <>
          <FloatingPanelActionPortal
            action={{
              id: "lock-tab",
              label: isTabLocked ? "Unlock tab scrolling" : "Lock tab in place",
              priority: "primary",
              icon: isTabLocked ? Lock : LockOff,
              selected: false,
              onSelect: () => {
                setIsTabLocked((prev) => {
                  const next = !prev;
                  if (!next) {
                    setShakeNonce(0);
                  }
                  return next;
                });
              },
            }}
          />
          <FloatingPanelActionPortal
            action={{
              id: "view-mode",
              label: !renderers[selectedPath]
                ? "No matching renderer — raw only"
                : (!rawPaths.has(selectedPath) && renderers[selectedPath])
                  ? `Showing the ${renderers[selectedPath].title} preview — switch to raw`
                  : "Showing raw text — switch to the preview",
              priority: "primary",
              icon: (!rawPaths.has(selectedPath) && renderers[selectedPath]) ? Eye : EyeOff,
              selected: false,
              disabled: !renderers[selectedPath],
              onSelect: () => showRaw(selectedPath, !rawPaths.has(selectedPath)),
            }}
          />
          {renderers[selectedPath] && !rawPaths.has(selectedPath) && (
            <FloatingPanelActionPortal
              action={{
                id: "design-mode",
                label: isInspectorActive ? "Exit Design Mode (Inspector)" : "Design Mode (Inspect & Annotate)",
                priority: "primary",
                icon: Crosshair,
                selected: isInspectorActive,
                onSelect: () => setIsInspectorActive((prev) => !prev),
              }}
            />
          )}
          <FloatingPanelActionPortal
            action={{
              id: "annotations",
              label: annotations.notes.length === 0
                ? `Notes on ${selectedPath}`
                : `${annotations.notes.length} note${annotations.notes.length > 1 ? "s" : ""} on ${selectedPath}`,
              priority: "primary",
              icon: AnnotationIcon,
              control: (
                <AnnotationsButton
                  notes={annotations.notes}
                  allNotes={annotations.doc.notes}
                  currentPath={selectedPath}
                  text={session.parsedText}
                  activeAnnotationId={activeAnnotationId}
                  onSelectAnnotation={setActiveAnnotationId}
                  onRemove={onRemoveNote}
                  onReveal={(range) => {
                    showRaw(selectedPath, true);
                    setRevealLine(range.start);
                  }}
                  onSelectFile={onSelectAnnotationFile}
                  onAddNote={(entry) => void annotations.add(entry)}
                />
              ),
            }}
            active={Boolean(selectedPath || annotations.doc.notes.length > 0)}
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
        </>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {activePaths.length === 0 ? (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-compact text-content-muted">
            <FileQuestion className="h-5 w-5 text-content-muted" />
            <span>No native Tabs in this Collection.</span>
            <span className="max-w-xs text-compact leading-4 text-content-muted">
              Unsupported files stay hidden here and remain available from Raw.
            </span>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-1 overflow-hidden">
            {/* The Minimal Tick-Ruler Locator on the left */}
            <WorkbenchTabLocator
              tabs={activePaths.map((path) => ({
                path,
                label: itemTitle(activeScene, path, templates),
                isDirty: selectedPath === path && session.dirty,
                hasError: selectedPath === path && Boolean(session.parseError),
                hasContext: pickedIds.has(workbenchFileContextItem(path).id),
              }))}
              selectedIndex={Math.max(0, activePaths.indexOf(selectedPath ?? ""))}
              onSelectTab={(path) => selectPath(path)}
              isLocked={isTabLocked}
              shakeNonce={shakeNonce}
              onLockedActionAttempt={triggerLockedShake}
              className="hidden md:flex"
            />

            {/* The Vertical Card-Deck Stream */}
            <WorkbenchCardDeck
              tabs={activePaths.map((path) => ({
                path,
                label: itemTitle(activeScene, path, templates),
                isDirty: selectedPath === path && session.dirty,
                hasError: selectedPath === path && Boolean(session.parseError),
                hasContext: pickedIds.has(workbenchFileContextItem(path).id),
                noteCount: selectedPath === path ? annotations.notes.length : undefined,
                rendererId: renderers[path]?.id,
                rendererTitle: renderers[path]?.title,
                previewSnippet: selectedPath === path ? session.text : contents[path],
              }))}
              selectedPath={selectedPath}
              onSelectTab={selectPath}
              renderActiveCardContent={(path) => {
                const renderer = renderers[path];
                const effMode = rawPaths.has(path) || !renderer ? "raw" : "preview";
                return (
                  <div className="flex h-full min-h-0 flex-col">
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
                    <div className="min-h-0 flex-1">
                      <ContextPickSurface
                        channelId={ctx.channelId}
                        path={path}
                        content={session.text}
                        onAdded={(label) => setStatus(`Added ${label} to context`)}
                      >
                        {effMode === "preview" && renderer ? (
                          <RendererHost
                            ctx={ctx}
                            path={path}
                            renderer={renderer}
                            config={ctx.configs[path]}
                            session={session}
                            annotations={{ doc: annotations.doc, onAnnotate, onRemove: onRemoveNote }}
                            activeAnnotationId={activeAnnotationId}
                            onSelectAnnotation={setActiveAnnotationId}
                            inspectorActive={isInspectorActive}
                            onFormSubmit={(data) => {
                              const summary = Object.entries(data.formData)
                                .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                                .join(", ");
                              ctx.composeMessage?.(`[Action ${data.actionId}] ${summary}`);
                            }}
                            onFailure={(rendererId, reason) => {
                              setFailedRenderers((current) => ({
                                ...current,
                                [path]: [...new Set([...(current[path] ?? []), rendererId])],
                              }));
                              setStatus(`${renderer.title} failed: ${reason}. Switched to a built-in renderer or Raw.`);
                            }}
                          />
                        ) : (
                          <Suspense fallback={<div className="h-full bg-canvas" aria-busy="true" />}>
                            <CodeEditor
                              value={session.text}
                              onChange={session.editText}
                              path={path}
                              scrollToLine={revealLine}
                              notes={annotations.notes}
                              activeAnnotationId={activeAnnotationId}
                              onSelectAnnotation={setActiveAnnotationId}
                              className="h-full min-h-0 overflow-hidden"
                            />
                          </Suspense>
                        )}
                      </ContextPickSurface>
                    </div>
                  </div>
                );
              }}
              onAddToContext={addPathToContext}
              isLocked={isTabLocked}
              shakeNonce={shakeNonce}
              onLockedAttempt={triggerLockedShake}
            />
          </div>
        )}
      </div>

      {/* Bottom strip: carries what the file is and what state it is in */}
      {(selectedPath || status || session.status || annotations.status) && (
        <div className="flex items-center gap-2 border-t border-control/80 bg-panel px-3 py-1 text-compact">
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
    </div>
  );
}
