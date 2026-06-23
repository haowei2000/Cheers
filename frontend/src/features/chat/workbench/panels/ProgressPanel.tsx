import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Save, X } from "lucide-react";
import type { PanelContext, PanelDef } from "../panelRegistry";
import { useJsonFile } from "../jsonFile";

export interface Board {
  columns: { name: string; items: string[] }[];
}
const EMPTY: Board = { columns: [] };

function ProgressPanel({ fs }: PanelContext) {
  const { data, setData, save, status } = useJsonFile<Board>(fs, "research/progress.json", EMPTY);
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const cols = data.columns;
  const setCols = (next: Board["columns"]) => setData({ columns: next });

  const addItem = (ci: number) => {
    const text = (drafts[ci] ?? "").trim();
    if (!text) return;
    setCols(cols.map((c, j) => (j === ci ? { ...c, items: [...c.items, text] } : c)));
    setDrafts({ ...drafts, [ci]: "" });
  };
  const delItem = (ci: number, ii: number) =>
    setCols(cols.map((c, j) => (j === ci ? { ...c, items: c.items.filter((_, k) => k !== ii) } : c)));
  const moveItem = (ci: number, ii: number, dir: -1 | 1) => {
    const ti = ci + dir;
    if (ti < 0 || ti >= cols.length) return;
    const item = cols[ci].items[ii];
    setCols(
      cols.map((c, j) => {
        if (j === ci) return { ...c, items: c.items.filter((_, k) => k !== ii) };
        if (j === ti) return { ...c, items: [...c.items, item] };
        return c;
      })
    );
  };

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
        <span className="text-zinc-300">进度看板</span>
        <div className="flex-1" />
        <button onClick={() => void save(data)} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
          <Save className="w-3.5 h-3.5" /> 保存
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2 flex gap-2 items-start">
        {cols.length === 0 && <div className="p-3 text-zinc-600">看板为空（选「科研」场景会初始化默认列）</div>}
        {cols.map((c, ci) => (
          <div key={ci} className="w-40 flex-shrink-0 bg-zinc-950/60 rounded border border-zinc-800">
            <div className="px-2 py-1 text-zinc-300 border-b border-zinc-800 flex items-center">
              <span>{c.name}</span>
              <span className="ml-1 text-zinc-600">{c.items.length}</span>
            </div>
            <div className="p-1 space-y-1">
              {c.items.map((it, ii) => (
                <div key={ii} className="group bg-zinc-800/70 rounded px-1.5 py-1 text-zinc-200 flex items-center gap-1">
                  <button onClick={() => moveItem(ci, ii, -1)} disabled={ci === 0} className="disabled:opacity-20">
                    <ChevronLeft className="w-3 h-3 text-zinc-500" />
                  </button>
                  <span className="flex-1 break-words">{it}</span>
                  <button onClick={() => moveItem(ci, ii, 1)} disabled={ci === cols.length - 1} className="disabled:opacity-20">
                    <ChevronRight className="w-3 h-3 text-zinc-500" />
                  </button>
                  <button onClick={() => delItem(ci, ii)} className="opacity-0 group-hover:opacity-100">
                    <X className="w-3 h-3 text-zinc-600 hover:text-red-400" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-1 pt-1">
                <input
                  value={drafts[ci] ?? ""}
                  onChange={(e) => setDrafts({ ...drafts, [ci]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && addItem(ci)}
                  placeholder="+ 任务"
                  className="bg-transparent flex-1 text-zinc-300 outline-none placeholder:text-zinc-600"
                />
                <button onClick={() => addItem(ci)}>
                  <Plus className="w-3 h-3 text-zinc-500 hover:text-zinc-200" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {status && (
        <div className="px-3 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 flex-shrink-0">{status}</div>
      )}
    </div>
  );
}

export const progressPanel: PanelDef = {
  id: "progress",
  title: "进度看板",
  render: (ctx) => <ProgressPanel {...ctx} />,
};
