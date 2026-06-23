import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { registerLens, type LensProps } from "./registry";

// ── table: array of row objects, columns declared in config ──────────────────
interface TableConfig {
  columns: { key: string; label: string; options?: string[] }[];
}
function TableLens({ data, config, onChange }: LensProps) {
  const columns = (config as TableConfig | undefined)?.columns ?? [];
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const update = (i: number, key: string, v: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const add = () =>
    onChange([...rows, Object.fromEntries(columns.map((c) => [c.key, c.options?.[0] ?? ""]))]);
  const del = (i: number) => onChange(rows.filter((_, j) => j !== i));

  return (
    <div className="p-2 text-xs overflow-auto h-full">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-zinc-500 text-left">
            {columns.map((c) => (
              <th key={c.key} className="p-1 font-normal">{c.label}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-zinc-800/60">
              {columns.map((c) => (
                <td key={c.key} className="p-1">
                  {c.options ? (
                    <select value={String(r[c.key] ?? "")} onChange={(e) => update(i, c.key, e.target.value)} className="bg-zinc-800 text-zinc-200 rounded px-1 outline-none">
                      {c.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={String(r[c.key] ?? "")} onChange={(e) => update(i, c.key, e.target.value)} className="bg-transparent w-full text-zinc-200 outline-none" />
                  )}
                </td>
              ))}
              <td className="p-1">
                <button onClick={() => del(i)} title="删除">
                  <Trash2 className="w-3 h-3 text-zinc-600 hover:text-red-400" />
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 1} className="p-3 text-zinc-600">空，点下方「加一行」</td>
            </tr>
          )}
        </tbody>
      </table>
      <button onClick={add} className="mt-2 flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
        <Plus className="w-3.5 h-3.5" /> 加一行
      </button>
    </div>
  );
}

// ── kanban: { columns: [{ name, items: string[] }] } ─────────────────────────
interface BoardData {
  columns: { name: string; items: string[] }[];
}
function KanbanLens({ data, onChange }: LensProps) {
  const cols = (data as BoardData | null)?.columns ?? [];
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const setCols = (next: BoardData["columns"]) => onChange({ columns: next });

  const addItem = (ci: number) => {
    const t = (drafts[ci] ?? "").trim();
    if (!t) return;
    setCols(cols.map((c, j) => (j === ci ? { ...c, items: [...c.items, t] } : c)));
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
    <div className="p-2 text-xs flex gap-2 items-start overflow-auto h-full">
      {cols.length === 0 && <div className="p-3 text-zinc-600">空看板</div>}
      {cols.map((c, ci) => (
        <div key={ci} className="w-40 flex-shrink-0 bg-zinc-950/60 rounded border border-zinc-800">
          <div className="px-2 py-1 text-zinc-300 border-b border-zinc-800">
            {c.name} <span className="text-zinc-600">{c.items.length}</span>
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
  );
}

// ── markdown: a string (prompt templates, notes, drafts). Inert <textarea> edit;
//    never dangerouslySetInnerHTML. (A sanitized preview can be added later.)
function MarkdownLens({ data, onChange }: LensProps) {
  const text = typeof data === "string" ? data : "";
  return (
    <textarea
      value={text}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      placeholder="# 提示词 / 文档…"
      className="w-full h-full resize-none bg-zinc-950 text-zinc-200 font-mono text-xs p-3 outline-none"
    />
  );
}

registerLens({ id: "table", render: (p) => <TableLens {...p} /> });
registerLens({ id: "kanban", render: (p) => <KanbanLens {...p} /> });
registerLens({ id: "markdown", render: (p) => <MarkdownLens {...p} /> });
