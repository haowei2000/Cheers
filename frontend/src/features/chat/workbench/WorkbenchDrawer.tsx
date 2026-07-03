import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Package, X } from "lucide-react";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { getPanels, type PanelContext } from "./panelRegistry";
import { getBuiltinEnvironments, WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, validateManifest, type TemplateManifest } from "./manifest";
import { viewToTab } from "./renderers/ViewTab";
import { listGlobalTemplates } from "./templatesApi";
import { listPlugins, type PluginMeta } from "./sandbox/api";
import researchExample from "./examples/research.json";
import "./lens/builtins";
import "./panels/FilePanel";
import "./environments";

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
  /** Deep-link: open the File panel focused on this path (e.g. a clicked Desk ref). */
  openFilePath?: string;
}

interface WbConfig {
  /** Self-documenting field (regenerated on every write) — for humans/AI reading the file. */
  _doc?: string;
  environment?: string | null;
  pinned?: string[];
  /** path -> renderer id: which renderer opens a file (File panel renderer picker). */
  bindings?: Record<string, string>;
  /** Files surfaced as workbench tabs, in order. */
  views?: { path: string; title?: string; renderer?: string; config?: unknown }[];
}

// Regenerated into `.workbench.json._doc` on every write, so anyone (human or AI) opening
// the file understands the schema without external docs. NOT a free-form comment — the UI
// rewrites this file, so only fields (like this one) survive; see docs/arch/WORKBENCH.md.
const WB_DOC =
  "Workbench config (per-channel, maintained by the workbench UI, hand-editable). " +
  "views = curated files shown as top tabs [{path,title}], rendered with each file's bound renderer from bindings (raw text if unbound); " +
  "bindings = file path → renderer id; pinned = files injected into every bot prompt. " +
  "Files themselves are pure content — type and rendering are decided by this config, never written into the file.";

// Right-side per-channel workbench. Scenarios come from three places:
//  - GLOBAL templates (DATA, admin-installed, lens-rendered) — shared by every channel
//  - SESSION templates (DATA, temporarily uploaded here, this browser session only)
//  - SERVER-LEVEL plugins (CODE, admin-installed, sandboxed iframe)
// plus the always-on File panel. Installing global templates / plugins lives in
// Settings → Workbench extensions (admin); the drawer only CONSUMES them, and offers
// a no-persistence temporary upload to anyone.
export function WorkbenchDrawer({ open, onClose, channelId, sendResourceReq, openFilePath }: Props) {
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const [cfg, setCfg] = useState<WbConfig>({});
  const [globalTemplates, setGlobalTemplates] = useState<TemplateManifest[]>([]);
  const [sessionTemplates, setSessionTemplates] = useState<TemplateManifest[]>([]);
  const [serverPlugins, setServerPlugins] = useState<PluginMeta[]>([]);
  const [active, setActive] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pinMenu, setPinMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fs.read(WORKBENCH_CONFIG_PATH)
      .then((f) => alive && setCfg(JSON.parse(f.content) as WbConfig))
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
      setCfg(next);
      try {
        // strip any stale _doc, regenerate it fresh, pretty-print for human/AI readability
        const { _doc: _drop, ...rest } = next;
        const body = { _doc: WB_DOC, ...rest };
        await fs.write(WORKBENCH_CONFIG_PATH, JSON.stringify(body, null, 2));
      } catch {
        /* optimistic */
      }
    },
    [fs]
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

  const views = useMemo(() => cfg.views ?? [], [cfg.views]);
  const toggleView = useCallback(
    (path: string, title?: string) => {
      const exists = views.some((v) => v.path === path);
      const next = exists
        ? views.filter((v) => v.path !== path)
        : [...views, { path, title: title || path.split("/").pop() || path }];
      void writeCfg({ ...cfg, views: next });
    },
    [cfg, views, writeCfg]
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
      setBusy(true);
      void (async () => {
        try {
          await seedManifest(fs, m);
          await writeCfg({ ...cfg, environment: m.id });
          setActive(m.views[0]?.id ?? "");
          setNotice(`Loaded temporarily: ${m.title} (this session only; to share globally go to Settings → Workbench extensions)`);
        } finally {
          setBusy(false);
        }
      })();
    },
    [fs, cfg, writeCfg]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setBusy(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.name.endsWith(".json")) void file.text().then(loadTemporary);
      else setNotice("Drop a .json template file");
    },
    [loadTemporary]
  );

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void file.text().then(loadTemporary);
      e.target.value = "";
    },
    [loadTemporary]
  );

  // Session templates first so a temporary upload overrides a same-id global for this session.
  const allEnvs = useMemo(() => {
    const byId = new Map<string, TemplateManifest>();
    for (const e of [...sessionTemplates, ...globalTemplates, ...getBuiltinEnvironments()])
      if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()];
  }, [sessionTemplates, globalTemplates]);
  const sessionIds = useMemo(() => new Set(sessionTemplates.map((t) => t.id)), [sessionTemplates]);

  const selectedId = cfg.environment ?? null;
  // Tabs come ONLY from .workbench.json views now (+ the always-on Files panel). The old
  // parallel sources — a template's lens views, a sandbox plugin's panels — are retired;
  // a template instead migrates its views into .workbench.json on activation (below).
  const panels = useMemo(
    () => [...getPanels(), ...views.map(viewToTab)],
    [views]
  );
  const ctx: PanelContext = useMemo(
    () => ({
      channelId,
      fs,
      sendResourceReq,
      pinned,
      togglePin,
      plugins: serverPlugins,
      bindings,
      setBinding,
      views,
      toggleView,
      openTarget: openFilePath ?? null,
    }),
    [channelId, fs, sendResourceReq, pinned, togglePin, serverPlugins, bindings, setBinding, views, toggleView, openFilePath]
  );

  // Deep-link: when opened with a target Desk path, focus the always-on File panel.
  useEffect(() => {
    if (open && openFilePath) setActive("files");
  }, [open, openFilePath]);
  const activePanel = panels.find((p) => p.id === active) ?? panels[0];

  const switchScenario = useCallback(
    async (id: string | null) => {
      setBusy(true);
      try {
        const manifest = allEnvs.find((e) => e.id === id);
        let nextViews = views;
        if (manifest) {
          await seedManifest(fs, manifest); // seed the scenario's starter files
          // migrate the template's declarative views into .workbench.json (additive,
          // idempotent): each {file,lens,config} becomes a tab bound to a built-in lens.
          const have = new Set(views.map((v) => v.path));
          const add = manifest.views
            .filter((v) => !have.has(v.file))
            .map((v) => ({ path: v.file, title: v.title, renderer: `builtin:${v.lens}`, config: v.config }));
          nextViews = [...views, ...add];
        }
        await writeCfg({ ...cfg, environment: id, views: nextViews });
        setActive(`view:${manifest?.views[0]?.file ?? ""}`);
      } finally {
        setBusy(false);
      }
    },
    [fs, cfg, allEnvs, views, writeCfg]
  );

  const nothingInstalled = allEnvs.length === 0;

  return (
    <>
      {/* Non-modal docked panel below the channel header (top-12), so the header
          toggles stay clickable and the ViewBoard can be open at the same time. */}
      <aside
        onDragOver={(e) => {
          e.preventDefault();
          setBusy(true);
        }}
        onDragLeave={() => setBusy(false)}
        onDrop={onDrop}
        className={`fixed top-12 right-0 h-[calc(100vh-3rem)] w-[560px] max-w-[94vw] bg-zinc-900 border-l z-40 flex flex-col transition-transform duration-200 ${
          busy ? "border-amber-500/60" : "border-zinc-800"
        } ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center gap-2 px-3 h-12 border-b border-zinc-800 flex-shrink-0">
          <span className="text-sm font-semibold text-zinc-100">Workbench</span>
          <select
            value={selectedId ?? ""}
            onChange={(e) => void switchScenario(e.target.value || null)}
            title="Scenario / template"
            className="bg-zinc-800 text-zinc-300 text-xs rounded px-1 py-0.5 outline-none max-w-[160px]"
          >
            <option value="">General</option>
            {allEnvs.map((e) => (
              <option key={e.id} value={e.id}>
                {sessionIds.has(e.id) ? "⏱ " : ""}
                {e.title}
              </option>
            ))}
            {/* Plugins are no longer scenarios — they're renderers picked per-file in the
                File panel. The scenario dropdown lists data templates only. */}
          </select>
          <button
            onClick={() => fileRef.current?.click()}
            title="Load a temporary template: pick a manifest .json, this session only (install globally in Settings → Workbench extensions)"
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100"
          >
            <Clock className="w-3.5 h-3.5" /> Temp template
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={onPickFile} className="hidden" />
          {pinned.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setPinMenu((o) => !o)}
                title="Pinned files (click to manage / unpin)"
                className="text-[11px] text-amber-500/80 hover:text-amber-400"
              >
                📌 {pinned.length}
              </button>
              {pinMenu && (
                <div className="absolute left-0 top-6 z-50 w-64 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
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
          <div className="flex-1" />
          <button onClick={onClose} title="Close">
            <X className="w-4 h-4 text-zinc-500 hover:text-zinc-200" />
          </button>
        </div>

        {notice && (
          <div className="px-3 py-1 text-[11px] text-amber-400/90 bg-amber-500/5 border-b border-zinc-800 flex items-center gap-2">
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} title="Dismiss" className="text-zinc-500 hover:text-zinc-300">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1 px-2 h-8 border-b border-zinc-800 flex-shrink-0 overflow-x-auto">
          {panels.map((p) => (
            <button
              key={p.id}
              onClick={() => setActive(p.id)}
              className={`px-2 py-0.5 rounded text-xs whitespace-nowrap ${
                activePanel?.id === p.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {p.title}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {nothingInstalled && selectedId === null ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-zinc-500 text-xs p-6 text-center">
              <Package className="w-8 h-8 text-zinc-700" />
              <div>
                No scenarios yet. Global templates and plugins are installed by an admin in
                Settings → Workbench extensions; you can also drop a .json file here or click
                "Temp template" above to try one for this session only.
              </div>
              <button
                onClick={() => loadTemporary(JSON.stringify(researchExample))}
                className="mt-1 px-3 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
              >
                Try it now: Research
              </button>
            </div>
          ) : (
            open && activePanel?.render(ctx)
          )}
        </div>
      </aside>
    </>
  );
}
