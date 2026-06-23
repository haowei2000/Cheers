import { Plus, Save, Trash2 } from "lucide-react";
import type { PanelContext, PanelDef } from "../../panelRegistry";
import { useJsonFile } from "../../jsonFile";

export interface Review {
  paper: string;
  reviewer: string;
  status: string;
  notes: string;
}
const STATUSES = ["待审", "审阅中", "已审", "退回"];

function ReviewPanel({ fs }: PanelContext) {
  const { data, setData, save, status } = useJsonFile<Review[]>(fs, "research/reviews.json", []);
  const update = (i: number, k: keyof Review, v: string) =>
    setData(data.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const add = () =>
    setData([...data, { paper: "", reviewer: "", status: "待审", notes: "" }]);
  const del = (i: number) => setData(data.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
        <span className="text-zinc-300">论文审阅</span>
        <div className="flex-1" />
        <button onClick={add} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
          <Plus className="w-3.5 h-3.5" /> 加一篇
        </button>
        <button onClick={() => void save(data)} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
          <Save className="w-3.5 h-3.5" /> 保存
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-zinc-500 text-left">
              <th className="p-1 font-normal">论文</th>
              <th className="p-1 font-normal">审稿人</th>
              <th className="p-1 font-normal">状态</th>
              <th className="p-1 font-normal">备注</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800/60 align-top">
                <td className="p-1">
                  <input value={r.paper} onChange={(e) => update(i, "paper", e.target.value)} placeholder="标题 / arXiv id" className="bg-transparent w-full text-zinc-200 outline-none" />
                </td>
                <td className="p-1">
                  <input value={r.reviewer} onChange={(e) => update(i, "reviewer", e.target.value)} placeholder="姓名" className="bg-transparent w-20 text-zinc-200 outline-none" />
                </td>
                <td className="p-1">
                  <select value={r.status} onChange={(e) => update(i, "status", e.target.value)} className="bg-zinc-800 text-zinc-200 rounded px-1 outline-none">
                    {STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td className="p-1">
                  <input value={r.notes} onChange={(e) => update(i, "notes", e.target.value)} placeholder="—" className="bg-transparent w-full text-zinc-200 outline-none" />
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
                <td colSpan={5} className="p-3 text-zinc-600">还没有待审论文，点「加一篇」</td>
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

export const reviewPanel: PanelDef = {
  id: "reviews",
  title: "论文审阅",
  render: (ctx) => <ReviewPanel {...ctx} />,
};
