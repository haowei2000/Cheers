import type { SavedAnnotation } from "@/api/annotations";
import toast from "react-hot-toast";
import { useAnnotationSurface } from "@/features/annotations/AnnotationProvider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useContextPickStore,
  usePendingContext,
  workbenchFileContextItem,
} from "@/features/chat/context/contextPick";
import type { WorkbenchContext } from "./context";
import type { FsEntry } from "./fsClient";
import { useFileSession } from "./jsonFile";
import { filterCollaborators } from "./collab";
import { useAnnotations, resolveAnnotation } from "./annotations";
import { inspectableIdLineRange } from "./contextSource";
import type { PendingAnnotation } from "./AnnotationComposer";
import type { LensContextTarget } from "./lens/registry";
import type { TemplateManifest } from "./manifest";
import type { RendererDesc } from "./renderers/registry";
import type { WorkbenchSceneState } from "./WorkbenchDrawer";
import {
  OTHER_SCENE,
  canvasSceneId,
  canvasScenePath,
  isCanvasPath,
  reconcileSceneItems,
  rendererFor,
  readDiscoverableFiles,
} from "./sceneState";

export interface SceneWorkbenchCoordinatorOptions {
  ctx: WorkbenchContext;
  sceneState?: WorkbenchSceneState;
  legacyEnvironment?: string | null;
  templates: TemplateManifest[];
  onAddTab: (collectionId: string, path: string) => Promise<boolean>;
}

export function useSceneWorkbenchCoordinator({
  ctx,
  sceneState,
  legacyEnvironment,
  templates,
  onAddTab,
}: SceneWorkbenchCoordinatorOptions) {
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

  const otherPaths = useMemo(() => {
    const claimed = new Set<string>();
    for (const id of reconciled.order) {
      for (const item of reconciled.items[id] ?? []) claimed.add(item);
    }
    return Object.keys(renderers).filter((path) => !claimed.has(path) && !isCanvasPath(path));
  }, [renderers, reconciled]);

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

  // Shared session for the selected item (Raw edits text, Preview renders data)
  const session = useFileSession(ctx.fs, selectedPath ?? "");

  // Live-push: reload file on server change
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

  // Presence focus broadcast
  useEffect(() => {
    const { sendPresenceFocus, channelId } = ctx;
    if (!sendPresenceFocus) return;
    if (selectedPath) {
      sendPresenceFocus(channelId, { bot_id: "", path: selectedPath });
    } else {
      sendPresenceFocus(channelId, null);
    }
    return () => {
      sendPresenceFocus(channelId, null);
    };
  }, [ctx, selectedPath]);

  const collaborators = useMemo(
    () => filterCollaborators(ctx.workspaceFocus, selectedPath, ctx.currentUserId, ctx.memberNames),
    [ctx.workspaceFocus, selectedPath, ctx.currentUserId, ctx.memberNames]
  );

  // Annotations
  const annotations = useAnnotations(selectedPath ?? "", ctx.channelId);
  const [pendingNote, setPendingNote] = useState<PendingAnnotation | null>(null);
  const onAnnotate = useCallback(
    (target: LensContextTarget, at: { x: number; y: number }) =>
      selectedPath && setPendingNote({ target, path: selectedPath, at }),
    [selectedPath]
  );
  const onRemoveNote = useCallback((id: string) => void annotations.remove(id).catch(error => toast.error(error instanceof Error ? error.message : "Could not delete annotation.")), [annotations]);
  const [isInspectorActive, setIsInspectorActive] = useState(false);
  const [revealLine, setRevealLine] = useState<number | undefined>();

  // Forced raw paths
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
  }, [ctx.openInspectableId, ctx.openTarget, selectedPath, session.path, session.version, session.parsedText, session.status, showRaw]);

  // Keep discovery map in sync with active session
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
  const annotationSurface = useAnnotationSurface();
  const lastAnnotationReveal = useRef<SavedAnnotation | null>(null);
  useEffect(() => {
    const item = annotationSurface?.revealed;
    if (item?.target.kind !== "file" || item.target.path !== selectedPath) return;
    if (lastAnnotationReveal.current === item) return;
    setActiveAnnotationId(item.id);
    if (session.version === null && !session.status) return;
    lastAnnotationReveal.current = item;
    const note = annotations.doc.notes.find(n => n.id === item.id);
    const range = note ? resolveAnnotation(note, session.parsedText) : null;
    if (range) {
      showRaw(selectedPath!, true);
      setRevealLine(range.start);
    }
  }, [annotationSurface?.revealed, selectedPath, annotations.doc, session.parsedText, session.version, session.status, showRaw]);

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

  const addPathToContext = useCallback((path: string) => {
    const item = workbenchFileContextItem(path);
    addContext(ctx.channelId, item);
    setStatus(`Added ${item.label} to context`);
  }, [addContext, ctx.channelId]);

  const addSceneToContext = useCallback((id: string) => {
    const paths = id === OTHER_SCENE ? otherPaths : reconciled.items[id] ?? [];
    const existingPaths = paths.filter((path) => existing.has(path));
    for (const path of existingPaths) addContext(ctx.channelId, workbenchFileContextItem(path));
    if (existingPaths.length) {
      setStatus(`Added ${existingPaths.length} ${existingPaths.length === 1 ? "file" : "files"} to context`);
    }
  }, [otherPaths, reconciled.items, existing, addContext, ctx.channelId]);

  useEffect(() => {
    const target = ctx.openTarget;
    if (!target || !renderers[target]) return;
    const owner = reconciled.order.find((id) => (reconciled.items[id] ?? []).includes(target));
    setActiveScene(owner ?? OTHER_SCENE);
    setSelectedByScene((previous) => ({ ...previous, [owner ?? OTHER_SCENE]: target }));
  }, [ctx.openTarget, renderers, reconciled]);

  const addTabAndSelect = useCallback((path: string) => {
    void onAddTab(activeScene, path).then((added) => {
      if (!added) return;
      setSelectedByScene((previous) => ({ ...previous, [activeScene]: path }));
      localStorage.setItem(`${storagePrefix}.item.${activeScene}`, path);
    });
  }, [activeScene, onAddTab, storagePrefix]);

  return {
    entries,
    loading,
    status,
    setStatus,
    refresh,
    reconciled,
    existing,
    renderers,
    sceneIds,
    activeScene,
    setActiveScene,
    otherPaths,
    activePaths,
    selectedPath,
    selectPath,
    session,
    collaborators,
    annotations,
    pendingNote,
    setPendingNote,
    onAnnotate,
    onRemoveNote,
    isInspectorActive,
    setIsInspectorActive,
    revealLine,
    setRevealLine,
    rawPaths,
    showRaw,
    activeAnnotationId,
    setActiveAnnotationId,
    onSelectAnnotationFile,
    pickedIds,
    addPathToContext,
    addSceneToContext,
    addTabAndSelect,
    failedRenderers,
    setFailedRenderers,
    isNewCollectionOpen,
    setIsNewCollectionOpen,
  };
}
