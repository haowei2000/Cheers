import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { makeFsClient, type SendResourceReq } from "./fsClient";
import { getPanels, type PanelContext } from "./panelRegistry";
import { getBuiltinEnvironments, WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, type TemplateManifest } from "./manifest";
import { viewToPanel } from "./lens/LensPanel";
import { loadWorkspaceTemplates } from "./loadWorkspaceTemplates";
import "./lens/builtins"; // side-effect: registers the built-in lenses (table/kanban/markdown)
import "./panels/FilePanel"; // side-effect: registers the always-on File panel
import "./environments"; // side-effect: registers built-in template manifests

interface Props {
  open: boolean;
  onClose: () => void;
  channelId: string;
  sendResourceReq: SendResourceReq;
}

// Right-side per-channel workbench. Templates come from two places: built-in manifests
// (compiled) and runtime manifests dropped into .workbench/templates/ in the channel
// (loaded as data). Picking one seeds its files and binds the channel via .workbench.json.
// Panels = the always-on File panel + the active template's views (each via LensPanel).
export function WorkbenchDrawer({ open, onClose, channelId, sendResourceReq }: Props) {
  const fs = useMemo(() => makeFsClient(sendResourceReq, channelId), [sendResourceReq, channelId]);
  const [envId, setEnvId] = useState<string | null>(null);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<TemplateManifest[]>([]);
  const [active, setActive] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // On open: load the channel's scenario binding + any runtime template manifests.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fs.read(WORKBENCH_CONFIG_PATH)
      .then((f) => alive && setEnvId(((JSON.parse(f.content) as { environment?: string }).environment) ?? null))
      .catch(() => alive && setEnvId(null));
    loadWorkspaceTemplates(fs)
      .then((t) => alive && setWorkspaceTemplates(t))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, fs]);

  const allEnvs = useMemo(() => {
    const byId = new Map<string, TemplateManifest>();
    for (const e of [...getBuiltinEnvironments(), ...workspaceTemplates]) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()];
  }, [workspaceTemplates]);

  const env = allEnvs.find((e) => e.id === envId);
  const panels = useMemo(() => [...getPanels(), ...(env?.views.map(viewToPanel) ?? [])], [env]);
  const ctx: PanelContext = useMemo(() => ({ channelId, fs }), [channelId, fs]);
  const activePanel = panels.find((p) => p.id === active) ?? panels[0];

  const switchEnv = useCallback(
    async (id: string | null) => {
      setBusy(true);
      try {
        const manifest = allEnvs.find((e) => e.id === id);
        if (manifest) await seedManifest(fs, manifest); // scaffold starter files (idempotent)
        await fs.write(WORKBENCH_CONFIG_PATH, JSON.stringify({ environment: id }));
        setEnvId(id);
        setActive(manifest?.views[0]?.id ?? ""); // land on the template's first view (or File)
      } finally {
        setBusy(false);
      }
    },
    [fs, allEnvs]
  );

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} aria-hidden />}
      <aside
        className={`fixed top-0 right-0 h-full w-[560px] max-w-[94vw] bg-zinc-900 border-l border-zinc-800 z-50 flex flex-col transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 px-3 h-12 border-b border-zinc-800 flex-shrink-0">
          <span className="text-sm font-semibold text-zinc-100">Workbench</span>
          <select
            value={envId ?? ""}
            disabled={busy}
            onChange={(e) => void switchEnv(e.target.value || null)}
            title="场景 / Template（选中会初始化起始文件）"
            className="bg-zinc-800 text-zinc-300 text-xs rounded px-1 py-0.5 outline-none disabled:opacity-50"
          >
            <option value="">通用</option>
            {allEnvs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
          {busy && <span className="text-[11px] text-zinc-500">初始化中…</span>}
          <div className="flex-1" />
          <button onClick={onClose} title="Close">
            <X className="w-4 h-4 text-zinc-500 hover:text-zinc-200" />
          </button>
        </div>

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

        <div className="flex-1 min-h-0 overflow-hidden">{open && activePanel?.render(ctx)}</div>
      </aside>
    </>
  );
}
