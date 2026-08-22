import { Button as UiButton } from "@/components/ui/button";
import { DropdownSelect } from "@/components/ui/dropdown-select";
import { MenuOption } from "@/components/ui/menu-option";
import { Select as UiSelect } from "@/components/ui/select";
import { TabOption } from "@/components/ui/tab-option";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Atom,
  Boxes,
  CheckSquare2,
  Code2,
  FileQuestion,
  Folder,
  FolderPlus,
  LayoutGrid,
  Paperclip,
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
import type { TemplateManifest } from "./manifest";
import { RendererHost } from "./renderers/RendererHost";
import { getRenderer, previewOptions, type RendererDesc } from "./renderers/registry";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";
import { workbenchControlSize } from "./workbench-control";
import { FloatingPanelActionPortal, FloatingPanelPrimaryNavigation } from "@/components/ui/floating-panel";

const OTHER_SCENE = "__other__";

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
  compact,
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
  compact: boolean;
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

  return compact ? (
    <TabOption
      ref={surfaceRef}
      label={label}
      leading={<Icon className={cn("h-4 w-4", selected && iconColor)} />}
      selected={selected}
      onClick={onSelect}
      controlSize={workbenchControlSize.tab}
      className="flex-shrink-0"
      {...contextHandlers}
    />
  ) : (
    <MenuOption
      ref={surfaceRef}
      role="tab"
      aria-selected={selected}
      label={label}
      leading={<Icon className={cn("h-4 w-4", selected && iconColor)} />}
      selected={selected}
      onClick={onSelect}
      controlSize={workbenchControlSize.navigation}
      {...contextHandlers}
    />
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
  contextAdded,
  onSelect,
  onAddToContext,
}: {
  label: string;
  selected: boolean;
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
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      controlSize={workbenchControlSize.tab}
      className={cn(
        "relative flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500",
        selected ? "text-accent-300" : "text-content-primary hover:text-content-strong",
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
      {label}
      {selected && <span data-design-system-exempt="progress" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-indigo-500" />}
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
    for (const view of template.views) if (!paths.includes(view.file)) paths.push(view.file);
    items[id] = paths;
  }
  return { version: 1, order, titles, items };
}

function itemTitle(sceneId: string, path: string, templates: TemplateManifest[]) {
  return (
    templates
      .find((template) => template.id === sceneId)
      ?.views.find((view) => view.file === path)?.title ?? fallbackItemTitle(path)
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
  const sceneIds = useMemo(
    () => [...reconciled.order, ...(otherPaths.length ? [OTHER_SCENE] : [])],
    [reconciled.order, otherPaths.length]
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

  useEffect(() => {
    if (!selectedPath || contents[selectedPath] !== undefined) return;
    let alive = true;
    void ctx.fs.read(selectedPath).then((file) => {
      if (alive) setContents((current) => ({ ...current, [selectedPath]: file.content }));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [selectedPath, contents, ctx.fs]);

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

  const sceneTabs = (compact: boolean) => sceneIds.map((id) => {
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
        compact={compact}
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
    const meta = metaFor(id);
    const label = id === OTHER_SCENE ? "Other" : reconciled.titles[id] ?? id;
    const contextPaths = (id === OTHER_SCENE ? otherPaths : reconciled.items[id] ?? [])
      .filter((path) => existing.has(path));
    return {
      id,
      label,
      icon: meta.Icon,
      selected: activeScene === id,
      onSelect: () => setActiveScene(id),
      control: (
        <SceneTab
          label={label}
          Icon={meta.Icon}
          iconColor={meta.color}
          selected={activeScene === id}
          compact
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
    <div className="flex h-full min-h-0 flex-col bg-zinc-950/30">
      <FloatingPanelPrimaryNavigation
        ariaLabel="Scenes"
        items={sceneNavigationItems}
        presentationOrder={["iconText", "collapsed"]}
        mobile={(
          <div role="tablist" aria-label="Scenes" className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-zinc-800/80 px-2 py-2">
            {sceneTabs(true)}
            <AddSceneControl available={available} onSelect={(manifest) => void onAddScene(manifest)} />
          </div>
        )}
      />
      <FloatingPanelActionPortal action={addSceneAction} active={available.length > 0} />
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {activePaths.length > 0 && (
            <nav aria-label={`${title} items`} className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-zinc-800/80 px-2">
              {activePaths.map((path) => {
                const selected = path === selectedPath;
                return (
                  <ItemTab
                    key={path}
                    label={itemTitle(activeScene, path, templates)}
                    selected={selected}
                    onSelect={() => selectPath(path)}
                    onAddToContext={() => addPathToContext(path)}
                    contextAdded={pickedIds.has(workbenchFileContextItem(path).id)}
                  />
                );
              })}
            </nav>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            {selectedPath ? (
              <ContextPickSurface
                channelId={ctx.channelId}
                path={selectedPath}
                content={contents[selectedPath] ?? ""}
                onAdded={(label) => setStatus(`Added ${label} to context`)}
              >
                {renderers[selectedPath] ? (
                  <RendererHost
                    ctx={ctx}
                    path={selectedPath}
                    renderer={renderers[selectedPath]}
                    config={ctx.configs[selectedPath]}
                    onFailure={(rendererId, reason) => {
                      setFailedRenderers((current) => ({
                        ...current,
                        [selectedPath]: [...new Set([...(current[selectedPath] ?? []), rendererId])],
                      }));
                      if (contents[selectedPath] === undefined) {
                        void ctx.fs.read(selectedPath).then((file) =>
                          setContents((current) => ({ ...current, [selectedPath]: file.content }))
                        ).catch(() => undefined);
                      }
                      setStatus(`${renderers[selectedPath].title} failed: ${reason}. Switched to a built-in renderer or Raw.`);
                    }}
                  />
                ) : (
                  <pre className="h-full overflow-auto whitespace-pre-wrap break-words bg-canvas p-4 text-compact text-content-secondary">
                    {contents[selectedPath] ?? "Loading Raw content…"}
                  </pre>
                )}
              </ContextPickSurface>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-compact text-content-muted">
                <FileQuestion className="h-5 w-5 text-content-muted" />
                <span>No native items in this scene.</span>
                <span className="max-w-xs text-compact leading-4 text-content-muted">Unsupported files stay hidden here and remain available from Raw.</span>
              </div>
            )}
          </div>
          {status && <div className="border-t border-zinc-800 px-3 py-2 text-compact text-warning-300">{status}</div>}
        </section>
      </div>
    </div>
  );
}
