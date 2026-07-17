import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { registerLens, type LensProps } from "./registry";
import { isComposing } from "@/lib/ime";

// ── table: array of row objects; columns from config, else inferred ──────────
interface TableConfig {
  columns: { key: string; label: string; options?: string[] }[];
}
// A tabular row is a PLAIN OBJECT. YAML happily parses `- alpha` to a string row and a
// bare `-` to null; the registry no longer offers the table for those, but the lens
// still guards every row itself (a template binding or a file edited after binding can
// hand it anything) — Object.keys(null) throws to the root ErrorBoundary, and
// Object.keys("alpha") fabricates per-character index columns.
function isPlainRow(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
// Without a template config (the pickable path — any JSON/YAML array), infer the
// columns from the union of row keys, first-seen order. Non-object rows contribute
// nothing. `options` dropdowns remain a config-only feature. Exported for tests.
export function inferColumns(rows: unknown[]): TableConfig["columns"] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isPlainRow(r)) continue;
    for (const k of Object.keys(r))
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
  }
  return (keys.length ? keys : ["value"]).map((k) => ({ key: k, label: k }));
}
// Pure cell edit, exported for tests. REFUSES to touch a non-object row: spreading a
// string ({..."alpha"}) silently becomes {"0":"a","1":"l",…} and Save would write that
// corruption into the user's file — null tells the caller to no-op instead.
export function updateRowCell(rows: unknown[], i: number, key: string, v: string): unknown[] | null {
  if (!isPlainRow(rows[i])) return null;
  return rows.map((r, j) => (j === i && isPlainRow(r) ? { ...r, [key]: v } : r));
}
function TableLens({ data, config, onChange }: LensProps) {
  const rows = Array.isArray(data) ? (data as unknown[]) : [];
  const configured = (config as TableConfig | undefined)?.columns;
  const columns = configured?.length ? configured : inferColumns(rows);
  const update = (i: number, key: string, v: string) => {
    const next = updateRowCell(rows, i, key, v);
    if (next) onChange(next);
  };
  const add = () =>
    onChange([...rows, Object.fromEntries(columns.map((c) => [c.key, c.options?.[0] ?? ""]))]);
  const del = (i: number) => onChange(rows.filter((_, j) => j !== i));

  return (
    <div className="p-2 text-xs overflow-auto h-full">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-zinc-400 text-left">
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
                  {!isPlainRow(r) ? (
                    // null/scalar row: read-only placeholder — an input would promise an
                    // edit that update() must refuse. Delete (index-based) still works.
                    <span className="text-zinc-500">—</span>
                  ) : c.options ? (
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
                <button onClick={() => del(i)} title="Delete row">
                  <Trash2 className="w-3 h-3 text-zinc-600 hover:text-red-400" />
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 1} className="p-3 text-zinc-400">Empty — click "Add row" below</td>
            </tr>
          )}
        </tbody>
      </table>
      <button onClick={add} className="mt-2 flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
        <Plus className="w-3.5 h-3.5" /> Add row
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
      {cols.length === 0 && <div className="p-3 text-zinc-400">Empty board</div>}
      {cols.map((c, ci) => (
        <div key={ci} className="w-40 flex-shrink-0 bg-zinc-950/60 rounded ">
          <div className="px-2 py-1 text-zinc-300 border-b border-zinc-800">
            {c.name} <span className="text-zinc-400">{c.items.length}</span>
          </div>
          <div className="p-1 space-y-1">
            {c.items.map((it, ii) => (
              <div key={ii} className="group bg-zinc-800/70 rounded px-1.5 py-1 text-zinc-200 flex items-center gap-1">
                <button onClick={() => moveItem(ci, ii, -1)} disabled={ci === 0} title="Move left" className="disabled:opacity-50">
                  <ChevronLeft className="w-3 h-3 text-zinc-500 hover:text-zinc-200" />
                </button>
                <span className="flex-1 break-words">{it}</span>
                <button onClick={() => moveItem(ci, ii, 1)} disabled={ci === cols.length - 1} title="Move right" className="disabled:opacity-50">
                  <ChevronRight className="w-3 h-3 text-zinc-500 hover:text-zinc-200" />
                </button>
                <button onClick={() => delItem(ci, ii)} title="Delete" className="opacity-0 group-hover:opacity-100">
                  <X className="w-3 h-3 text-zinc-600 hover:text-red-400" />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-1 pt-1">
              <input
                value={drafts[ci] ?? ""}
                onChange={(e) => setDrafts({ ...drafts, [ci]: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && addItem(ci)}
                placeholder="+ Task"
                className="bg-transparent flex-1 text-zinc-300 outline-none placeholder:text-zinc-400"
              />
              <button onClick={() => addItem(ci)} title="Add task">
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
      placeholder="# Prompt / document…"
      className="w-full h-full resize-none bg-zinc-950 text-zinc-200 font-mono text-xs p-3 outline-none"
    />
  );
}

// ── chart: { xLabel?, yLabel?, series: [{ name, points: [[x, y], …] }] } ─────
// Metric curves (loss/acc vs step): agents append points via fs tools, humans watch.
// View-only — the data is machine-written, so no in-chart editing. Series colors are a
// fixed-order palette validated for the zinc-950 surface (contrast ≥3:1, CVD ΔE 23.6);
// identity is never color-alone: ≥2 series get a legend, ≤4 also get direct end-labels.
interface ChartPoint {
  x: number;
  y: number;
}
interface ChartData {
  xLabel?: string;
  yLabel?: string;
  series?: { name?: string; points?: unknown }[];
}
const CHART_COLORS = ["#3987e5", "#199e70", "#c98500", "#9085e9", "#e66767", "#008300", "#d55181", "#d95926"];
const CW = 640;
const CH = 300;
const PAD = { l: 48, r: 88, t: 14, b: 30 };

function parseSeries(d: ChartData | null): { name: string; pts: ChartPoint[] }[] {
  if (!d || !Array.isArray(d.series)) return [];
  return d.series
    .map((s, i) => ({
      name: typeof s?.name === "string" && s.name ? s.name : `series ${i + 1}`,
      pts: (Array.isArray(s?.points) ? (s.points as unknown[]) : [])
        // isFinite, not typeof: JSON.parse("1e999") yields Infinity, which would poison
        // the shared y-range and blank every series' scale into NaN
        .map((p) => (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { x: p[0] as number, y: p[1] as number } : null))
        .filter((p): p is ChartPoint => p !== null),
    }))
    .filter((s) => s.pts.length > 0);
}

function niceTicks(min: number, max: number, count = 4): number[] {
  const raw = (max - min) / count;
  if (!Number.isFinite(raw) || raw <= 0) return [];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  // index-based stepping with a hard bound: at large magnitudes `v += step` can be
  // float-absorbed (v never advances) — the naive loop then never terminates
  for (let i = 0, prev = NaN; i < count * 4; i++) {
    const v = first + i * step;
    if (v > max + step / 1e6) break;
    if (v !== prev) out.push(v);
    prev = v;
  }
  return out;
}

// `step` (the tick spacing) picks the decimals, so adjacent ticks always render as
// distinct labels — at every magnitude. The compact k/M suffixes derive their decimals
// from `step` scaled into the same unit; without that, ticks 50 apart near 10_000 both
// collapse to "10.1k". `step` is absent for tooltip values, which fall back to 1 decimal.
function fmtNum(v: number, step?: number): string {
  const hasStep = step !== undefined && step > 0 && Number.isFinite(step);
  // decimals needed to tell ticks `step` apart once values are divided by `scale`
  const decimalsForScale = (scale: number) =>
    hasStep ? Math.max(0, Math.min(8, -Math.floor(Math.log10(step / scale)))) : 1;
  // Number() strips trailing zeros so labels stay inside the axis gutter
  if (Math.abs(v) >= 1e6) return `${Number((v / 1e6).toFixed(decimalsForScale(1e6)))}M`;
  if (Math.abs(v) >= 10000) return `${Number((v / 1000).toFixed(decimalsForScale(1000)))}k`;
  if (hasStep) {
    return String(Number(v.toFixed(Math.max(0, Math.min(8, -Math.floor(Math.log10(step)))))));
  }
  return String(Number(v.toPrecision(6)));
}

function ChartLens({ data }: LensProps) {
  const d = data as ChartData | null;
  const series = parseSeries(d);
  const [hoverX, setHoverX] = useState<number | null>(null);
  if (series.length === 0) {
    return (
      <div className="p-3 text-zinc-400 text-xs">
        Empty — this file holds metric curves: {'{ "series": [{ "name": "loss", "points": [[step, value], …] }] }'}
      </div>
    );
  }

  // Single pass over every point for bounds + the x-union (a long training run is ~100k
  // points; `Math.min(...arr)` spreads each point as a call argument and throws RangeError
  // past V8's ~125k arg cap — the array-literal spread at `xsUnion` below has no such cap).
  const allX: number[] = [];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of series) {
    for (const p of s.pts) {
      allX.push(p.x);
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  if (x1 === x0) {
    // magnitude-relative: a fixed ±0.5 is float-absorbed at large |x| (range stays
    // zero-width and every coordinate divides to NaN)
    const xPad = Math.max(0.5, Math.abs(x1) * 1e-9);
    (x0 -= xPad), (x1 += xPad);
  }
  const yPad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.1 || 0.5;
  (y0 -= yPad), (y1 += yPad);
  const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (CW - PAD.l - PAD.r);
  const sy = (y: number) => CH - PAD.b - ((y - y0) / (y1 - y0)) * (CH - PAD.t - PAD.b);
  const color = (i: number) => CHART_COLORS[i % CHART_COLORS.length];
  const yTicks = niceTicks(y0, y1);
  const xTicks = niceTicks(x0, x1, 5);
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : undefined;
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : undefined;

  // direct end-labels (≤4 series), nudged apart so close line-ends stay readable
  const endLabels =
    series.length <= 4
      ? series
          .map((s, i) => ({ name: s.name, i, y: sy(s.pts[s.pts.length - 1].y) }))
          .sort((a, b) => a.y - b.y)
      : [];
  for (let i = 1; i < endLabels.length; i++)
    if (endLabels[i].y - endLabels[i - 1].y < 12) endLabels[i].y = endLabels[i - 1].y + 12;

  // hover: snap the crosshair to the nearest sampled x, tooltip shows each series there
  const xsUnion = [...new Set(allX)].sort((a, b) => a - b);
  const hx = hoverX === null ? null : xsUnion.reduce((b, x) => (Math.abs(x - hoverX) < Math.abs(b - hoverX) ? x : b), xsUnion[0]);
  const hoverRows =
    hx === null
      ? []
      : series.map((s, i) => {
          const p = s.pts.reduce((b, q) => (Math.abs(q.x - hx) < Math.abs(b.x - hx) ? q : b), s.pts[0]);
          return { name: s.name, i, p };
        });
  // width estimate covers the header row too, and CJK glyphs count double (~10px vs ~6px)
  const wchars = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const tipW = 20 + 6 * Math.max(...series.map((s) => wchars(s.name) + 8), wchars(d?.xLabel ?? "x") + 10, 10);
  const tipFlip = hx !== null && sx(hx) + tipW + 12 > CW - PAD.r;
  // clamp into the viewBox: a flipped tooltip for a long series name would otherwise
  // translate negative and get clipped by the svg's overflow
  const tipX = hx === null ? 0 : Math.max(2, Math.min(CW - tipW - 2, tipFlip ? sx(hx) - tipW - 10 : sx(hx) + 10));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * CW;
    setHoverX(px < PAD.l || px > CW - PAD.r ? null : x0 + ((px - PAD.l) / (CW - PAD.l - PAD.r)) * (x1 - x0));
  };

  return (
    <div className="p-2 h-full overflow-auto text-xs">
      {series.length >= 2 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pb-1">
          {series.map((s, i) => (
            <span key={`${s.name}${i}`} className="flex items-center gap-1.5 text-zinc-300">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: color(i) }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${CW} ${CH}`} className="w-full select-none" onMouseMove={onMove} onMouseLeave={() => setHoverX(null)}>
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.l} y1={sy(t)} x2={CW - PAD.r} y2={sy(t)} stroke="#27272a" strokeWidth="1" />
            <text x={PAD.l - 6} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="#a1a1aa" style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtNum(t, yStep)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={CH - PAD.b + 14} textAnchor="middle" fontSize="10" fill="#a1a1aa" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtNum(t, xStep)}
          </text>
        ))}
        <line x1={PAD.l} y1={CH - PAD.b} x2={CW - PAD.r} y2={CH - PAD.b} stroke="#3f3f46" strokeWidth="1" />
        {d?.yLabel && (
          <text x={PAD.l} y={PAD.t - 3} fontSize="10" fill="#a1a1aa">
            {d.yLabel}
          </text>
        )}
        {d?.xLabel && (
          <text x={CW - PAD.r} y={CH - 4} textAnchor="end" fontSize="10" fill="#a1a1aa">
            {d.xLabel}
          </text>
        )}
        {series.map((s, i) =>
          s.pts.length === 1 ? (
            // a 1-point polyline draws nothing — mark the lone sample instead
            <circle key={`l${i}`} cx={sx(s.pts[0].x)} cy={sy(s.pts[0].y)} r="4" fill={color(i)} />
          ) : (
            <polyline
              key={`l${i}`}
              points={s.pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
              fill="none"
              stroke={color(i)}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )
        )}
        {endLabels.map((l) => (
          <text key={`e${l.i}`} x={CW - PAD.r + 6} y={l.y} dominantBaseline="middle" fontSize="10" fill="#d4d4d8">
            {l.name}
          </text>
        ))}
        {hx !== null && (
          <g>
            <line x1={sx(hx)} y1={PAD.t} x2={sx(hx)} y2={CH - PAD.b} stroke="#52525b" strokeWidth="1" strokeDasharray="3 3" />
            {hoverRows.map((r) => (
              <circle key={`h${r.i}`} cx={sx(r.p.x)} cy={sy(r.p.y)} r="4" fill={color(r.i)} stroke="#09090b" strokeWidth="2" />
            ))}
            <g transform={`translate(${tipX}, ${PAD.t + 4})`}>
              <rect width={tipW} height={16 + hoverRows.length * 14} rx="4" fill="#18181b" stroke="#3f3f46" strokeWidth="1" />
              <text x="8" y="12" fontSize="10" fill="#a1a1aa" style={{ fontVariantNumeric: "tabular-nums" }}>
                {d?.xLabel ?? "x"} {fmtNum(hx)}
              </text>
              {hoverRows.map((r, j) => (
                <g key={`t${r.i}`} transform={`translate(8, ${26 + j * 14})`}>
                  <rect width="8" height="8" y="-8" rx="2" fill={color(r.i)} />
                  <text x="12" fontSize="10" fill="#d4d4d8" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {r.name} {fmtNum(r.p.y)}
                  </text>
                </g>
              ))}
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}

registerLens({ id: "table", render: (p) => <TableLens {...p} /> });
registerLens({ id: "kanban", render: (p) => <KanbanLens {...p} /> });
registerLens({ id: "markdown", render: (p) => <MarkdownLens {...p} /> });
registerLens({ id: "chart", viewOnly: true, render: (p) => <ChartLens {...p} /> });
