import { Button as UiButton } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { ResponsiveActionButton } from "@/components/ui/responsive-action-button";
import { ControlTrigger } from "@/components/ui/control-trigger";
import { Tip } from "@/components/ui/tip";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, LayoutGrid, Package, Pin } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLaneWindow } from "@/hooks/useLaneWindow";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { GlanceRow, DetailLine } from "@/components/ui/glance-row";
import { cn } from "@/lib/cn";
import { ItemList, WorkbenchItem } from "@/components/ui/item";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { errMsg } from "./jsonFile";
import type { WorkbenchContext } from "./context";
import { getBuiltinEnvironments, WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, validateManifest, type TemplateManifest } from "./manifest";
import { FilePanel } from "./panels/FilePanel";
import { SceneWorkbench } from "./SceneWorkbench";
import { workbenchControlSize } from "./workbench-control";
import { listGlobalTemplates } from "./templatesApi";
import { listPlugins, parsePluginHtml, MAX_PLUGIN_BUNDLE_BYTES, type PluginMeta } from "./sandbox/api";
import { listPersonalPlugins } from "@/lib/desktop";
import researchExample from "./examples/research.json";
import "./lens/builtins";
import "./environments";

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
  /** Navigate the user's view to a `cheers:` locator (the renderer plugins' cheers:open
   *  host API). Owned by ChannelView — it holds every jump surface (workspace dialog,
   *  channel files, this drawer's own deep-link). */
  onOpenLocator?: (uri: string) => void;
  /** Prefill the channel composer (the renderer plugins' cheers:compose host API).
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
    bindings: raw.bindings,
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
// Scenarios come from three places:
//  - GLOBAL templates (DATA, admin-installed, lens-rendered) — shared by every channel
//  - SESSION templates (DATA, temporarily uploaded here, this browser session only)
//  - SERVER-LEVEL plugins (CODE, sandboxed iframe renderers): admin-installed or
//    official (seeded by the gateway release, origin='system')
// Installing global templates / plugins lives in Settings → Workbench extensions (admin);
// the drawer only CONSUMES them, and offers a no-persistence temporary upload to anyone
// (.json template or .html plugin — the plugin dev loop).
function WorkbenchDrawerImpl({ open, onClose, channelId, sendResourceReq, openFilePath, filesTick, onOpenLocator, onCompose }: Props) {
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const [cfg, setCfg] = useState<WbConfig>({});
  const [globalTemplates, setGlobalTemplates] = useState<TemplateManifest[]>([]);
  const [sessionTemplates, setSessionTemplates] = useState<TemplateManifest[]>([]);
  const [serverPlugins, setServerPlugins] = useState<PluginMeta[]>([]);
  const [personalPlugins, setPersonalPlugins] = useState<PluginMeta[]>([]);
  const [sessionPlugins, setSessionPlugins] = useState<PluginMeta[]>([]);
  const [busy, setBusy] = useState(false);
  /** Drag-over highlight — deliberately separate from `busy` (which gates controls). */
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pinMenu, setPinMenu] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  /** Focus request for the browser: a Desk-ref deep link (openFilePath) or the last
   *  activated scenario's first file — whichever happened most recently wins. */
  const [focus, setFocus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    listGlobalTemplates()
      .then((t) => alive && setGlobalTemplates(t))
      .catch(() => {});
    listPlugins()
      .then((p) => alive && setServerPlugins(p))
      .catch(() => {});
    // Desktop only: renderer plugins the user installed on this Mac
    // (~/.cheers/plugins). Each carries its bundle inline, so it renders with no
    // server round-trip — a same-id session/admin plugin still shadows it below.
    listPersonalPlugins()
      .then((ps) => {
        if (!alive) return;
        const metas: PluginMeta[] = [];
        for (const p of ps) {
          try {
            const { id, title, manifest } = parsePluginHtml(p.content);
            metas.push({ plugin_id: id, title, manifest, bundle: p.content, origin: "personal" });
          } catch {
            // A malformed bundle on disk simply isn't offered — don't fail the list.
          }
        }
        setPersonalPlugins(metas);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, fs]);

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

  const bindings = useMemo(() => cfg.bindings ?? {}, [cfg.bindings]);
  const setBinding = useCallback(
    (path: string, rendererId: string | null) => {
      const next = { ...bindings };
      if (rendererId) next[path] = rendererId;
      else delete next[path];
      void writeCfg({ ...cfg, bindings: next });
    },
    [cfg, bindings, writeCfg]
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
          if (!nextBindings[v.file]) nextBindings[v.file] = `builtin:${v.lens}`;
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
    [fs, cfg, writeCfg]
  );

  // Temporary upload: validate a manifest, keep it in THIS session only (never persisted,
  // never shared), and activate it. Activating still seeds the scenario's data files into
  // the channel — that's the point of opening the scenario — but the template DEFINITION
  // is ephemeral. To share a template across channels/users, an admin installs it as a
  // global template in Settings → Workbench extensions.
  const loadTemporary = useCallback(
    (text: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setNotice("Not valid JSON");
        return;
      }
      if (!validateManifest(parsed)) {
        setNotice("Invalid template: missing id/title/views, or references an unknown lens");
        return;
      }
      const m = parsed;
      setSessionTemplates((prev) => [m, ...prev.filter((x) => x.id !== m.id)]);
      void (async () => {
        if (await activate(m))
          setNotice(`Loaded temporarily: ${m.title} (this session only; to share globally go to Settings → Workbench extensions)`);
      })();
    },
    [activate]
  );

  // Temporary plugin: parse the .html's embedded manifest and keep it in THIS session
  // only (bundle inline, never installed) — the plugin dev loop, no admin needed. A
  // same-id session plugin shadows the installed one for this session, so existing
  // bindings transparently resolve to the fresh bundle while you iterate.
  const loadTemporaryPlugin = useCallback((html: string) => {
    const byteLength = new TextEncoder().encode(html).length;
    if (byteLength > MAX_PLUGIN_BUNDLE_BYTES) {
      setNotice("Plugin bundle too large (max 2 MiB)");
      return;
    }
    try {
      const { id, title, manifest } = parsePluginHtml(html);
      setSessionPlugins((prev) => [
        { plugin_id: id, title, manifest, bundle: html, transient: true },
        ...prev.filter((p) => p.plugin_id !== id),
      ]);
      setNotice(
        `Loaded plugin temporarily: ${title} (this session only; to install globally go to Settings → Workbench extensions)`
      );
    } catch (e) {
      setNotice(errMsg(e));
    }
  }, []);

  // One extension entry point, routed by extension: .json => template, .html => plugin.
  const loadExtensionFile = useCallback(
    (file: File) => {
      const name = file.name.toLowerCase();
      if (name.endsWith(".json")) void file.text().then(loadTemporary);
      else if (name.endsWith(".html") || name.endsWith(".htm")) void file.text().then(loadTemporaryPlugin);
      else setNotice("Drop a .json template or a .html/.htm renderer plugin");
    },
    [loadTemporary, loadTemporaryPlugin]
  );

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
  // poll its mtime, so saving in your editor re-loads the plugin in place: the session
  // plugin is replaced, SandboxRenderer sees a new bundle, and the iframe reboots.
  // Chromium-only (Firefox/Safari lack showOpenFilePicker) — the button hides elsewhere
  // and drag-drop remains the universal path.
  const [watching, setWatching] = useState<string | null>(null);
  const watchTimer = useRef<number | null>(null);
  const canWatch = typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";

  const stopWatch = useCallback(() => {
    if (watchTimer.current !== null) {
      window.clearInterval(watchTimer.current);
      watchTimer.current = null;
    }
    setWatching(null);
  }, []);

  const startWatch = useCallback(async () => {
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
            accept: { "text/html": [".html", ".htm"], "application/json": [".json"] },
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
  }, [loadExtensionFile, stopWatch]);

  useEffect(() => stopWatch, [stopWatch]);

  // Session templates first so a temporary upload overrides a same-id global for this session.
  const allEnvs = useMemo(() => {
    const byId = new Map<string, TemplateManifest>();
    for (const e of [...sessionTemplates, ...globalTemplates, ...getBuiltinEnvironments()])
      if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()];
  }, [sessionTemplates, globalTemplates]);

  // Session plugins first: a temporary upload shadows a same-id installed plugin for
  // this session. Dedup at the PluginMeta level — renderer ids are composite
  // (plugin:<pid>:<rid>), so it must happen before renderer expansion.
  // Precedence: session (live dev override) > personal (this Mac) > server
  // (global admin). First writer wins in the dedup, so a temp upload shadows a
  // personal install, which shadows a same-id admin plugin.
  const plugins = useMemo(() => {
    const byId = new Map<string, PluginMeta>();
    for (const p of [...sessionPlugins, ...personalPlugins, ...serverPlugins])
      if (!byId.has(p.plugin_id)) byId.set(p.plugin_id, p);
    return [...byId.values()];
  }, [sessionPlugins, personalPlugins, serverPlugins]);

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
  // Desktop: a draggable/resizable floating window inside the work lane; dragging
  // snaps it to the lane's grid zones.
  const { float, drag } = useLaneWindow("cheers.float.workbench", {
    open,
    spawnKind: "workbench",
  });

  const ctx: WorkbenchContext = useMemo(
    () => ({
      channelId,
      fs,
      sendResourceReq,
      pinned,
      togglePin,
      plugins,
      bindings,
      setBinding,
      configs,
      openTarget: focus,
      filesTick,
      openLocator: onOpenLocator,
      composeMessage: onCompose,
    }),
    [channelId, fs, sendResourceReq, pinned, togglePin, plugins, bindings, setBinding, configs, focus, filesTick, onOpenLocator, onCompose]
  );

  // Desktop: the original card chrome, placed in the work area — hidden (but
  // mounted) while closed so the browser tree/selection state survives.
  // Mobile: the original full-screen overlay sheet.
  const shellClass = isMobile
    ? // z-40: above the z-30 channel header (which otherwise paints over and
      // tap-blocks this sheet's own title bar) but below true modals (z-50) —
      // the band the floating window used to get inline from useWindowDrag.
      `fixed inset-0 z-40 flex flex-col bg-zinc-900/95 backdrop-blur-sm pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] transition-[opacity,transform] duration-200 ${
        open
          ? "opacity-100 translate-x-0 pointer-events-auto"
          : "opacity-0 translate-x-4 pointer-events-none"
      }`
    : float
      ? // Floating window in the lane: `absolute`, capped to the box; a default
        // top-left spot until dragged; drag.style overrides w/h inline.
        cn(
          open ? "flex" : "hidden",
          "absolute max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)]",
          "min-h-0 flex-col rounded-sm shadow-2xl ring-1 ring-black/40 backdrop-blur-sm bg-zinc-900/95 transition-colors",
          !drag.pos && "top-2 left-2",
          minimized ? "w-[300px]" : "w-[560px] h-[75%]",
          dragOver || busy ? "ring-2 ring-amber-500/60" : ""
        )
      : // Fallback (no lane context): a plain docked column.
        cn(
          open ? "flex" : "hidden",
          "min-h-0 flex-col rounded-sm shadow-2xl ring-1 ring-black/40 backdrop-blur-sm bg-zinc-900/95 transition-colors",
          minimized ? "w-[300px] self-start max-h-full" : "w-[560px] h-full",
          dragOver || busy ? "ring-2 ring-amber-500/60" : ""
        );

  // Minimized keeps its dragged spot but sheds the resized size (content-height).
  const shellStyle = float ? (minimized ? drag.posStyle : drag.style) : undefined;

  return (
      <aside
        ref={float ? drag.ref : undefined}
        onPointerDownCapture={float ? drag.toFront : undefined}
        style={shellStyle}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={shellClass}
      >
        <div
          {...(float ? drag.handleProps : {})}
          className="mx-2 mt-2 flex h-11 flex-shrink-0 select-none items-center gap-2 rounded-sm bg-zinc-900/70 px-3"
        >
          <span className="text-regular font-semibold text-content-primary">Workbench</span>
          {!minimized && (
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
                  <UiButton
                    action={pinMenu ? "collapse" : "expand"}
                    content="icon"
                    variant="plain"
                    onClick={() => setPinMenu((o) => !o)}
                    aria-label={`${pinned.length} pinned ${pinned.length === 1 ? "file" : "files"}`}
                    aria-expanded={pinMenu}
                    title="Manage pinned files"
                    className="relative text-warning-400/80 hover:text-warning-300"
                  >
                    <Pin className="h-4 w-4" aria-hidden="true" />
                    <span
                      aria-hidden="true"
                      className="absolute right-0 top-0 min-w-4 rounded-sm bg-amber-400 px-1 text-center text-minimal leading-3 text-content-on-light"
                    >
                      {pinned.length > 9 ? "9+" : pinned.length}
                    </span>
                  </UiButton>
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
          </>
          )}
          {/* design-system-native: file-input */}
<input
            ref={fileRef}
            type="file"
            accept=".json,.html,.htm,application/json,text/html"
            onChange={onPickFile}
            className="hidden"
          />
          <div className="flex-1" />
          <ActionButton
            action={minimized ? "expand" : "collapse"}
            context="toolbar"
            accessibleLabel={minimized ? "Expand Workbench" : "Minimize Workbench"}
            onClick={toggleCollapsed}
            controlSize={workbenchControlSize.chrome}
            className="rounded-sm text-content-primary hover:bg-zinc-800 hover:text-content-strong max-md:hidden"
          />
          <ActionButton action="close" context="windowChrome" accessibleLabel="Close Workbench" onClick={onClose} />
        </div>

        {!minimized && notice && (
          <div className="mx-2 mt-2 flex items-center gap-2 rounded-sm bg-amber-500/10 px-3 py-2 text-compact text-warning-400/90">
            <span className="flex-1">{notice}</span>
            <ActionButton action="close" context="windowChrome" accessibleLabel="Dismiss notice" controlSize={workbenchControlSize.chrome} onClick={() => setNotice(null)} />
          </div>
        )}

        {!minimized && allEnvs.length === 0 && selectedId === null && (
          <div className="mx-2 mt-2 flex flex-shrink-0 items-center gap-2 rounded-sm bg-zinc-900/50 px-3 py-2 text-compact text-content-muted">
            <Package className="w-3.5 h-3.5 text-content-muted flex-shrink-0" />
            <span className="flex-1">
              No scenarios yet — drop a .json template (or .html plugin) here, use "Load extension", or
            </span>
            <UiButton action="create" variant="plain"
              onClick={() => loadTemporary(JSON.stringify(researchExample))}
              controlSize="regular" className="rounded-sm bg-zinc-800 text-content-primary hover:bg-zinc-700 flex-shrink-0"
            >
              Try it now: Research
            </UiButton>
          </div>
        )}

        {/* Minimized: a ViewBoard-style glance (scenario + pinned files) in place
            of the full browser. Clicking a row expands back to the browser. */}
        {minimized && (
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
        {/* Content-first by default: scene → item tabs → renderer. Raw is an explicit
            mode that mounts the complete file tree and editor. */}
        <div className={minimized ? "hidden" : "flex-1 min-h-0 overflow-hidden"}>
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
        {float && !minimized && <ResizeGrip resizeProps={drag.resizeProps} />}
      </aside>
  );
}

// Memoized: skips re-rendering the workbench (and its file tree) on ChannelView's
// per-delta streaming renders; props change only on explicit workbench interactions.
export const WorkbenchDrawer = memo(WorkbenchDrawerImpl);
