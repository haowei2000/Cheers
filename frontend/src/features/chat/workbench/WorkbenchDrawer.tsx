import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Package, X } from "lucide-react";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { getPanels, type PanelContext } from "./panelRegistry";
import { getBuiltinEnvironments, WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, validateManifest, type TemplateManifest } from "./manifest";
import { viewToPanel } from "./lens/LensPanel";
import { loadWorkspaceTemplates } from "./loadWorkspaceTemplates";
import researchExample from "./examples/research.json";
import "./lens/builtins"; // side-effect: registers built-in lenses (table/kanban/markdown)
import "./panels/FilePanel"; // side-effect: registers the always-on File panel
import "./environments"; // built-in template barrel (empty by default — templates are installed)

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
}

interface WbConfig {
  environment?: string | null;
  pinned?: string[];
}

// Right-side per-channel workbench. Templates are installed as standalone manifest JSON
// files: drop one onto the drawer (or pick a file / one-click the example) and it's
// written to .workbench/templates/, validated against the built-in lenses, and shows up
// in the scenario picker. Lenses (code) are the safe vocabulary; templates (data) are
// installed at runtime — no rebuild, no code execution.
export function WorkbenchDrawer({ open, onClose, channelId, sendResourceReq }: Props) {
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const [cfg, setCfg] = useState<WbConfig>({});
  const [workspaceTemplates, setWorkspaceTemplates] = useState<TemplateManifest[]>([]);
  const [active, setActive] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reloadTemplates = useCallback(async () => {
    const t = await loadWorkspaceTemplates(fs);
    setWorkspaceTemplates(t);
    return t;
  }, [fs]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fs.read(WORKBENCH_CONFIG_PATH)
      .then((f) => alive && setCfg(JSON.parse(f.content) as WbConfig))
      .catch(() => alive && setCfg({}));
    void reloadTemplates();
    return () => {
      alive = false;
    };
  }, [open, fs, reloadTemplates]);

  const writeCfg = useCallback(
    async (next: WbConfig) => {
      setCfg(next);
      try {
        await fs.write(WORKBENCH_CONFIG_PATH, JSON.stringify(next));
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

  // ── install a template manifest (data, validated against built-in lenses) ──────
  const installManifest = useCallback(
    async (text: string) => {
      let m: unknown;
      try {
        m = JSON.parse(text);
      } catch {
        setNotice("不是合法 JSON");
        return;
      }
      if (!validateManifest(m)) {
        setNotice("无效插件：缺 id/title/views，或引用了未知 lens");
        return;
      }
      await fs.write(`.workbench/templates/${m.id}.json`, JSON.stringify(m, null, 2));
      await reloadTemplates();
      setNotice(`已安装：${m.title} — 在上方「场景」下拉里选它`);
    },
    [fs, reloadTemplates]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setBusy(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.name.endsWith(".json")) void file.text().then(installManifest);
      else setNotice("请拖入一个 .json 插件文件");
    },
    [installManifest]
  );

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void file.text().then(installManifest);
      e.target.value = "";
    },
    [installManifest]
  );

  const allEnvs = useMemo(() => {
    const byId = new Map<string, TemplateManifest>();
    for (const e of [...getBuiltinEnvironments(), ...workspaceTemplates]) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()];
  }, [workspaceTemplates]);

  const envId = cfg.environment ?? null;
  const env = allEnvs.find((e) => e.id === envId);
  const panels = useMemo(() => [...getPanels(), ...(env?.views.map(viewToPanel) ?? [])], [env]);
  const ctx: PanelContext = useMemo(
    () => ({ channelId, fs, pinned, togglePin }),
    [channelId, fs, pinned, togglePin]
  );
  const activePanel = panels.find((p) => p.id === active) ?? panels[0];

  const switchEnv = useCallback(
    async (id: string | null) => {
      setBusy(true);
      try {
        const manifest = allEnvs.find((e) => e.id === id);
        if (manifest) await seedManifest(fs, manifest);
        await writeCfg({ ...cfg, environment: id });
        setActive(manifest?.views[0]?.id ?? "");
      } finally {
        setBusy(false);
      }
    },
    [fs, cfg, allEnvs, writeCfg]
  );

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} aria-hidden />}
      <aside
        onDragOver={(e) => {
          e.preventDefault();
          setBusy(true);
        }}
        onDragLeave={() => setBusy(false)}
        onDrop={onDrop}
        className={`fixed top-0 right-0 h-full w-[560px] max-w-[94vw] bg-zinc-900 border-l z-50 flex flex-col transition-transform duration-200 ${
          busy ? "border-amber-500/60" : "border-zinc-800"
        } ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center gap-2 px-3 h-12 border-b border-zinc-800 flex-shrink-0">
          <span className="text-sm font-semibold text-zinc-100">Workbench</span>
          <select
            value={envId ?? ""}
            onChange={(e) => void switchEnv(e.target.value || null)}
            title="场景 / Template"
            className="bg-zinc-800 text-zinc-300 text-xs rounded px-1 py-0.5 outline-none"
          >
            <option value="">通用</option>
            {allEnvs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
          <button
            onClick={() => fileRef.current?.click()}
            title="装插件：选一个 manifest .json"
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100"
          >
            <Package className="w-3.5 h-3.5" /> 装插件
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={onPickFile} className="hidden" />
          {pinned.length > 0 && <span className="text-[11px] text-amber-500/80">📌 {pinned.length}</span>}
          <div className="flex-1" />
          <button onClick={onClose} title="Close">
            <X className="w-4 h-4 text-zinc-500 hover:text-zinc-200" />
          </button>
        </div>

        {notice && (
          <div className="px-3 py-1 text-[11px] text-amber-400/90 bg-amber-500/5 border-b border-zinc-800 flex items-center gap-2">
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="text-zinc-500 hover:text-zinc-300">
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
          {allEnvs.length === 0 && envId === null ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-zinc-500 text-xs p-6 text-center">
              <Package className="w-8 h-8 text-zinc-700" />
              <div>还没有装任何场景插件。</div>
              <div>把一个 <code className="text-zinc-300">.json</code> 插件文件拖到这里，或点上方「装插件」。</div>
              <button
                onClick={() => void installManifest(JSON.stringify(researchExample))}
                className="mt-1 px-3 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
              >
                装示例：科研
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
