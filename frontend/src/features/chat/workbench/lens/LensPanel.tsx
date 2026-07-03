import { Save } from "lucide-react";
import type { PanelContext, PanelDef } from "../panelRegistry";
import type { ViewDef } from "../manifest";
import { useFile } from "../jsonFile";
import { PinToggle } from "../PinToggle";
import { getLens } from "./registry";

// The generic panel that powers every declarative view: load the file (parsed by its
// format) -> hand (data, config) to the lens -> save on demand. A 📌 toggle pins the
// file into every bot prompt (the semantic layer). No per-board React.
function LensPanel({ ctx, view }: { ctx: PanelContext; view: ViewDef }) {
  const { fs, pinned, togglePin } = ctx;
  const lens = getLens(view.lens);
  const fallback: unknown = view.file.endsWith(".json") ? null : "";
  const { data, setData, save, status } = useFile<unknown>(fs, view.file, fallback);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
        <span className="text-zinc-300">{view.title}</span>
        <span className="text-zinc-600 text-[10px] truncate">{view.file}</span>
        <div className="flex-1" />
        <PinToggle path={view.file} pinned={pinned} togglePin={togglePin} />
        <button onClick={() => void save(data)} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
          <Save className="w-3.5 h-3.5" /> Save
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {lens ? (
          lens.render({ data, config: view.config, onChange: setData })
        ) : (
          <div className="p-3 text-amber-500">Unknown lens: {view.lens}</div>
        )}
      </div>
      {status && (
        <div className="px-3 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 flex-shrink-0">{status}</div>
      )}
    </div>
  );
}

// A declarative view compiles to a PanelDef — so the tab machinery is unchanged.
export function viewToPanel(view: ViewDef): PanelDef {
  return {
    id: view.id,
    title: view.title,
    render: (ctx) => <LensPanel ctx={ctx} view={view} />,
  };
}
