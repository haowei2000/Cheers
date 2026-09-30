import { useManagedPanel } from "@/components/ui/managed-panel";
import { ActionButton } from "@/components/ui/action-button";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CollectionIcon } from "@/components/ui/editorial-icons";
import { Folder, Package } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { GlanceRow } from "@/components/ui/glance-row";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { errMsg } from "./jsonFile";
import type { WorkbenchContext } from "./context";
import type { PresenceFocus } from "../hooks/useChatRealtime";
import { WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, viewOf, type TemplateManifest } from "./manifest";
import { FilePanel } from "./panels/FilePanel";
import { SceneWorkbench } from "./SceneWorkbench";
import { listOfficialScenes } from "./extensions/api";
import { useChannelProfile } from "@/hooks/useChannelProfile";
import { panelsFor, type PanelContext } from "@/features/chat/panels/registry";
import "@/features/chat/panels/builtin/githubCode";
import { parsePersonalExtension } from "./extensions/parseOffThread";
import { isPersonalExtensionDisabled } from "./extensions/runtime";
import type { RendererExtension } from "./sandbox/rendererExtension";
import { listPersonalExtensions } from "@/lib/desktop";
import "./lens/builtins";
import { parseLocator } from "../locator";

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
  /** Deep-link: open the browser focused on this path (e.g. a clicked Desk ref). */
  openFilePath?: string;
  /** Live-push tick for the Desk ("files" board): bump → the browser re-pulls the
   *  tree and reloads a clean open file (unsaved edits are never clobbered). */
  filesTick?: number;
  /** Navigate the user's view to a `cheers:` locator (a personal renderer capability
   *  host API). Owned by ChannelView — it holds every jump surface (workspace dialog,
   *  channel files, this drawer's own deep-link). */
  onOpenLocator?: (uri: string) => void;
  /** Prefill the channel composer (a personal renderer capability).
   *  Never sends — owned by ChannelView, which holds the composer. */
  onCompose?: (text: string) => void;
  sendPresenceFocus?: (chanId: string, focus: { bot_id: string; path?: string | null } | null) => void;
  workspaceFocus?: PresenceFocus[];
  currentUserId?: string;
  memberNames?: Record<string, string> | ReadonlyMap<string, string>;
}

export interface WorkbenchSceneState {
  version: 1;
  order: string[];
  titles: Record<string, string>;
  items: Record<string, string[]>;
}

/** Append a tab without disturbing collections or tabs written by another client. */
export function appendCollectionTab(
  state: WorkbenchSceneState | undefined,
  collectionId: string,
  path: string,
): WorkbenchSceneState {
  const current: WorkbenchSceneState = state ?? { version: 1, order: [], titles: {}, items: {} };
  const paths = current.items[collectionId] ?? [];
  if (paths.includes(path)) return current;
  return {
    ...current,
    order: current.order.includes(collectionId) ? [...current.order] : [...current.order, collectionId],
    titles: { ...current.titles },
    items: { ...current.items, [collectionId]: [...paths, path] },
  };
}

export interface WbConfig {
  /** Self-documenting field (regenerated on every write) — for humans/AI reading the file. */
  _doc?: string;
  environment?: string | null;
  pinned?: string[];
  /** path -> renderer id: which renderer Preview uses for a file. */
  bindings?: Record<string, string>;
  /** path -> lens config (e.g. table columns); written create-only by scenario activation. */
  configs?: Record<string, unknown>;
  /** Shared navigation index for native multi-scene clients. Renderer selection remains
   * file-bound through bindings; this does not resurrect template-owned renderers. */
  scene_state?: WorkbenchSceneState;
  /** The channel's shared window arrangement. Owned by `useChannelLayout`, not by this
   *  drawer — carried through the known-keys parse below only so a Workbench write does
   *  not delete a key it has no opinion about. See workbench/sharedLayout.ts. */
  layout?: unknown;
}

// Regenerated into `.workbench.json._doc` on every write, so anyone (human or AI) opening
// the file understands the schema without external docs. NOT a free-form comment — the UI
// rewrites this file, so only fields (like this one) survive; see docs/arch/WORKBENCH.md.
const WB_DOC =
  "Workbench config (per-channel, maintained by the workbench UI, hand-editable). " +
  "The workbench is content-first: scene_state indexes Collection and Tab navigation while Raw workspace files exposes the complete file tree. " +
  "bindings = file path → renderer id Preview uses (unbound: best content match, else raw); " +
  "configs = file path → lens config (e.g. table columns), written by scenario activation; " +
  "pinned = files injected into every bot prompt. " +
  "scene_state = enabled Collection order/titles and their file-path Tab indexes (the key name is retained for compatibility); " +
  "layout = the channel's shared window arrangement (rects are fractions of the lane, not pixels); " +
  "Files themselves are pure content — how a file renders is decided by this config, never written into the file.";

function sceneBelongsToExtension(sceneId: string, extensionId: string): boolean {
  return sceneId.startsWith(`personal:${extensionId}:`) || sceneId.startsWith(`extension:${extensionId}:`);
}

// Known-keys parse + one-time migration: the retired `views` tab list carried each
// scenario view's renderer/config — collapse those into bindings/configs (create-only,
// an explicit binding wins) so pre-refactor channels keep their table/kanban previews.
// The migrated result persists on the next write; the `views` key itself retires.
export function parseCfg(content: string): WbConfig {
  const raw = JSON.parse(content) as WbConfig & {
    views?: { path?: string; renderer?: string; config?: unknown }[];
  };
  const cfg: WbConfig = {
    _doc: raw._doc,
    environment: raw.environment,
    pinned: raw.pinned,
    bindings: raw.bindings
      ? Object.fromEntries(Object.entries(raw.bindings).filter(([, renderer]) => renderer.startsWith("builtin:")))
      : undefined,
    configs: raw.configs,
    scene_state: raw.scene_state,
    layout: raw.layout,
  };
  if (raw.views?.length) {
    const b = { ...(cfg.bindings ?? {}) };
    const c = { ...(cfg.configs ?? {}) };
    for (const v of raw.views) {
      if (!v?.path || !v.renderer) continue;
      if (!b[v.path]) b[v.path] = v.renderer;
      if (v.config !== undefined && c[v.path] === undefined) c[v.path] = v.config;
    }
    cfg.bindings = b;
    cfg.configs = c;
  }
  return cfg;
}

// Right-side per-channel workbench: scenes contain native content tabs; Raw is the
// explicit escape hatch to the complete file browser.
// Scenes come from official, personal, or temporary `.cheers-extension` packages. Only
// personal/temporary macOS packages may contribute sandboxed renderers.
function WorkbenchDrawerImpl({
  open,
  onClose,
  channelId,
  sendResourceReq,
  openFilePath,
  filesTick,
  onOpenLocator,
  onCompose,
  sendPresenceFocus,
  workspaceFocus,
  currentUserId,
  memberNames,
}: Props) {
  const navigate = useNavigate();
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const [cfg, setCfg] = useState<WbConfig>({});
  const profile = useChannelProfile(channelId, open);
  const [globalTemplates, setGlobalTemplates] = useState<TemplateManifest[]>([]);
  const [personalTemplates, setPersonalTemplates] = useState<TemplateManifest[]>([]);
  const [sessionTemplates, setSessionTemplates] = useState<TemplateManifest[]>([]);
  const [personalRendererExtensions, setPersonalRendererExtensions] = useState<RendererExtension[]>([]);
  const [sessionRendererExtensions, setSessionRendererExtensions] = useState<RendererExtension[]>([]);
  const [extensionsRevision, setExtensionsRevision] = useState(0);
  const localBindingKey = `cheers.workbench.personal-bindings.${channelId}`;
  const [localBindings, setLocalBindings] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(localBindingKey) ?? "{}"); } catch { return {}; }
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  /** Focus request for the browser: a Desk-ref deep link (openFilePath) or the last
   *  activated scenario's first file — whichever happened most recently wins. */
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    const changed = () => setExtensionsRevision((revision) => revision + 1);
    const removed = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail.id;
      setSessionTemplates((current) => current.filter((scene) => !sceneBelongsToExtension(scene.id, id)));
      setSessionRendererExtensions((current) => current.filter((extension) => extension.extensionId !== id));
    };
    window.addEventListener("cheers:extensions-changed", changed);
    window.addEventListener("cheers:temporary-extension-removed", removed);
    return () => {
      window.removeEventListener("cheers:extensions-changed", changed);
      window.removeEventListener("cheers:temporary-extension-removed", removed);
    };
  }, []);

  useEffect(() => {
    if (openFilePath) {
      const locator = openFilePath.startsWith("cheers:") ? parseLocator(openFilePath) : null;
      setFocus(locator?.kind === "desk" ? locator.path : openFilePath);
    }
  }, [openFilePath]);
  // Never leak a focus/selection across channels.
  useEffect(() => setFocus(null), [channelId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fs.read(WORKBENCH_CONFIG_PATH)
      .then((f) => alive && setCfg(parseCfg(f.content)))
      .catch(() => alive && setCfg({}));
    listOfficialScenes()
      .then((t) => alive && setGlobalTemplates(t))
      .catch(() => {});
    // Desktop only: personal extensions stored under ~/.cheers/extensions. Renderer
    // assets stay local and need no server round-trip.
    listPersonalExtensions()
      .then((ps) => {
        if (!alive) return;
        return Promise.all(ps.map(parsePersonalExtension)).then((extensions) => {
          if (!alive) return;
          const enabled = extensions.filter((extension) => !isPersonalExtensionDisabled(extension.manifest.id));
          setPersonalRendererExtensions(enabled.flatMap((extension) => extension.rendererExtension ? [extension.rendererExtension] : []));
          setPersonalTemplates(enabled.flatMap((extension) => extension.scenes));
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, fs, channelId, extensionsRevision]);

  useEffect(() => {
    try { setLocalBindings(JSON.parse(localStorage.getItem(localBindingKey) ?? "{}")); }
    catch { setLocalBindings({}); }
  }, [localBindingKey]);

  const writeCfg = useCallback(
    async (next: WbConfig) => {
      const prev = cfg; // snapshot for rollback if the persist fails
      setCfg(next);
      try {
        // strip any stale _doc, regenerate it fresh, pretty-print for human/AI readability
        const { _doc: _drop, ...rest } = next;
        const body = { _doc: WB_DOC, ...rest };
        await fs.write(WORKBENCH_CONFIG_PATH, JSON.stringify(body, null, 2));
      } catch (e) {
        // The optimistic update didn't persist — revert so pins/bindings/scenario
        // don't keep showing as applied while the saved config still holds the old
        // values, and surface why (the notice bar already lives in this drawer).
        // Only revert if our optimistic value is still the current one: a later
        // write that already succeeded must not be clobbered by this stale rollback.
        setCfg((c) => (c === next ? prev : c));
        setNotice(errMsg(e));
      }
    },
    [cfg, fs]
  );

  const pinned = useMemo(() => cfg.pinned ?? [], [cfg.pinned]);
  const togglePin = useCallback(
    (path: string) => {
      const set = new Set(pinned);
      if (set.has(path)) set.delete(path);
      else set.add(path);
      void writeCfg({ ...cfg, pinned: [...set] });
    },
    [cfg, pinned, writeCfg]
  );

  const bindings = useMemo(() => ({ ...(cfg.bindings ?? {}), ...localBindings }), [cfg.bindings, localBindings]);
  const setBinding = useCallback(
    (path: string, rendererId: string | null) => {
      if (rendererId?.startsWith("personal:")) {
        const next = { ...localBindings, [path]: rendererId };
        setLocalBindings(next);
        localStorage.setItem(localBindingKey, JSON.stringify(next));
        const shared = { ...(cfg.bindings ?? {}) }; delete shared[path];
        void writeCfg({ ...cfg, bindings: shared });
      } else {
        const local = { ...localBindings }; delete local[path];
        setLocalBindings(local); localStorage.setItem(localBindingKey, JSON.stringify(local));
        const shared = { ...(cfg.bindings ?? {}) };
        if (rendererId) shared[path] = rendererId; else delete shared[path];
        void writeCfg({ ...cfg, bindings: shared });
      }
    },
    [cfg, localBindings, localBindingKey, writeCfg]
  );

  const configs = useMemo(() => cfg.configs ?? {}, [cfg.configs]);

  // Activate a scenario: seed its starter files, bind each declarative view's lens (+
  // config) to its file — create-only, a user's explicit binding is never overwritten —
  // and merge its `pin` list into cfg.pinned so the scenario's convention files reach
  // every bot prompt with no manual step. Then focus the browser on the first file.
  const activate = useCallback(
    async (manifest: TemplateManifest): Promise<boolean> => {
      setBusy(true);
      try {
        await seedManifest(fs, manifest);
        // Merge against the freshest PERSISTED config, not the render-time snapshot: the
        // mount read may still be in flight (or hold another channel's config), and
        // clobbering existing pins/bindings on that race is worse than a re-read.
        let base = cfg;
        try {
          base = parseCfg((await fs.read(WORKBENCH_CONFIG_PATH)).content);
        } catch {
          /* no config file yet — keep the in-memory snapshot */
        }
        const nextBindings = { ...(base.bindings ?? {}) };
        const nextConfigs = { ...(base.configs ?? {}) };
        for (const item of manifest.items) {
          const path = item.source.path;
          const view = viewOf(item);
          if (view.startsWith("personal:")) {
            setLocalBindings((current) => {
              if (current[path]) return current;
              const next = { ...current, [path]: view };
              localStorage.setItem(localBindingKey, JSON.stringify(next));
              return next;
            });
          } else if (!nextBindings[path] && view !== "auto") nextBindings[path] = view;
          if (item.config !== undefined && nextConfigs[path] === undefined) nextConfigs[path] = item.config;
        }
        const sceneState: WorkbenchSceneState = {
          version: 1,
          order: [...(base.scene_state?.order ?? []).filter((id) => id !== manifest.id), manifest.id],
          titles: { ...(base.scene_state?.titles ?? {}), [manifest.id]: manifest.title },
          items: { ...(base.scene_state?.items ?? {}), [manifest.id]: manifest.items.map((item) => item.source.path) },
        };
        const next: WbConfig = {
          ...base,
          environment: manifest.id,
          bindings: nextBindings,
          configs: nextConfigs,
          scene_state: sceneState,
        };
        if (manifest.pin?.length) next.pinned = [...new Set([...(base.pinned ?? []), ...manifest.pin])];
        await writeCfg(next);
        setFocus(manifest.items[0]?.source.path ?? null);
        return true;
      } catch (e) {
        setNotice(errMsg(e)); // surface mid-seed failures (permission, size limit, dropped WS)
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fs, cfg, writeCfg, localBindingKey]
  );

  const addTab = useCallback(async (collectionId: string, path: string): Promise<boolean> => {
    setBusy(true);
    try {
      // A tab is a shared navigation edit. Merge it into the latest persisted config so
      // a simultaneous pin, renderer binding, or Collection load is never overwritten.
      let base = cfg;
      try {
        base = parseCfg((await fs.read(WORKBENCH_CONFIG_PATH)).content);
      } catch {
        /* no config file yet — keep the in-memory snapshot */
      }
      const nextState = appendCollectionTab(base.scene_state, collectionId, path);
      if (nextState !== base.scene_state) await writeCfg({ ...base, scene_state: nextState });
      setFocus(path);
      return true;
    } catch (error) {
      setNotice(errMsg(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [cfg, fs, writeCfg]);



  // Session templates first so a temporary upload overrides a same-id official template for this session.
  const allEnvs = useMemo(() => {
    const byId = new Map<string, TemplateManifest>();
    for (const e of [...sessionTemplates, ...personalTemplates, ...globalTemplates])
      if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()];
  }, [sessionTemplates, personalTemplates, globalTemplates]);

  // A temporary package shadows a same-id personal extension for the dev loop.
  const rendererExtensions = useMemo(() => {
    const byId = new Map<string, RendererExtension>();
    for (const p of [...sessionRendererExtensions, ...personalRendererExtensions])
      if (!byId.has(p.extensionId)) byId.set(p.extensionId, p);
    return [...byId.values()];
  }, [sessionRendererExtensions, personalRendererExtensions]);

  const selectedId = cfg.environment ?? null;

  // Desktop: the same rounded-sm card, laid out in the channel's work area (real
  // layout space, no drag/float). Minimized = just the title bar (a compact
  // content-height chip in the lane). Mobile: a full-screen sheet so panels are
  // never crushed into a sliver.
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("cheers.float.workbench.min") === "1"
  );
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("cheers.float.workbench.min", c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };
  const managed = useManagedPanel("workbench");
  const minimized = collapsed && !isMobile && !managed;

  const ctx: WorkbenchContext = useMemo(
    () => ({
      active: open,
      channelId,
      profile,
      fs,
      sendResourceReq,
      pinned,
      togglePin,
      rendererExtensions,
      bindings,
      setBinding,
      configs,
      openTarget: focus,
      openInspectableId: (() => {
        const locator = openFilePath?.startsWith("cheers:") ? parseLocator(openFilePath) : null;
        return locator?.kind === "desk" && locator.path === focus ? locator.inspectableId : undefined;
      })(),
      filesTick,
      openLocator: onOpenLocator,
      composeMessage: onCompose,
      sendPresenceFocus,
      workspaceFocus,
      currentUserId,
      memberNames,
    }),
    [
      open,
      channelId,
      profile,
      fs,
      sendResourceReq,
      pinned,
      togglePin,
      rendererExtensions,
      bindings,
      setBinding,
      configs,
      focus,
      openFilePath,
      filesTick,
      onOpenLocator,
      onCompose,
      sendPresenceFocus,
      workspaceFocus,
      currentUserId,
      memberNames,
    ]
  );
  const profilePanels = panelsFor("inline", profile?.profile);
  // Inline panels are ordinary contributions and get the shared PanelContext, not the
  // Workbench's own — its pin/binding/config state belongs to the fs-source body
  // (SceneWorkbench / FilePanel / RendererHost), which are not contributions.
  const panelCtx: PanelContext = useMemo(
    () => ({
      channelId,
      profile,
      sendResourceReq,
      fs,
      visible: open,
      openLocator: onOpenLocator,
      composeMessage: onCompose,
    }),
    [channelId, profile, sendResourceReq, fs, open, onOpenLocator, onCompose]
  );

  // Desktop: the original card chrome, placed in the work area — hidden (but
  // mounted) while closed so the browser tree/selection state survives.
  // Mobile: the original full-screen overlay sheet.
  // Desktop: a draggable/resizable floating window in the work lane. Closed keeps it
  // MOUNTED so the file tree and selection survive; minimized swaps the body for a
  // glance. FloatingPanel owns all of that — see its `open`, `collapsed` and
  // `dropTarget` props. Mobile is a full-screen sheet.
  return (
    <FloatingPanel
      title="Workbench"
      icon={Package}
      onClose={onClose}
      storageKey="cheers.float.workbench"
      open={open}
      collapsed={minimized}
      onToggleCollapsed={toggleCollapsed}
      spawnKind="workbench"
      className="w-[min(960px,calc(100vw-2rem))] h-[min(840px,88%)]"
      defaultPosClassName="top-2 left-2"
      // Collection/Tab navigation and the raw tree own their scrolling; the body is flush.
      bodyClassName="flex flex-col overflow-hidden p-0 space-y-0"
      primaryNavigation={rawMode ? {
        ariaLabel: "Workbench Collections",
        presentationOrder: ["collapsed"],
        collapsedContent: "icon",
        items: [
          { id: "collections", label: "Back to Collections", icon: CollectionIcon, onSelect: () => setRawMode(false) },
          { id: "raw-workspace-files", label: "Raw workspace files", icon: Folder, selected: true, onSelect: () => undefined },
        ],
      } : undefined}
      collapsedSummary={() => (
        <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
          <GlanceRow
            Icon={Package}
            label="Collection"
            value={allEnvs.find((e) => e.id === selectedId)?.title ?? "General"}
            onClick={toggleCollapsed}
            title="Open workbench"
          />
        </div>
      )}
    >
        {notice && (
          <div className="mx-2 mt-2 flex items-center gap-2 rounded-sm bg-amber-500/10 px-3 py-2 text-compact text-warning-400/90">
            <span className="flex-1">{notice}</span>
            <ActionButton action="close" context="windowChrome" accessibleLabel="Dismiss notice" controlSize="compact" onClick={() => setNotice(null)} />
          </div>
        )}

        {allEnvs.length === 0 && selectedId === null && (
          <div className="mx-2 mt-2 flex flex-shrink-0 items-center gap-2 rounded-sm bg-panel/50 px-3 py-2 text-compact text-content-muted">
            <Package className="w-3.5 h-3.5 text-content-muted flex-shrink-0" />
            <span className="flex-1">
              No collections yet. Install one in Settings.
            </span>
            <ActionButton
              action="open"
              context="settings"
              onClick={() => navigate("/settings/workbench")}
              controlSize="regular"
              className="rounded-sm bg-control text-content-primary hover:bg-control-hover flex-shrink-0"
            />
          </div>
        )}
        {/* Content-first by default: Collection → Tab → renderer. Raw is an explicit
            mode that mounts the complete file tree and editor. */}
        <div className={minimized ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-hidden"}>
          {open && profilePanels.map((panel) => <Fragment key={panel.id}>{panel.render(panelCtx)}</Fragment>)}
          <div className="min-h-0 flex-1 overflow-hidden">
            {open && (rawMode ? (
              <FilePanel ctx={ctx} />
            ) : (
              <SceneWorkbench
                ctx={ctx}
                sceneState={cfg.scene_state}
                legacyEnvironment={cfg.environment}
                templates={allEnvs}
                onAddScene={activate}
                onAddTab={addTab}
                onLoadCollection={() => navigate("/settings/workbench")}
                onShowRaw={() => setRawMode(true)}
              />
            ))}
          </div>
        </div>
    </FloatingPanel>
  );
}

// Memoized: skips re-rendering the workbench (and its file tree) on ChannelView's
// per-delta streaming renders; props change only on explicit workbench interactions.
export const WorkbenchDrawer = memo(WorkbenchDrawerImpl);
