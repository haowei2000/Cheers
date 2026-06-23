import { Plus, Save, Trash2 } from "lucide-react";
import type { PanelContext, PanelDef } from "../../panelRegistry";
import { useJsonFile } from "../../jsonFile";

export interface Journal {
  name: string;
  impact: string;
  deadline: string;
  status: string;
}
const STATUSES = ["候选", "撰写中", "投稿中", "已投", "录用", "拒稿"];

function JournalsPanel({ fs }: PanelContext) {
  const { data, setData, save, status } = useJsonFile<Journal[]>(
    fs,
    "research/journals.json",
    []
  );
  const update = (i: number, k: keyof Journal, v: string) =>
    setData(data.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const add = () =>
    setData([...data, { name: "", impact: "", deadline: "", status: "候选" }]);
  const del = (i: number) => setData(data.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
        <span className="text-zinc-300">目标期刊</span>
        <div className="flex-1" />
        <button onClick={add} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
          <Plus className="w-3.5 h-3.5" /> 加一行
        </button>
        <button onClick={() => void save(data)} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
          <Save className="w-3.5 h-3.5" /> 保存
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-zinc-500 text-left">
              <th className="p-1 font-normal">期刊</th>
              <th className="p-1 font-normal">IF</th>
              <th className="p-1 font-normal">截稿</th>
              <th className="p-1 font-normal">状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800/60">
                <td className="p-1">
                  <input value={r.name} onChange={(e) => update(i, "name", e.target.value)} placeholder="Nature" className="bg-transparent w-full text-zinc-200 outline-none" />
                </td>
                <td className="p-1">
                  <input value={r.impact} onChange={(e) => update(i, "impact", e.target.value)} placeholder="—" className="bg-transparent w-12 text-zinc-200 outline-none" />
                </td>
                <td className="p-1">
                  <input value={r.deadline} onChange={(e) => update(i, "deadline", e.target.value)} placeholder="2026-09" className="bg-transparent w-24 text-zinc-200 outline-none" />
                </td>
                <td className="p-1">
                  <select value={r.status} onChange={(e) => update(i, "status", e.target.value)} className="bg-zinc-800 text-zinc-200 rounded px-1 outline-none">
                    {STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td className="p-1">
                  <button onClick={() => del(i)} title="删除">
                    <Trash2 className="w-3 h-3 text-zinc-600 hover:text-red-400" />
                  </button>
                </td>
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td colSpan={5} className="p-3 text-zinc-600">还没有期刊，点「加一行」</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {status && (
        <div className="px-3 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 flex-shrink-0">{status}</div>
      )}
    </div>
  );
}

export const journalsPanel: PanelDef = {
  id: "journals",
  title: "目标期刊",
  render: (ctx) => <JournalsPanel {...ctx} />,
};
