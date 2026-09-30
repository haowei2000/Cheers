import {
  AnnotationIcon,
  CollectionIcon,
} from "@/components/ui/editorial-icons";
import { AdaptiveControlGroup, type AdaptiveControlPresentation } from "@/components/ui/adaptive-control-group";
import { ResponsiveActionButton } from "@/components/ui/responsive-action-button";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Crosshair,
  Eye,
  EyeOff,
  FileQuestion,
  Frame,
  Save,
} from "lucide-react";
import {
  useContextPickStore,
  usePendingContext,
  workbenchFileContextItem,
} from "@/features/chat/context/contextPick";
import type { WorkbenchContext } from "./context";
import type { FsEntry } from "./fsClient";
import { useFileSession } from "./jsonFile";
import { filterCollaborators } from "./collab";
import { CollaboratorPills, ConflictBanner } from "./collabView";
import { useAnnotations } from "./annotations";
import { inspectableIdLineRange } from "./contextSource";
import { AnnotationComposer, AnnotationsButton, type PendingAnnotation } from "./AnnotationBar";
import type { LensContextTarget } from "./lens/registry";
import type { TemplateManifest } from "./manifest";
import { RendererHost } from "./renderers/RendererHost";
import type { RendererDesc } from "./renderers/registry";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";
import { workbenchControlSize } from "./workbench-control";
import {
  FloatingPanelActionPortal,
  FloatingPanelNavigationPortal,
} from "@/components/ui/floating-panel";
import { ContextPickSurface } from "./ContextPickSurface";
import {
  CANVAS_SCENE,
  OTHER_SCENE,
  canvasSceneId,
  canvasScenePath,
  isCanvasPath,
  canAddTabToCollection,
  unclaimedRenderableTabs,
  reconcileSceneItems,
  metaFor,
  sceneTabContextActions,
  itemTitle,
  rendererFor,
  readDiscoverableFiles,
  type SceneIconComponent,
} from "./sceneState";
import {
  SceneTab,
  AddCollectionControl,
  NewCollectionDialog,
  AddTabControl,
  WorkbenchHierarchyNavigation,
  ItemTab,
} from "./SceneNavigation";

// Re-export domain items so existing callers remain backward-compatible
export {
  CANVAS_SCENE,
  OTHER_SCENE,
  canvasSceneId,
  canvasScenePath,
  isCanvasPath,
  canAddTabToCollection,
  unclaimedRenderableTabs,
  reconcileSceneItems,
  metaFor,
  sceneTabContextActions,
  type SceneIconComponent,
};

const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

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
  const [isNewCollectionOpen, setIsNewCollectionOpen] = useState(false);
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

  // Live-push: Desk files changed on the server (bot finished writing or teammate saved).
  // Reload the open file in place with automatic 3-way non-destructive merge.
  const filesTick = ctx.filesTick ?? 0;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const seenFilesTick = useRef(filesTick);
  useEffect(() => {
    if (filesTick === seenFilesTick.current) return;
    seenFilesTick.current = filesTick;
    void refresh();
    if (!selectedPath) return;
    void sessionRef.current.reload(true);
  }, [filesTick, refresh, selectedPath]);

  // Broadcast presence focus so other clients and bots see who is viewing/editing this item.
  useEffect(() => {
    if (!ctx.sendPresenceFocus) return;
    if (selectedPath) {
      ctx.sendPresenceFocus(ctx.channelId, { bot_id: "", path: selectedPath });
    } else {
      ctx.sendPresenceFocus(ctx.channelId, null);
    }
    return () => {
      ctx.sendPresenceFocus?.(ctx.channelId, null);
    };
  }, [ctx.sendPresenceFocus, ctx.channelId, selectedPath]);

  const collaborators = useMemo(
    () => filterCollaborators(ctx.workspaceFocus, selectedPath, ctx.currentUserId, ctx.memberNames),
    [ctx.workspaceFocus, selectedPath, ctx.currentUserId, ctx.memberNames]
  );

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
  const revealedCard = useRef<string | null>(null);
  useEffect(() => {
    const id = ctx.openInspectableId;
    if (!id) { revealedCard.current = null; return; }
    if (!selectedPath || selectedPath !== ctx.openTarget || session.path !== selectedPath || session.version === null) return;
    const key = `${selectedPath}#^${id}`;
    if (revealedCard.current === key) return;
    const range = inspectableIdLineRange(session.parsedText, id);
    if (!range) return;
    revealedCard.current = key;
    showRaw(selectedPath, true);
    setRevealLine(range.start);
  }, [ctx.openInspectableId, ctx.openTarget, selectedPath, session.path, session.version, session.parsedText, showRaw]);

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
    const template = templates.find((candidate) => candidate.id === id);
    const meta = metaFor(id, template?.icon);
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
    const template = templates.find((candidate) => candidate.id === id);
    const meta = canvasPath
      ? { subtitle: "Canvas", Icon: Frame, color: "text-accent-300" }
      : metaFor(id, template?.icon);
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

  if (!loading && status && entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-regular font-medium text-content-secondary">{status}</div>
        <ResponsiveActionButton
          action="retry"
          context="settings"
          wideLabel="Retry"
          onClick={() => void refresh()}
          controlSize={workbenchControlSize.tab}
          className="rounded-sm bg-control text-content-primary ring-1 ring-inset ring-zinc-300/80 dark:ring-zinc-700/80 hover:bg-control-hover hover:text-content-strong active:bg-control-active"
        />
      </div>
    );
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
          <ResponsiveActionButton
            action="add"
            context="toolbar"
            wideLabel="New Collection…"
            onClick={() => setIsNewCollectionOpen(true)}
            controlSize={workbenchControlSize.tab}
            className="rounded-sm bg-control text-content-primary ring-1 ring-inset ring-zinc-300/80 dark:ring-zinc-700/80 hover:bg-control-hover hover:text-content-strong active:bg-control-active"
          />
        )}
        <ResponsiveActionButton
          action="upload"
          context="toolbar"
          wideLabel="Load .cheers-extension…"
          onClick={onLoadCollection}
          controlSize={workbenchControlSize.tab}
          className="rounded-sm bg-control text-content-primary ring-1 ring-inset ring-zinc-300/80 dark:ring-zinc-700/80 hover:bg-control-hover hover:text-content-strong active:bg-control-active"
        />
        <NewCollectionDialog
          isOpen={isNewCollectionOpen}
          available={available}
          onSelect={(manifest) => void onAddScene(manifest)}
          onLoad={onLoadCollection}
          onClose={() => setIsNewCollectionOpen(false)}
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
            {available.length > 0 && (
              <AddCollectionControl onOpenNew={() => setIsNewCollectionOpen(true)} />
            )}
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
            hasAvailableTemplates={available.length > 0}
            onSelectCollection={setActiveScene}
            onOpenNew={() => setIsNewCollectionOpen(true)}
            onLoadCollection={onLoadCollection}
            onShowRaw={onShowRaw}
          />
        )}
      </FloatingPanelNavigationPortal>
      {itemNavigationItems.length > 0 && (
        <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-control/80 px-2 py-1.5 bg-panel/50">
          <AdaptiveControlGroup kind="navigation" ariaLabel={`${title} Tabs`} controlSize={workbenchControlSize.tab} items={itemNavigationItems} presentationOrder={["iconText", "collapsed"]} />
          {canAddTab && <AddTabControl candidates={tabCandidates} onSelect={addTabAndSelect} />}
        </div>
      )}
      {/* Floating Panel Action Portals for Chrome Header */}
      {selectedPath && (
        <>
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
        ) : selectedPath ? (
          (() => {
            const activeRenderer = renderers[selectedPath];
            const effMode = rawPaths.has(selectedPath) || !activeRenderer ? "raw" : "preview";
            return (
              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
                <ConflictBanner conflict={session.conflictNotice} onResolve={session.resolveConflict} />
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
                    path={selectedPath}
                    content={session.text}
                    onAdded={(label) => setStatus(`Added ${label} to context`)}
                  >
                    {effMode === "preview" && activeRenderer ? (
                      <RendererHost
                        ctx={ctx}
                        path={selectedPath}
                        renderer={activeRenderer}
                        config={ctx.configs[selectedPath]}
                        session={session}
                        annotations={{ doc: annotations.doc, onAnnotate, onRemove: onRemoveNote }}
                        activeAnnotationId={activeAnnotationId}
                        onSelectAnnotation={setActiveAnnotationId}
                        onRevealSource={(line) => { showRaw(selectedPath, true); setRevealLine(line); }}
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
                            [selectedPath]: [...new Set([...(current[selectedPath] ?? []), rendererId])],
                          }));
                          setStatus(`${activeRenderer.title} failed: ${reason}. Switched to a built-in renderer or Raw.`);
                        }}
                      />
                    ) : (
                      <Suspense fallback={<div className="h-full bg-canvas" aria-busy="true" />}>
                        <CodeEditor
                          value={session.text}
                          onChange={session.editText}
                          path={selectedPath}
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
          })()
        ) : null}
      </div>

      {/* Bottom strip: carries what the file is and what state it is in */}
      {(selectedPath || status || session.status || annotations.status || collaborators.length > 1) && (
        <div className="flex items-center gap-2 border-t border-control/80 bg-panel px-3 py-1 text-compact">
          {selectedPath && (
            <span className="min-w-0 truncate text-content-muted" title={selectedPath}>{selectedPath}</span>
          )}
          {session.dirty && <span className="flex-shrink-0 text-minimal text-warning-400" title="Unsaved changes">●</span>}
          {session.saving && <span className="flex-shrink-0 text-minimal text-content-muted animate-pulse">Saving…</span>}
          {session.parseError && (
            <span
              className="flex-shrink-0 text-minimal text-warning-400"
              title={`${session.parseError} — the preview is showing the last version that parsed`}
            >
              syntax error
            </span>
          )}
          <CollaboratorPills collaborators={collaborators} />
          <span className="min-w-0 flex-1 truncate text-right text-warning-300">
            {status || session.status || annotations.status}
          </span>
        </div>
      )}
      <NewCollectionDialog
        isOpen={isNewCollectionOpen}
        available={available}
        onSelect={(manifest) => void onAddScene(manifest)}
        onLoad={onLoadCollection}
        onClose={() => setIsNewCollectionOpen(false)}
      />
    </div>
  );
}
