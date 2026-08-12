import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Select as UiSelect } from "@/components/ui/select";
import { Textarea as UiTextarea } from "@/components/ui/textarea";
import { useEffect, useRef, useState } from "react";
import {
  Box,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDotDashed,
  FileCode2,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  Server,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import { registerLens, type LensProps } from "./registry";
import { isComposing } from "@/lib/ime";
import { WorkbenchItem } from "@/components/ui/item";

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
    <div className="p-2 text-compact overflow-auto h-full">
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
                    <UiSelect value={String(r[c.key] ?? "")} onChange={(e) => update(i, c.key, e.target.value)} className="bg-zinc-800 text-zinc-200 rounded-sm outline-none">
                      {c.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </UiSelect>
                  ) : (
                    <UiInput value={String(r[c.key] ?? "")} onChange={(e) => update(i, c.key, e.target.value)} className="bg-transparent text-zinc-200 outline-none" />
                  )}
                </td>
              ))}
              <td className="p-1">
                <UiButton variant="plain" onClick={() => del(i)} title="Delete row">
                  <Trash2 className="w-3.5 h-3.5 text-zinc-600 hover:text-red-400" />
                </UiButton>
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
      <UiButton variant="plain" onClick={add} className="mt-2 flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
        <Plus className="w-3.5 h-3.5" /> Add row
      </UiButton>
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
    <div className="p-2 text-compact flex gap-2 items-start overflow-auto h-full">
      {cols.length === 0 && <div className="p-3 text-zinc-400">Empty board</div>}
      {cols.map((c, ci) => (
        <div key={ci} className="w-40 flex-shrink-0 bg-zinc-950/60 rounded-sm ">
          <div className="mx-1 mt-1 rounded-sm bg-zinc-800/50 px-2 py-1 text-zinc-300">
            {c.name} <span className="text-zinc-400">{c.items.length}</span>
          </div>
          <div className="p-1 space-y-1">
            {c.items.map((it, ii) => (
              <WorkbenchItem
                key={ii}
                presentationLevel="minimal"
                title={it}
                actions={<>
                <UiButton variant="plain" onClick={() => moveItem(ci, ii, -1)} disabled={ci === 0} title="Move left" className="disabled:opacity-50">
                  <ChevronLeft className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-200" />
                </UiButton>
                <UiButton variant="plain" onClick={() => moveItem(ci, ii, 1)} disabled={ci === cols.length - 1} title="Move right" className="disabled:opacity-50">
                  <ChevronRight className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-200" />
                </UiButton>
                <UiButton variant="plain" onClick={() => delItem(ci, ii)} title="Delete" className="opacity-0 group-hover:opacity-100">
                  <X className="w-3.5 h-3.5 text-zinc-600 hover:text-red-400" />
                </UiButton>
                </>}
                className="border-b-0 bg-zinc-800/70 text-zinc-200"
              />
            ))}
            <div className="flex items-center gap-1 pt-1">
              <UiInput
                value={drafts[ci] ?? ""}
                onChange={(e) => setDrafts({ ...drafts, [ci]: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && !isComposing(e) && addItem(ci)}
                placeholder="+ Task"
                className="bg-transparent flex-1 text-zinc-300 outline-none placeholder:text-zinc-400"
              />
              <UiButton variant="plain" onClick={() => addItem(ci)} title="Add task">
                <Plus className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-200" />
              </UiButton>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── markdown: a string (prompt templates, notes, drafts). Inert <UiTextarea> edit;
//    never dangerouslySetInnerHTML. (A sanitized preview can be added later.)
function MarkdownLens({ data, onChange }: LensProps) {
  const text = typeof data === "string" ? data : "";
  return (
    <UiTextarea
      value={text}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      placeholder="# Prompt / document…"
      className="h-full resize-none bg-zinc-950 text-zinc-200 font-mono text-compact outline-none"
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
      <div className="p-3 text-zinc-400 text-compact">
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
    <div className="p-2 h-full overflow-auto text-compact">
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
            <text x={PAD.l - 6} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize="var(--type-minimal)" fill="#a1a1aa" style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtNum(t, yStep)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={CH - PAD.b + 14} textAnchor="middle" fontSize="var(--type-minimal)" fill="#a1a1aa" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtNum(t, xStep)}
          </text>
        ))}
        <line x1={PAD.l} y1={CH - PAD.b} x2={CW - PAD.r} y2={CH - PAD.b} stroke="#3f3f46" strokeWidth="1" />
        {d?.yLabel && (
          <text x={PAD.l} y={PAD.t - 3} fontSize="var(--type-minimal)" fill="#a1a1aa">
            {d.yLabel}
          </text>
        )}
        {d?.xLabel && (
          <text x={CW - PAD.r} y={CH - 4} textAnchor="end" fontSize="var(--type-minimal)" fill="#a1a1aa">
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
          <text key={`e${l.i}`} x={CW - PAD.r + 6} y={l.y} dominantBaseline="middle" fontSize="var(--type-minimal)" fill="#d4d4d8">
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
              <text x="8" y="12" fontSize="var(--type-minimal)" fill="#a1a1aa" style={{ fontVariantNumeric: "tabular-nums" }}>
                {d?.xLabel ?? "x"} {fmtNum(hx)}
              </text>
              {hoverRows.map((r, j) => (
                <g key={`t${r.i}`} transform={`translate(8, ${26 + j * 14})`}>
                  <rect width="8" height="8" y="-8" rx="2" fill={color(r.i)} />
                  <text x="12" fontSize="var(--type-minimal)" fill="#d4d4d8" style={{ fontVariantNumeric: "tabular-nums" }}>
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

// ── codemap: { codemap: 1, nodes: { id: {...} }, edges: [...] } ─────────────
// Agent-authored repository knowledge. The graph is view-only in this generic lens:
// edits remain agent-maintained (or Raw) until LensPanel can submit fs.patch ops without
// rewriting YAML comments. Selection, pan and zoom are presentation-only local state.
export interface CodemapNode {
  id: string;
  kind: "area" | "module" | "file" | "symbol" | string;
  label: string;
  loc?: string;
  summary: string;
  status: "explored" | "partial" | "stale" | string;
  tags: string[];
}

export interface CodemapEdge {
  from: string;
  to: string;
  kind: string;
  label?: string;
}

export interface CodemapData {
  repo?: string;
  updated?: string;
  focus: Set<string>;
  nodes: CodemapNode[];
  edges: CodemapEdge[];
}

export function parseCodemap(data: unknown): CodemapData | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const root = data as Record<string, unknown>;
  if (root.codemap !== 1) return null;
  const rawNodes =
    root.nodes && typeof root.nodes === "object" && !Array.isArray(root.nodes)
      ? (root.nodes as Record<string, unknown>)
      : {};
  const nodes = Object.entries(rawNodes)
    .map(([id, raw]): CodemapNode => {
      const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      return {
        id,
        kind: typeof value.kind === "string" ? value.kind : "module",
        label: typeof value.label === "string" && value.label ? value.label : id.split(".").pop() || id,
        loc: typeof value.loc === "string" ? value.loc : undefined,
        summary: typeof value.summary === "string" ? value.summary : "",
        status: typeof value.status === "string" ? value.status : "partial",
        tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
      };
    })
    .sort((a, b) => {
      const depth = a.id.split(".").length - b.id.split(".").length;
      return depth || a.id.localeCompare(b.id);
    });
  const edges = Array.isArray(root.edges)
    ? root.edges.flatMap((raw): CodemapEdge[] => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const value = raw as Record<string, unknown>;
        if (typeof value.from !== "string" || typeof value.to !== "string") return [];
        return [{
          from: value.from,
          to: value.to,
          kind: typeof value.kind === "string" ? value.kind : "calls",
          label: typeof value.label === "string" ? value.label : undefined,
        }];
      })
    : [];
  return {
    repo: typeof root.repo === "string" ? root.repo : undefined,
    updated: typeof root.updated === "string" ? root.updated : undefined,
    focus: new Set(Array.isArray(root.focus) ? root.focus.filter((id): id is string => typeof id === "string") : []),
    nodes,
    edges,
  };
}

function codemapLayout(nodes: CodemapNode[], edges: CodemapEdge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const depths = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) {
      depths.set(next, Math.max(depths.get(next) ?? 0, (depths.get(id) ?? 0) + 1));
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const lastDepth = Math.max(...depths.values(), 0);
  for (const node of nodes) if (!visited.has(node.id)) depths.set(node.id, lastDepth + 1);

  const groups = new Map<number, CodemapNode[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    groups.set(depth, [...(groups.get(depth) ?? []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  const widest = Math.max(1, ...[...groups.values()].map((row) => row.length));
  for (const [depth, row] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    row.sort((a, b) => a.id.localeCompare(b.id));
    const inset = ((widest - row.length) * 190) / 2;
    row.forEach((node, index) => positions.set(node.id, { x: 46 + inset + index * 190, y: 44 + depth * 112 }));
  }
  return {
    positions,
    width: Math.max(520, widest * 190 + 80),
    height: Math.max(420, (Math.max(...groups.keys(), 0) + 1) * 112 + 70),
  };
}

function CodemapStatus({ status }: { status: string }) {
  if (status === "explored") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === "stale") return <TriangleAlert className="h-3.5 w-3.5 text-orange-400" />;
  return <CircleDotDashed className="h-3.5 w-3.5 text-amber-400" />;
}

function CodemapKindIcon({ kind }: { kind: string }) {
  if (kind === "file" || kind === "symbol") return <FileCode2 className="h-4 w-4" />;
  if (kind === "area") return <Server className="h-4 w-4" />;
  return <Box className="h-4 w-4" />;
}

function CodemapInspector({ node, onClose }: { node: CodemapNode; onClose?: () => void }) {
  return (
    <aside className="h-full w-full overflow-y-auto bg-zinc-900/95 p-4 text-compact">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-sm bg-indigo-500/15 text-indigo-300">
          <CodemapKindIcon kind={node.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-regular font-semibold text-zinc-100">{node.label}</h3>
          <p className="mt-0.5 text-compact capitalize text-zinc-500">{node.kind}</p>
        </div>
        {onClose && (
          <UiButton variant="plain" type="button" onClick={onClose} aria-label="Close node details" square controlSize="compact" className="rounded-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </UiButton>
        )}
      </div>
      <dl className="mt-5 space-y-5">
        <div>
          <dt className="text-minimal font-medium uppercase tracking-wider text-zinc-500">Summary</dt>
          <dd className="mt-2 whitespace-pre-wrap leading-5 text-zinc-300">{node.summary || "No summary yet."}</dd>
        </div>
        <div className="border-t border-zinc-800 pt-4">
          <dt className="text-minimal font-medium uppercase tracking-wider text-zinc-500">Status</dt>
          <dd className="mt-2 flex items-center gap-2 capitalize text-zinc-200"><CodemapStatus status={node.status} />{node.status}</dd>
        </div>
        {node.tags.length > 0 && (
          <div className="border-t border-zinc-800 pt-4">
            <dt className="text-minimal font-medium uppercase tracking-wider text-zinc-500">Tags</dt>
            <dd className="mt-2 flex flex-wrap gap-1.5">
              {node.tags.map((tag) => <span key={tag} className="rounded-sm bg-zinc-800 px-2 py-1 text-compact text-zinc-300">{tag}</span>)}
            </dd>
          </div>
        )}
        {node.loc && (
          <div className="border-t border-zinc-800 pt-4">
            <dt className="text-minimal font-medium uppercase tracking-wider text-zinc-500">Source locator</dt>
            <dd className="mt-2 break-all rounded-sm bg-zinc-950 px-3 py-2 font-mono text-compact leading-4 text-zinc-300">{node.loc}</dd>
          </div>
        )}
      </dl>
    </aside>
  );
}

function CodemapLens({ data }: LensProps) {
  const document = parseCodemap(data);
  const rootRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointer: number; x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= 760));
    observer.observe(element);
    setWide(element.getBoundingClientRect().width >= 760);
    return () => observer.disconnect();
  }, [document]);

  useEffect(() => {
    if (!document?.nodes.length) {
      setSelectedId(null);
      return;
    }
    if (selectedId && document.nodes.some((node) => node.id === selectedId)) return;
    setSelectedId(document.nodes.find((node) => document.focus.has(node.id))?.id ?? document.nodes[0].id);
  }, [document, selectedId]);

  if (!document || document.nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Boxes className="h-7 w-7 text-zinc-600" />
        <div className="text-regular font-medium text-zinc-200">Codemap is empty</div>
        <p className="max-w-md text-compact leading-5 text-zinc-400">Ask the agent to explore the repository and maintain codemap/map.yaml. Modules will appear here automatically.</p>
      </div>
    );
  }

  const layout = codemapLayout(document.nodes, document.edges);
  const selected = document.nodes.find((node) => node.id === selectedId) ?? null;
  const zoom = (factor: number) => setScale((current) => Math.min(2.2, Math.max(0.55, current * factor)));

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 bg-zinc-950">
      <div
        className="relative min-w-0 flex-1 overflow-hidden touch-none"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || drag.current.pointer !== event.pointerId) return;
          setOffset({ x: drag.current.ox + event.clientX - drag.current.x, y: drag.current.oy + event.clientY - drag.current.y });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left transition-transform duration-150 motion-reduce:transition-none"
          style={{ width: layout.width, height: layout.height, transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        >
          <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
            {document.edges.map((edge, index) => {
              const from = layout.positions.get(edge.from);
              const to = layout.positions.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + 72;
              const y1 = from.y + 56;
              const x2 = to.x + 72;
              const y2 = to.y;
              return (
                <g key={`${edge.from}:${edge.to}:${index}`}>
                  <path d={`M ${x1} ${y1} C ${x1} ${y1 + 36}, ${x2} ${y2 - 36}, ${x2} ${y2}`} fill="none" stroke="#52525b" strokeWidth="1.25" strokeDasharray={edge.kind === "data" ? "4 4" : undefined} />
                  {edge.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize="var(--type-minimal)" fill="#71717a">{edge.label}</text>}
                </g>
              );
            })}
          </svg>
          {document.nodes.map((node) => {
            const position = layout.positions.get(node.id)!;
            const focused = document.focus.has(node.id);
            const selectedNode = selectedId === node.id;
            return (
              <UiButton variant="plain"
                key={node.id}
                type="button"
                onClick={() => setSelectedId(node.id)}
                controlSize="comfortable" className={`absolute flex items-center gap-2 rounded-sm bg-zinc-900 text-left shadow-lg shadow-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${selectedNode ? "border-indigo-500 ring-1 ring-indigo-500/60": focused ? "border-indigo-500/70" : "border-zinc-700 hover:border-zinc-500"}`}
                style={{ left: position.x, top: position.y }}
                aria-label={`${node.label}, ${node.kind}, ${node.status}`}
              >
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-sm bg-zinc-800 text-zinc-300"><CodemapKindIcon kind={node.kind} /></span>
                <span className="min-w-0">
                  <span className="block truncate text-compact font-medium text-zinc-100">{node.label}</span>
                  <span className="mt-1 flex items-center gap-1 text-minimal capitalize text-zinc-400"><CodemapStatus status={node.status} />{node.status}</span>
                </span>
              </UiButton>
            );
          })}
        </div>

        <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-sm  border-zinc-800 bg-zinc-900/95 px-3 py-2 text-minimal text-zinc-400">
          <span className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> Explored</span>
          <span className="flex items-center gap-1"><CircleDotDashed className="h-3.5 w-3.5 text-amber-400" /> Partial</span>
          <span className="flex items-center gap-1"><TriangleAlert className="h-3.5 w-3.5 text-orange-400" /> Stale</span>
        </div>
        <div className="absolute bottom-3 right-3 flex items-center rounded-sm  border-zinc-800 bg-zinc-900/95 p-1">
          <UiButton variant="plain" type="button" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out" square controlSize="regular" className="flex items-center justify-center rounded-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><Minus className="h-4 w-4" /></UiButton>
          <span className="w-12 text-center text-minimal tabular-nums text-zinc-400">{Math.round(scale * 100)}%</span>
          <UiButton variant="plain" type="button" onClick={() => zoom(1.2)} aria-label="Zoom in" square controlSize="regular" className="flex items-center justify-center rounded-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><Plus className="h-4 w-4" /></UiButton>
          <UiButton variant="plain" type="button" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} aria-label="Reset graph" square controlSize="regular" className="flex items-center justify-center rounded-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><RotateCcw className="h-4 w-4" /></UiButton>
          <UiButton variant="plain" type="button" onClick={() => { setScale(1); setOffset({ x: 20, y: 20 }); }} aria-label="Fit graph" square controlSize="regular" className="flex items-center justify-center rounded-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><Maximize2 className="h-4 w-4" /></UiButton>
        </div>
      </div>
      {wide && selected && <div className="w-60 flex-shrink-0 border-l border-zinc-800"><CodemapInspector node={selected} /></div>}
      {!wide && selected && (
        <div className="absolute inset-x-3 bottom-16 z-20 max-h-[70%] overflow-hidden rounded-sm  border-zinc-700 shadow-2xl shadow-black/60">
          <CodemapInspector node={selected} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}

registerLens({ id: "table", render: (p) => <TableLens {...p} /> });
registerLens({ id: "kanban", render: (p) => <KanbanLens {...p} /> });
registerLens({ id: "markdown", render: (p) => <MarkdownLens {...p} /> });
registerLens({ id: "chart", viewOnly: true, render: (p) => <ChartLens {...p} /> });
registerLens({ id: "codemap", viewOnly: true, render: (p) => <CodemapLens {...p} /> });
