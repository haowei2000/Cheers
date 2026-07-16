import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Maximize2, Minimize2, Package, Pin, X } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLaneWindow } from "@/hooks/useLaneWindow";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { GlanceRow, DetailLine } from "@/components/ui/glance-row";
import { cn } from "@/lib/cn";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { errMsg } from "./jsonFile";
import type { WorkbenchContext } from "./context";
import { getBuiltinEnvironments, WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, validateManifest, type TemplateManifest } from "./manifest";
import { FilePanel } from "./panels/FilePanel";
import { listGlobalTemplates } from "./templatesApi";
import { listPlugins, parsePluginHtml, MAX_PLUGIN_BUNDLE_BYTES, type PluginMeta } from "./sandbox/api";
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
}

interface WbConfig {
  /** Self-documenting field (regenerated on every write) — for humans/AI reading the file. */
  _doc?: string;
  environment?: string | null;
  pinned?: string[];
  /** path -> renderer id: which renderer Preview uses for a file. */
  bindings?: Record<string, string>;
  /** path -> lens config (e.g. table columns); written create-only by scenario activation. */
  configs?: Record<string, unknown>;
}

// Regenerated into `.workbench.json._doc` on every write, so anyone (human or AI) opening
// the file understands the schema without external docs. NOT a free-form comment — the UI
// rewrites this file, so only fields (like this one) survive; see docs/arch/WORKBENCH.md.
const WB_DOC =
  "Workbench config (per-channel, maintained by the workbench UI, hand-editable). " +
  "The workbench is file-centric: pick a file, Preview renders it, Raw edits it. " +
  "bindings = file path → renderer id Preview uses (unbound: best content match, else raw); " +
  "configs = file path → lens config (e.g. table columns), written by scenario activation; " +
  "pinned = files injected into every bot prompt. " +
  "Files themselves are pure content — how a file renders is decided by this config, never written into the file.";

// Known-keys parse + one-time migration: the retired `views` tab list carried each
// scenario view's renderer/config — collapse those into bindings/configs (create-only,
// an explicit binding wins) so pre-refactor channels keep their table/kanban previews.
// The migrated result persists on the next write; the `views` key itself retires.
function parseCfg(content: string): WbConfig {
  const raw = JSON.parse(content) as WbConfig & {
    views?: { path?: string; renderer?: string; config?: unknown }[];
  };
  const cfg: WbConfig = {
    _doc: raw._doc,
    environment: raw.environment,
    pinned: raw.pinned,
    bindings: raw.bindings,
    configs: raw.configs,
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

// Right-side per-channel workbench: a scenario picker over ONE file browser (no tabs).
// Scenarios come from three places:
//  - GLOBAL templates (DATA, admin-installed, lens-rendered) — shared by every channel
//  - SESSION templates (DATA, temporarily uploaded here, this browser session only)
//  - SERVER-LEVEL plugins (CODE, admin-installed, sandboxed iframe renderers)
// Installing global templates / plugins lives in Settings → Workbench extensions (admin);
// the drawer only CONSUMES them, and offers a no-persistence temporary upload to anyone.
function WorkbenchDrawerImpl({ open, onClose, channelId, sendResourceReq, openFilePath, filesTick }: Props) {
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const [cfg, setCfg] = useState<WbConfig>({});
  const [globalTemplates, setGlobalTemplates] = useState<TemplateManifest[]>([]);
  const [sessionTemplates, setSessionTemplates] = useState<TemplateManifest[]>([]);
  const [serverPlugins, setServerPlugins] = useState<PluginMeta[]>([]);
  const [sessionPlugins, setSessionPlugins] = useState<PluginMeta[]>([]);
  const [busy, setBusy] = useState(false);
  /** Drag-over highlight — deliberately separate from `busy` (which gates controls). */
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pinMenu, setPinMenu] = useState(false);
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
        const next: WbConfig = { ...base, environment: manifest.id, bindings: nextBindings, configs: nextConfigs };
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
    if (html.length > MAX_PLUGIN_BUNDLE_BYTES) {
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
      if (file.name.endsWith(".json")) void file.text().then(loadTemporary);
      else if (file.name.endsWith(".html")) void file.text().then(loadTemporaryPlugin);
      else setNotice("Drop a .json template or a .html renderer plugin");
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

  // Session templates first so a temporary upload overrides a same-id global for this session.
  const allEnvs = useMemo(() => {
    const byId = new Map<string, TemplateManifest>();
    for (const e of [...sessionTemplates, ...globalTemplates, ...getBuiltinEnvironments()])
      if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()];
  }, [sessionTemplates, globalTemplates]);
  const sessionIds = useMemo(() => new Set(sessionTemplates.map((t) => t.id)), [sessionTemplates]);

  // Session plugins first: a temporary upload shadows a same-id installed plugin for
  // this session. Dedup at the PluginMeta level — renderer ids are composite
  // (plugin:<pid>:<rid>), so it must happen before renderer expansion.
  const plugins = useMemo(() => {
    const byId = new Map<string, PluginMeta>();
    for (const p of [...sessionPlugins, ...serverPlugins]) if (!byId.has(p.plugin_id)) byId.set(p.plugin_id, p);
    return [...byId.values()];
  }, [sessionPlugins, serverPlugins]);

  const selectedId = cfg.environment ?? null;

  const switchScenario = useCallback(
    async (id: string | null) => {
      const manifest = allEnvs.find((e) => e.id === id);
      if (manifest) {
        await activate(manifest);
        return;
      }
      setBusy(true);
      try {
        // back to General: keep bindings/pins — merged against the freshest persisted
        // config (same reasoning as activate), not the render-time snapshot
        let base = cfg;
        try {
          base = parseCfg((await fs.read(WORKBENCH_CONFIG_PATH)).content);
        } catch {
          /* no config file yet */
        }
        await writeCfg({ ...base, environment: id });
      } finally {
        setBusy(false);
      }
    },
    [allEnvs, activate, cfg, fs, writeCfg]
  );

  // Desktop: the same rounded card, laid out in the channel's work area (real
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
  const { float, drag } = useLaneWindow("cheers.float.workbench");

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
    }),
    [channelId, fs, sendResourceReq, pinned, togglePin, plugins, bindings, setBinding, configs, focus, filesTick]
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
          "min-h-0 flex-col rounded-xl border shadow-2xl ring-1 ring-black/40 backdrop-blur-sm bg-zinc-900/95 transition-colors",
          !drag.pos && "top-2 left-2",
          minimized ? "w-[300px]" : "w-[560px] h-[75%]",
          dragOver || busy ? "border-amber-500/60" : "border-zinc-700/80"
        )
      : // Fallback (no lane context): a plain docked column.
        cn(
          open ? "flex" : "hidden",
          "min-h-0 flex-col rounded-xl border shadow-2xl ring-1 ring-black/40 backdrop-blur-sm bg-zinc-900/95 transition-colors",
          minimized ? "w-[300px] self-start max-h-full" : "w-[560px] h-full",
          dragOver || busy ? "border-amber-500/60" : "border-zinc-700/80"
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
          className="flex items-center gap-2 px-3 h-12 border-b border-zinc-800 flex-shrink-0 select-none"
        >
          {minimized ? (
            // Collapsed: the whole title is the expand target (bigger than the
            // 14px restore icon); a button also opts out of the drag handle.
            <button
              type="button"
              onClick={toggleCollapsed}
              title="Expand"
              className="-mx-1 rounded px-1 py-0.5 text-sm font-semibold text-zinc-100 hover:bg-zinc-800/60"
            >
              Workbench
            </button>
          ) : (
            <span className="text-sm font-semibold text-zinc-100">Workbench</span>
          )}
          {!minimized && (
          <>
          <select
            value={selectedId ?? ""}
            onChange={(e) => void switchScenario(e.target.value || null)}
            disabled={busy}
            title="Scenario / template"
            className="bg-zinc-800 text-zinc-300 text-xs rounded px-1 py-0.5 outline-none max-w-[160px] disabled:opacity-50"
          >
            <option value="">General</option>
            {allEnvs.map((e) => (
              <option key={e.id} value={e.id}>
                {sessionIds.has(e.id) ? "⏱ " : ""}
                {e.title}
              </option>
            ))}
          </select>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="Load a temporary extension: a template .json or a renderer plugin .html, this session only (install globally in Settings → Workbench extensions)"
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
          >
            <Clock className="w-3.5 h-3.5" /> Load extension
          </button>
          {pinned.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setPinMenu((o) => !o)}
                title="Pinned files (click to manage / unpin)"
                className="text-[11px] text-amber-400/80 hover:text-amber-300"
              >
                📌 {pinned.length}
              </button>
              {pinMenu && (
                <div className="absolute left-0 top-6 z-50 w-64 rounded-lg bg-zinc-900 p-1 shadow-xl shadow-black/40">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-400">
                    Pinned (injected into every prompt)
                  </div>
                  {pinned.map((p) => (
                    <div
                      key={p}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-800/60 text-xs text-zinc-300"
                    >
                      <span className="truncate flex-1" title={p}>
                        {p}
                      </span>
                      <button
                        onClick={() => togglePin(p)}
                        title="Unpin"
                        className="text-zinc-500 hover:text-red-400 flex-shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,.html,application/json,text/html"
            onChange={onPickFile}
            className="hidden"
          />
          <div className="flex-1" />
          <button
            onClick={toggleCollapsed}
            title={minimized ? "Expand" : "Minimize"}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 max-md:hidden"
          >
            {minimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
          <button onClick={onClose} title="Close">
            <X className="w-4 h-4 text-zinc-500 hover:text-zinc-300" />
          </button>
        </div>

        {!minimized && notice && (
          <div className="px-3 py-1 text-[11px] text-amber-400/90 bg-amber-500/5 border-b border-zinc-800 flex items-center gap-2">
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} title="Dismiss" className="text-zinc-500 hover:text-zinc-300">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {!minimized && allEnvs.length === 0 && selectedId === null && (
          <div className="px-3 py-1.5 text-[11px] text-zinc-400 border-b border-zinc-800 flex items-center gap-2 flex-shrink-0">
            <Package className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
            <span className="flex-1">
              No scenarios yet — drop a .json template (or .html plugin) here, use "Load extension", or
            </span>
            <button
              onClick={() => loadTemporary(JSON.stringify(researchExample))}
              className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 flex-shrink-0"
            >
              Try it now: Research
            </button>
          </div>
        )}

        {/* Minimized: a ViewBoard-style glance (scenario + pinned files) in place
            of the full browser. Clicking a row expands back to the browser. */}
        {minimized && (
          <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
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
        {/* the body IS the file browser: select a file → pin / preview / raw.
            Kept mounted while minimized (hidden) so tree/selection state survives. */}
        <div className={minimized ? "hidden" : "flex-1 min-h-0 overflow-hidden"}>
          {open && <FilePanel ctx={ctx} />}
        </div>
        {float && !minimized && <ResizeGrip resizeProps={drag.resizeProps} />}
      </aside>
  );
}

// Memoized: skips re-rendering the workbench (and its file tree) on ChannelView's
// per-delta streaming renders; props change only on explicit workbench interactions.
export const WorkbenchDrawer = memo(WorkbenchDrawerImpl);
