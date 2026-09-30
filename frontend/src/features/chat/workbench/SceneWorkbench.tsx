import {
  AnnotationIcon,
  CollectionIcon,
} from "@/components/ui/editorial-icons";
import { AdaptiveControlGroup, type AdaptiveControlPresentation } from "@/components/ui/adaptive-control-group";
import { ResponsiveActionButton } from "@/components/ui/responsive-action-button";
import { lazy, Suspense } from "react";
import {
  Crosshair,
  Eye,
  EyeOff,
  FileQuestion,
  Frame,
  Save,
} from "lucide-react";
import { workbenchFileContextItem } from "@/features/chat/context/contextPick";
import type { WorkbenchContext } from "./context";
import { ConflictBanner } from "./collabView";
import { AnnotationComposer, AnnotationsButton } from "./AnnotationBar";
import type { TemplateManifest } from "./manifest";
import { RendererHost } from "./renderers/RendererHost";
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
import { WorkbenchStatusBar } from "./WorkbenchStatusBar";
import { useSceneWorkbenchCoordinator } from "./useSceneWorkbenchCoordinator";

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
  const coord = useSceneWorkbenchCoordinator({
    ctx,
    sceneState,
    legacyEnvironment,
    templates,
    onAddTab,
  });

  const available = templates.filter((template) => !coord.reconciled.order.includes(template.id));
  const title =
    coord.activeScene === OTHER_SCENE
      ? "Other"
      : coord.reconciled.titles[coord.activeScene] ?? templates.find((template) => template.id === coord.activeScene)?.title ?? coord.activeScene;

  const collectionTabs = () => coord.sceneIds.map((id) => {
    const template = templates.find((candidate) => candidate.id === id);
    const meta = metaFor(id, template?.icon);
    const label = id === OTHER_SCENE ? "Other" : coord.reconciled.titles[id] ?? id;
    const contextPaths = (id === OTHER_SCENE ? coord.otherPaths : coord.reconciled.items[id] ?? [])
      .filter((path) => coord.existing.has(path));
    return (
      <SceneTab
        key={id}
        label={label}
        Icon={meta.Icon}
        iconColor={meta.color}
        selected={coord.activeScene === id}
        presentation="iconText"
        onSelect={() => coord.setActiveScene(id)}
        onShowRaw={onShowRaw}
        onAddToContext={() => coord.addSceneToContext(id)}
        contextAdded={contextPaths.length > 0
          && contextPaths.every((path) => coord.pickedIds.has(workbenchFileContextItem(path).id))}
        contextAvailable={contextPaths.length > 0}
      />
    );
  });

  const collectionNavigationItems = coord.sceneIds.map((id) => {
    const canvasPath = canvasScenePath(id);
    const template = templates.find((candidate) => candidate.id === id);
    const meta = canvasPath
      ? { subtitle: "Canvas", Icon: Frame, color: "text-accent-300" }
      : metaFor(id, template?.icon);
    const label = canvasPath
      ? (canvasPath.split("/").pop() ?? canvasPath).replace(/\.canvas\.(ya?ml|json)$/i, "")
      : id === OTHER_SCENE
        ? "Other"
        : coord.reconciled.titles[id] ?? id;
    const contextPaths = (id === OTHER_SCENE ? coord.otherPaths : coord.reconciled.items[id] ?? [])
      .filter((path) => coord.existing.has(path));
    return {
      id,
      label,
      icon: meta.Icon,
      selected: coord.activeScene === id,
      onSelect: () => coord.setActiveScene(id),
      control: (presentation: Exclude<AdaptiveControlPresentation, "collapsed">) => (
        <SceneTab
          label={label}
          Icon={meta.Icon}
          iconColor={meta.color}
          selected={coord.activeScene === id}
          presentation={presentation}
          onSelect={() => coord.setActiveScene(id)}
          onShowRaw={onShowRaw}
          onAddToContext={() => coord.addSceneToContext(id)}
          contextAdded={contextPaths.length > 0
            && contextPaths.every((path) => coord.pickedIds.has(workbenchFileContextItem(path).id))}
          contextAvailable={contextPaths.length > 0}
        />
      ),
    };
  });

  const itemNavigationItems = (canvasScenePath(coord.activeScene) ? [] : coord.activePaths).map((path) => ({
    id: path,
    label: itemTitle(coord.activeScene, path, templates),
    selected: path === coord.selectedPath,
    onSelect: () => coord.selectPath(path),
    control: (presentation: Exclude<AdaptiveControlPresentation, "collapsed">) => (
      <ItemTab
        label={itemTitle(coord.activeScene, path, templates)}
        selected={path === coord.selectedPath}
        presentation={presentation}
        onSelect={() => coord.selectPath(path)}
        onAddToContext={() => coord.addPathToContext(path)}
        contextAdded={coord.pickedIds.has(workbenchFileContextItem(path).id)}
      />
    ),
  }));

  const canAddTab = canAddTabToCollection(coord.reconciled, coord.activeScene);
  const tabCandidates = canAddTab
    ? Object.keys(coord.renderers)
      .filter((path) => !isCanvasPath(path) && !(coord.reconciled.items[coord.activeScene] ?? []).includes(path))
      .sort((a, b) => a.localeCompare(b))
    : [];
  const collectionMenuItems = collectionNavigationItems.map((item) => ({
    id: item.id,
    label: item.label,
    Icon: item.icon,
  }));
  const activeCollectionIcon = collectionMenuItems.find((item) => item.id === coord.activeScene)?.Icon ?? CollectionIcon;

  if (coord.loading && coord.entries.length === 0) {
    return <div className="flex h-full items-center justify-center text-compact text-content-muted">Preparing Workbench…</div>;
  }

  if (!coord.loading && coord.status && coord.entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-regular font-medium text-content-secondary">{coord.status}</div>
        <ResponsiveActionButton
          action="retry"
          context="settings"
          wideLabel="Retry"
          onClick={() => void coord.refresh()}
          controlSize={workbenchControlSize.tab}
          className="rounded-sm bg-control text-content-primary ring-1 ring-inset ring-zinc-300/80 dark:ring-zinc-700/80 hover:bg-control-hover hover:text-content-strong active:bg-control-active"
        />
      </div>
    );
  }

  if (coord.sceneIds.length === 0) {
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
            onClick={() => coord.setIsNewCollectionOpen(true)}
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
          isOpen={coord.isNewCollectionOpen}
          available={available}
          onSelect={(manifest) => void onAddScene(manifest)}
          onLoad={onLoadCollection}
          onClose={() => coord.setIsNewCollectionOpen(false)}
        />
      </div>
    );
  }

  const selectedPath = coord.selectedPath;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FloatingPanelNavigationPortal
        mobile={(
          <div role="tablist" aria-label="Collections" className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-control/80 px-2 py-2">
            {collectionTabs()}
            {available.length > 0 && (
              <AddCollectionControl onOpenNew={() => coord.setIsNewCollectionOpen(true)} />
            )}
          </div>
        )}
      >
        {(availableWidth) => (
          <WorkbenchHierarchyNavigation
            availableWidth={availableWidth}
            collections={collectionMenuItems}
            activeCollection={coord.activeScene}
            collectionTitle={title}
            collectionIcon={activeCollectionIcon}
            hasAvailableTemplates={available.length > 0}
            onSelectCollection={coord.setActiveScene}
            onOpenNew={() => coord.setIsNewCollectionOpen(true)}
            onLoadCollection={onLoadCollection}
            onShowRaw={onShowRaw}
          />
        )}
      </FloatingPanelNavigationPortal>
      {itemNavigationItems.length > 0 && (
        <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-control/80 px-2 py-1.5 bg-panel/50">
          <AdaptiveControlGroup kind="navigation" ariaLabel={`${title} Tabs`} controlSize={workbenchControlSize.tab} items={itemNavigationItems} presentationOrder={["iconText", "collapsed"]} />
          {canAddTab && <AddTabControl candidates={tabCandidates} onSelect={coord.addTabAndSelect} />}
        </div>
      )}
      {/* Floating Panel Action Portals for Chrome Header */}
      {selectedPath && (
        <>
          <FloatingPanelActionPortal
            action={{
              id: "view-mode",
              label: !coord.renderers[selectedPath]
                ? "No matching renderer — raw only"
                : (!coord.rawPaths.has(selectedPath) && coord.renderers[selectedPath])
                  ? `Showing the ${coord.renderers[selectedPath].title} preview — switch to raw`
                  : "Showing raw text — switch to the preview",
              priority: "primary",
              icon: (!coord.rawPaths.has(selectedPath) && coord.renderers[selectedPath]) ? Eye : EyeOff,
              selected: false,
              disabled: !coord.renderers[selectedPath],
              onSelect: () => coord.showRaw(selectedPath, !coord.rawPaths.has(selectedPath)),
            }}
          />
          {coord.renderers[selectedPath] && !coord.rawPaths.has(selectedPath) && (
            <FloatingPanelActionPortal
              action={{
                id: "design-mode",
                label: coord.isInspectorActive ? "Exit Design Mode (Inspector)" : "Design Mode (Inspect & Annotate)",
                priority: "primary",
                icon: Crosshair,
                selected: coord.isInspectorActive,
                onSelect: () => coord.setIsInspectorActive((prev) => !prev),
              }}
            />
          )}
          <FloatingPanelActionPortal
            action={{
              id: "annotations",
              label: coord.annotations.notes.length === 0
                ? `Notes on ${selectedPath}`
                : `${coord.annotations.notes.length} note${coord.annotations.notes.length > 1 ? "s" : ""} on ${selectedPath}`,
              priority: "primary",
              icon: AnnotationIcon,
              control: (
                <AnnotationsButton
                  notes={coord.annotations.notes}
                  allNotes={coord.annotations.doc.notes}
                  currentPath={selectedPath}
                  text={coord.session.parsedText}
                  activeAnnotationId={coord.activeAnnotationId}
                  onSelectAnnotation={coord.setActiveAnnotationId}
                  onRemove={coord.onRemoveNote}
                  onReveal={(range) => {
                    coord.showRaw(selectedPath, true);
                    coord.setRevealLine(range.start);
                  }}
                  onSelectFile={coord.onSelectAnnotationFile}
                  onAddNote={(entry) => void coord.annotations.add(entry)}
                />
              ),
            }}
            active={Boolean(selectedPath || coord.annotations.doc.notes.length > 0)}
          />
          <FloatingPanelActionPortal
            action={{
              id: "save-file",
              label: coord.session.parseError
                ? `Save ${selectedPath} — the text does not parse`
                : `Save ${selectedPath}`,
              priority: "primary",
              icon: Save,
              disabled: !coord.session.dirty,
              onSelect: () => void coord.session.save(),
            }}
            active={coord.session.dirty || Boolean(coord.session.parseError)}
          />
        </>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {coord.activePaths.length === 0 ? (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-compact text-content-muted">
            <FileQuestion className="h-5 w-5 text-content-muted" />
            <span>No native Tabs in this Collection.</span>
            <span className="max-w-xs text-compact leading-4 text-content-muted">
              Unsupported files stay hidden here and remain available from Raw.
            </span>
          </div>
        ) : selectedPath ? (
          (() => {
            const activeRenderer = coord.renderers[selectedPath];
            const effMode = coord.rawPaths.has(selectedPath) || !activeRenderer ? "raw" : "preview";
            return (
              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
                <ConflictBanner conflict={coord.session.conflictNotice} onResolve={coord.session.resolveConflict} />
                {coord.pendingNote && (
                  <AnnotationComposer
                    pending={coord.pendingNote}
                    onCancel={() => coord.setPendingNote(null)}
                    onSubmit={(entry) => {
                      void coord.annotations.add(entry);
                      coord.setPendingNote(null);
                    }}
                  />
                )}
                <div className="min-h-0 flex-1">
                  <ContextPickSurface
                    channelId={ctx.channelId}
                    path={selectedPath}
                    content={coord.session.text}
                    onAdded={(lbl) => coord.setStatus(`Added ${lbl} to context`)}
                  >
                    {effMode === "preview" && activeRenderer ? (
                      <RendererHost
                        ctx={ctx}
                        path={selectedPath}
                        renderer={activeRenderer}
                        config={ctx.configs[selectedPath]}
                        session={coord.session}
                        annotations={{ doc: coord.annotations.doc, onAnnotate: coord.onAnnotate, onRemove: coord.onRemoveNote }}
                        activeAnnotationId={coord.activeAnnotationId}
                        onSelectAnnotation={coord.setActiveAnnotationId}
                        onRevealSource={(line) => { coord.showRaw(selectedPath, true); coord.setRevealLine(line); }}
                        inspectorActive={coord.isInspectorActive}
                        onFormSubmit={(data) => {
                          const summary = Object.entries(data.formData)
                            .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                            .join(", ");
                          ctx.composeMessage?.(`[Action ${data.actionId}] ${summary}`);
                        }}
                        onFailure={(rendererId, reason) => {
                          coord.setFailedRenderers((current) => ({
                            ...current,
                            [selectedPath]: [...new Set([...(current[selectedPath] ?? []), rendererId])],
                          }));
                          coord.setStatus(`${activeRenderer.title} failed: ${reason}. Switched to a built-in renderer or Raw.`);
                        }}
                      />
                    ) : (
                      <Suspense fallback={<div className="h-full bg-canvas" aria-busy="true" />}>
                        <CodeEditor
                          value={coord.session.text}
                          onChange={coord.session.editText}
                          path={selectedPath}
                          scrollToLine={coord.revealLine}
                          notes={coord.annotations.notes}
                          activeAnnotationId={coord.activeAnnotationId}
                          onSelectAnnotation={coord.setActiveAnnotationId}
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

      <WorkbenchStatusBar
        selectedPath={selectedPath}
        dirty={coord.session.dirty}
        saving={coord.session.saving}
        parseError={coord.session.parseError}
        collaborators={coord.collaborators}
        status={coord.status || coord.session.status || coord.annotations.status}
      />

      <NewCollectionDialog
        isOpen={coord.isNewCollectionOpen}
        available={available}
        onSelect={(manifest) => void onAddScene(manifest)}
        onLoad={onLoadCollection}
        onClose={() => coord.setIsNewCollectionOpen(false)}
      />
    </div>
  );
}
