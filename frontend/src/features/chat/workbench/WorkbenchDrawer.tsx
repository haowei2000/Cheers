import { ActionButton } from "@/components/ui/action-button";
import { ResponsiveActionButton } from "@/components/ui/responsive-action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { Tip } from "@/components/ui/tip";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Folder, LayoutGrid, Package, Pin } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { FloatingPanel } from "@/components/ui/floating-panel";
import { GlanceRow, DetailLine } from "@/components/ui/glance-row";
import { cn } from "@/lib/cn";
import { ItemList, WorkbenchItem } from "@/components/ui/item";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { errMsg } from "./jsonFile";
import type { WorkbenchContext } from "./context";
import { WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, type TemplateManifest } from "./manifest";
import { FilePanel } from "./panels/FilePanel";
import { SceneWorkbench } from "./SceneWorkbench";
import { workbenchControlSize } from "./workbench-control";
import { listGlobalScenes } from "./extensions/api";
import { useChannelProfile } from "@/hooks/useChannelProfile";
import { panelsFor, type PanelContext } from "@/features/chat/panels/registry";
import "@/features/chat/panels/builtin/githubCode";
import { hasCode, type ParsedExtension } from "./extensions/package";
import { parseExtensionPackageOffThread, parsePersonalExtension } from "./extensions/parseOffThread";
import { ExtensionInstallDialog } from "@/features/workbench/ExtensionInstallDialog";
import type { ExtensionInstallCandidate } from "@/features/workbench/extensionInstall";
import {
  isPersonalExtensionDisabled,
  registerTemporaryExtension,
} from "./extensions/runtime";
import type { RendererExtension } from "./sandbox/rendererExtension";
import { listPersonalExtensions, pickDevelopmentExtension, readDevelopmentExtension } from "@/lib/desktop";
import { isTauri } from "@/lib/serverConfig";
import "./lens/builtins";

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
}

export interface WorkbenchSceneState {
  version: 1;
  order: string[];
  titles: Record<string, string>;
  items: Record<string, string[]>;
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
}

// Regenerated into `.workbench.json._doc` on every write, so anyone (human or AI) opening
// the file understands the schema without external docs. NOT a free-form comment — the UI
// rewrites this file, so only fields (like this one) survive; see docs/arch/WORKBENCH.md.
const WB_DOC =
  "Workbench config (per-channel, maintained by the workbench UI, hand-editable). " +
  "The workbench is content-first: scene_state indexes scene tabs while Raw exposes the complete file tree. " +
  "bindings = file path → renderer id Preview uses (unbound: best content match, else raw); " +
  "configs = file path → lens config (e.g. table columns), written by scenario activation; " +
  "pinned = files injected into every bot prompt. " +
  "scene_state = enabled scenario order/titles and their file-path navigation indexes; " +
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
// Scenes come from global, personal, or temporary `.cheers-extension` packages. Only
// personal/temporary macOS packages may contribute sandboxed renderers.
function WorkbenchDrawerImpl({ open, onClose, channelId, sendResourceReq, openFilePath, filesTick, onOpenLocator, onCompose }: Props) {
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
  /** Drag-over highlight — deliberately separate from `busy` (which gates controls). */
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** A dropped package waiting on consent. `thenActivate` remembers whether the
   * drop was a "open this scenario" gesture, so confirming does what the drop
   * would have done. */
  const [pendingLoad, setPendingLoad] = useState<(ExtensionInstallCandidate & { thenActivate: boolean }) | null>(null);
  const [pinMenu, setPinMenu] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  /** Focus request for the browser: a Desk-ref deep link (openFilePath) or the last
   *  activated scenario's first file — whichever happened most recently wins. */
  const [focus, setFocus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    if (openFilePath) setFocus(openFilePath);
  }, [openFilePath]);
  // Never leak a focus/selection across channels.
  useEffect(() => setFocus(null), [channelId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fs.read(WORKBENCH_CONFIG_PATH)
      .then((f) => alive && setCfg(parseCfg(f.content)))
      .catch(() => alive && setCfg({}));
    listGlobalScenes()
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
        for (const v of manifest.views) {
          const renderer = v.renderer ?? `builtin:${v.lens}`;
          if (renderer.startsWith("personal:")) {
            setLocalBindings((current) => {
              if (current[v.file]) return current;
              const next = { ...current, [v.file]: renderer };
              localStorage.setItem(localBindingKey, JSON.stringify(next));
              return next;
            });
          } else if (!nextBindings[v.file] && renderer !== "auto") nextBindings[v.file] = renderer;
          if (v.config !== undefined && nextConfigs[v.file] === undefined) nextConfigs[v.file] = v.config;
        }
        const sceneState: WorkbenchSceneState = {
          version: 1,
          order: [...(base.scene_state?.order ?? []).filter((id) => id !== manifest.id), manifest.id],
          titles: { ...(base.scene_state?.titles ?? {}), [manifest.id]: manifest.title },
          items: { ...(base.scene_state?.items ?? {}), [manifest.id]: manifest.views.map((view) => view.file) },
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
        setFocus(manifest.views[0]?.file ?? null);
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

  // Temporary upload: validate a manifest, keep it in THIS session only (never persisted,
  // never shared), and activate it. Activating still seeds the scenario's data files into
  // the channel — that's the point of opening the scenario — but the template DEFINITION
  // is ephemeral. To share a template across channels/users, an admin installs it as a
  // global template in Settings → Workbench extensions.
  //
  // On desktop this scope is `temporary`, the one scope that may carry renderer code and
  // `network: unrestricted` — the server refuses to store either. Dropping a file is not
  // consent to run it, so anything with code or a permission goes through the same dialog
  // Settings uses; a purely declarative package activates directly, because a modal with
  // nothing in it teaches people to click through the ones that matter.
  const admit = useCallback(
    (extension: ParsedExtension, notice: string) => {
      registerTemporaryExtension(extension);
      setSessionTemplates((current) => [
        ...extension.scenes,
        ...current.filter((scene) => !sceneBelongsToExtension(scene.id, extension.manifest.id)),
      ]);
      if (extension.rendererExtension) setSessionRendererExtensions((current) => [extension.rendererExtension!, ...current.filter((candidate) => candidate.extensionId !== extension.manifest.id)]);
      setNotice(notice);
    },
    []
  );

  const offer = useCallback(
    (extension: ParsedExtension, sourceLabel: string, thenActivate: boolean) => {
      if (hasCode(extension.manifest)) {
        setPendingLoad({ extension, scope: "temporary", source: "file", sourceLabel, thenActivate });
        return;
      }
      admit(extension, `Loaded temporarily: ${extension.manifest.title}`);
      const first = extension.scenes[0];
      if (thenActivate && first) void activate(first);
    },
    [activate, admit]
  );

  const loadExtensionFile = useCallback(
    (file: File) => {
      if (!file.name.toLowerCase().endsWith(".cheers-extension")) {
        setNotice("Choose a .cheers-extension package");
        return;
      }
      void file.arrayBuffer()
        .then((bytes) => parseExtensionPackageOffThread(bytes, isTauri() ? "temporary" : "global"))
        .then((extension) => offer(extension, file.name, true))
        .catch((reason) => setNotice(errMsg(reason)));
    },
    [offer]
  );

  const loadExtensionBytes = useCallback((bytes: Uint8Array, title: string) => {
    void parseExtensionPackageOffThread(bytes, isTauri() ? "temporary" : "global")
      .then((extension) => offer(extension, title, false))
      .catch((reason) => setNotice(errMsg(reason)));
  }, [offer]);

  const confirmPendingLoad = useCallback(() => {
    if (!pendingLoad) return;
    const { extension, thenActivate } = pendingLoad;
    setPendingLoad(null);
    admit(extension, `Loaded temporarily: ${extension.manifest.title}`);
    const first = extension.scenes[0];
    if (thenActivate && first) void activate(first);
  }, [pendingLoad, activate, admit]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) loadExtensionFile(file);
    },
    [loadExtensionFile]
  );

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) loadExtensionFile(file);
      e.target.value = "";
    },
    [loadExtensionFile]
  );

  // ---- Hot reload: watch the extension file on disk and re-load it on every save ----
  // The dev loop used to be "edit, drag the file in again" — dozens of round trips while
  // tuning a renderer's UI. With the File System Access API we keep the picked handle and
  // poll its mtime, so saving in your editor reloads the extension in place: the session
  // renderer is replaced, SandboxRenderer sees a new bundle, and the iframe reboots.
  // Chromium-only (Firefox/Safari lack showOpenFilePicker) — the button hides elsewhere
  // and drag-drop remains the universal path.
  const [watching, setWatching] = useState<string | null>(null);
  const watchTimer = useRef<number | null>(null);
  const canWatch = isTauri() || typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";

  const stopWatch = useCallback(() => {
    if (watchTimer.current !== null) {
      window.clearInterval(watchTimer.current);
      watchTimer.current = null;
    }
    setWatching(null);
  }, []);

  const startWatch = useCallback(async () => {
    if (isTauri()) {
      const selected = await pickDevelopmentExtension();
      if (!selected) return;
      const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
      let lastSeen = selected.sha256;
      loadExtensionBytes(decode(selected.contentBase64), selected.id);
      setWatching(selected.path.split("/").pop() ?? selected.id);
      if (watchTimer.current !== null) window.clearInterval(watchTimer.current);
      watchTimer.current = window.setInterval(() => {
        void readDevelopmentExtension(selected.path)
          .then((next) => {
            if (next.sha256 === lastSeen) return;
            lastSeen = next.sha256;
            loadExtensionBytes(decode(next.contentBase64), next.id);
          })
          .catch(() => { stopWatch(); setNotice("Stopped watching: the package is no longer readable"); });
      }, 1000);
      return;
    }
    interface PickedFile {
      getFile: () => Promise<File>;
    }
    const pick = (window as unknown as {
      showOpenFilePicker: (o: unknown) => Promise<PickedFile[]>;
    }).showOpenFilePicker;
    let handle: PickedFile;
    try {
      const [h] = await pick({
        multiple: false,
        types: [
          {
            description: "Workbench extension",
            accept: { "application/vnd.cheers.extension+zip": [".cheers-extension"] },
          },
        ],
      });
      if (!h) return;
      handle = h;
    } catch {
      return; // user dismissed the picker
    }
    const first = await handle.getFile();
    let lastSeen = first.lastModified;
    loadExtensionFile(first);
    setWatching(first.name);
    if (watchTimer.current !== null) window.clearInterval(watchTimer.current);
    watchTimer.current = window.setInterval(() => {
      void handle
        .getFile()
        .then((f) => {
          if (f.lastModified === lastSeen) return;
          lastSeen = f.lastModified;
          loadExtensionFile(f);
        })
        .catch(() => {
          // The file was moved/deleted, or permission lapsed — stop rather than spin.
          stopWatch();
          setNotice("Stopped watching: the file is no longer readable");
        });
    }, 1000);
  }, [loadExtensionFile, loadExtensionBytes, stopWatch]);

  useEffect(() => stopWatch, [stopWatch]);

  // Session templates first so a temporary upload overrides a same-id global for this session.
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
  const minimized = collapsed && !isMobile;

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
      filesTick,
      openLocator: onOpenLocator,
      composeMessage: onCompose,
    }),
    [open, channelId, profile, fs, sendResourceReq, pinned, togglePin, rendererExtensions, bindings, setBinding, configs, focus, filesTick, onOpenLocator, onCompose]
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
      className="w-[560px] h-[75%]"
      defaultPosClassName="top-2 left-2"
      // Scene tabs / raw tree own their own scrolling; the body is a flush column.
      bodyClassName="flex flex-col overflow-hidden p-0 space-y-0"
      // Dropping a .cheers-extension anywhere on the panel loads it (after consent).
      dropTarget={{
        active: dragOver || busy,
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop,
      }}
      headerExtra={
        <>
          <Tip content={rawMode ? "Return to scene tabs" : "Browse every workspace file"}>
            <ControlTrigger
              type="button"
              square
              onClick={() => setRawMode((current) => !current)}
              aria-label={rawMode ? "Show scenes" : "Show raw workspace files"}
              aria-pressed={rawMode}
              title={rawMode ? "Show scenes" : "Show raw workspace files"}
              controlSize={workbenchControlSize.toolbar} className={cn(
 "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
 rawMode
 ? "bg-indigo-500/15 text-accent-200": "bg-zinc-800/70 text-content-primary hover:bg-zinc-800 hover:text-content-strong"
 )}
            >
              {rawMode ? <LayoutGrid className="h-4 w-4" aria-hidden="true" /> : <Folder className="h-4 w-4" aria-hidden="true" />}
            </ControlTrigger>
          </Tip>
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Tip
              content="Load a temporary template or renderer extension for this session."
              className="flex min-w-0 flex-1"
            >
              <ResponsiveActionButton
                action="upload"
                context="toolbar"
                wideLabel="Load extension"
                controlSize={workbenchControlSize.toolbar}
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                aria-label="Load template or extension"
                title="Load template or extension"
                containerClassName="min-w-0 flex-1"
                className="text-content-primary hover:text-content-strong disabled:opacity-50"
              />
            </Tip>
            {canWatch &&
              (watching ? (
                <Tip
                  content="Stop watching the current extension file."
                  className="flex min-w-0 flex-1"
                >
                  <ResponsiveActionButton
                    action="stop"
                    context="toolbar"
                    wideLabel="Stop watching"
                    controlSize={workbenchControlSize.toolbar}
                    onClick={stopWatch}
                    aria-label={`Stop watching ${watching}`}
                    title="Stop watching extension"
                    containerClassName="min-w-0 flex-1"
                    className="text-success-400 hover:text-success-300"
                  />
                </Tip>
              ) : (
                <Tip
                  content="Watch an extension file and reload it after every editor save."
                  className="flex min-w-0 flex-1"
                >
                  <ResponsiveActionButton
                    action="watch"
                    context="toolbar"
                    wideLabel="Watch extension"
                    controlSize={workbenchControlSize.toolbar}
                    onClick={() => void startWatch()}
                    disabled={busy}
                    aria-label="Watch an extension file on disk"
                    title="Watch extension file"
                    containerClassName="min-w-0 flex-1"
                    className="text-content-primary hover:text-content-strong disabled:opacity-50"
                  />
                </Tip>
              ))}
            {pinned.length > 0 && (
              <div className="relative">
                <Tip content="Manage files pinned into every prompt.">
                  <div className="relative inline-flex">
                    <ActionButton
                      action="pin"
                      context="toolbar"
                      onClick={() => setPinMenu((o) => !o)}
                      aria-label={`${pinned.length} pinned ${pinned.length === 1 ? "file" : "files"}`}
                      aria-expanded={pinMenu}
                      title="Manage pinned files"
                      className="relative text-warning-400/80 hover:text-warning-300"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute right-0 top-0 min-w-4 rounded-sm bg-amber-400 px-1 text-center text-minimal leading-3 text-content-on-light"
                    >
                      {pinned.length > 9 ? "9+" : pinned.length}
                    </span>
                  </div>
                </Tip>
                {pinMenu && (
                  <div className="absolute left-0 top-6 z-50 w-64 rounded-sm bg-zinc-900 p-1 shadow-xl shadow-black/40">
                    <div className="px-2 py-1 text-minimal uppercase tracking-section text-content-muted">
                      Pinned (injected into every prompt)
                    </div>
                    <ItemList presentationLevel="minimal" controlSize="compact">
                      {pinned.map((p) => (
                        <WorkbenchItem
                          key={p}
                          title={p}
                          controlSize="compact"
                          actions={(
                            <ActionButton
                              action="unpin"
                              context="toolbar"
                              aria-label={`Unpin ${p}`}
                              onClick={() => togglePin(p)}
                              title="Unpin"
                              className="flex-shrink-0 text-content-primary hover:text-danger-400"
                            />
                          )}
                          className="border-0"
                        />
                      ))}
                    </ItemList>
                  </div>
                )}
              </div>
            )}
          </div>
          {/* design-system-native: file-input */}
<input
            ref={fileRef}
            aria-label="Choose a temporary extension package"
            type="file"
            accept=".cheers-extension,application/vnd.cheers.extension+zip"
            onChange={onPickFile}
            className="hidden"
          />
        </>
      }
      collapsedSummary={() => (
        <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
            <GlanceRow
              Icon={Package}
              label="Scenario"
              value={allEnvs.find((e) => e.id === selectedId)?.title ?? "General"}
              onClick={toggleCollapsed}
              title="Open workbench"
            />
            <GlanceRow
              Icon={Pin}
              label="Pinned"
              value={String(pinned.length)}
              onClick={toggleCollapsed}
            >
              {pinned.slice(0, 4).map((p) => (
                <DetailLine key={p} name={p.split("/").pop() || p} />
              ))}
              {pinned.length > 4 && <DetailLine name={`+${pinned.length - 4} more`} />}
            </GlanceRow>
          </div>
      )}
    >
        {pendingLoad && (
          <ExtensionInstallDialog
            candidate={pendingLoad}
            busy={false}
            onConfirm={confirmPendingLoad}
            onClose={() => setPendingLoad(null)}
          />
        )}

        {notice && (
          <div className="mx-2 mt-2 flex items-center gap-2 rounded-sm bg-amber-500/10 px-3 py-2 text-compact text-warning-400/90">
            <span className="flex-1">{notice}</span>
            <ActionButton action="close" context="windowChrome" accessibleLabel="Dismiss notice" controlSize={workbenchControlSize.chrome} onClick={() => setNotice(null)} />
          </div>
        )}

        {allEnvs.length === 0 && selectedId === null && (
          <div className="mx-2 mt-2 flex flex-shrink-0 items-center gap-2 rounded-sm bg-zinc-900/50 px-3 py-2 text-compact text-content-muted">
            <Package className="w-3.5 h-3.5 text-content-muted flex-shrink-0" />
            <span className="flex-1">
              No scenes yet. Load a .cheers-extension package or install one in Settings.
            </span>
            <ActionButton
              action="open"
              context="settings"
              onClick={() => navigate("/settings/workbench")}
              controlSize="regular"
              className="rounded-sm bg-zinc-800 text-content-primary hover:bg-zinc-700 flex-shrink-0"
            />
          </div>
        )}
        {/* Content-first by default: scene → item tabs → renderer. Raw is an explicit
            mode that mounts the complete file tree and editor. */}
        <div className={minimized ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-hidden"}>
          {open && profilePanels.map((panel) => <div key={panel.id}>{panel.render(panelCtx)}</div>)}
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
