import { parse as yamlParse } from "yaml";
import { PLUGIN_PROTOCOL, type PluginMeta, type RendererMatch } from "../sandbox/api";

// A renderer turns ONE file's content into an interactive UI. Renderers come from two
// places, kept uniform here: built-in (compiled lenses) and plugins (sandboxed code).
// A file declares NO type — the renderer declares what it ACCEPTS (format + structure),
// and is only offered for files whose content passes that. The real "can I render this"
// judgment still lives inside the renderer (it may reply cheers:unsupported at render).
// Which renderer opens a file is a binding (path -> renderer id) in .workbench.json.
export interface RendererDesc {
  id: string; // composite, unique, stored in bindings: "builtin:markdown" | "plugin:<pid>:<rid>"
  title: string;
  format: string[]; // coarse formats accepted: "markdown" | "json" | "yaml" | "toml" | "xml" | "text"
  source: "builtin" | "plugin";
  match: RendererMatch; // acceptance spec (host-evaluated for the candidate list)
  lensId?: string; // builtin: which compiled lens
  pluginId?: string; // plugin: installed plugin id
  rendererId?: string; // plugin: the renderer's id WITHIN the plugin (sent to the iframe)
  // false => resolvable (getRenderer) but NOT offered in the File-panel picker. Used for
  // lenses that need external config (table columns) — only reachable via a template's view.
  pickable?: boolean;
  // BUILTIN-ONLY structural refinement past the declarative `match` vocabulary,
  // evaluated on the parsed structured data. Not manifest-expressible (a JSON manifest
  // can't carry a predicate) — plugins get the same effect via cheers:unsupported.
  acceptsData?: (data: unknown) => boolean;
}

// Manifest `match.format` accepts a string or a list; absent = "text" (catch-all).
function formatsOf(m: RendererMatch): string[] {
  return m.format === undefined ? ["text"] : Array.isArray(m.format) ? m.format : [m.format];
}

// A file's coarse format, by extension. No extension / unknown => "text" (catch-all).
export function formatOf(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".md") || p.endsWith(".markdown")) return "markdown";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "yaml";
  if (p.endsWith(".toml")) return "toml";
  if (p.endsWith(".xml")) return "xml";
  return "text";
}

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000") // ** => any (incl. /)
    .replace(/\*/g, "[^/]*") // *  => any within a segment
    .replace(/\u0000/g, ".*");
  return new RegExp("^" + esc + "$");
}

// Parse structured content by coarse format — dataHas/dataKind are format-agnostic
// (JSON + YAML); jsonHas is frozen to JSON.
function parseStructured(path: string, content: string): unknown {
  const f = formatOf(path);
  try {
    if (f === "json") return JSON.parse(content) as unknown;
    if (f === "yaml") return yamlParse(content) as unknown;
  } catch {
    return undefined;
  }
  return undefined;
}

function hasKeys(data: unknown, keys: string[]): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return keys.every((k) => k in (data as Record<string, unknown>));
}

// Does this renderer accept this file's content? Cheap, host-side, no plugin boot.
export function accepts(desc: RendererDesc, path: string, content: string): boolean {
  if (!desc.format.includes("text") && !desc.format.includes(formatOf(path))) return false;
  const m = desc.match;
  if (m.glob && !globToRegExp(m.glob).test(path)) return false;
  if (m.requireAll && !m.requireAll.every((s) => content.includes(s))) return false;
  if (m.requireAny && m.requireAny.length && !m.requireAny.some((s) => content.includes(s))) return false;
  if (m.jsonHas?.length) {
    // deprecated alias of dataHas with FROZEN json-only semantics (never matches yaml)
    if (formatOf(path) !== "json" || !hasKeys(parseStructured(path, content), m.jsonHas)) return false;
  }
  if (m.dataHas?.length || m.dataKind !== undefined || desc.acceptsData) {
    const data = parseStructured(path, content);
    if (data === undefined) return false;
    if (m.dataKind === "array" && !Array.isArray(data)) return false;
    if (m.dataKind === "object" && (!data || typeof data !== "object" || Array.isArray(data))) return false;
    if (m.dataHas?.length && !hasKeys(data, m.dataHas)) return false;
    if (desc.acceptsData && !desc.acceptsData(data)) return false;
  }
  return true;
}

// Built-in renderers (compiled lenses). Markdown is the primary format's default and is
// pickable for any markdown. table/kanban need external config (columns), so they're
// resolvable (a template's view supplies config) but NOT offered in the generic picker.
const BUILTINS: RendererDesc[] = [
  {
    id: "builtin:markdown",
    title: "Markdown",
    format: ["markdown"],
    source: "builtin",
    lensId: "markdown",
    match: { format: "markdown" },
  },
  {
    // Array-of-rows table. Columns come from a template config when present, else the
    // lens infers them from the union of row keys — so it needs no external config and
    // IS pickable. This is also the official answer for YAML arrays (sandboxed plugins
    // would have to inline their own YAML parser; the builtin gets it from the Format
    // layer). Offered only when EVERY row is a plain object: YAML parses `- alpha` to a
    // string row and a bare `-` to null, for which a table has nothing honest to show
    // (per-character index columns / a crash) and a cell edit would corrupt the file.
    id: "builtin:table",
    title: "表格",
    format: ["json", "yaml"],
    source: "builtin",
    lensId: "table",
    match: { format: ["json", "yaml"], dataKind: "array" },
    acceptsData: (d) =>
      Array.isArray(d) && d.length > 0 && d.every((r) => r !== null && typeof r === "object" && !Array.isArray(r)),
  },
  {
    id: "builtin:kanban",
    title: "看板",
    format: ["json", "yaml"],
    source: "builtin",
    lensId: "kanban",
    match: { format: ["json", "yaml"] },
    // still template-bound: a `columns` key doesn't guarantee this lens's exact
    // {columns:[{name,items[]}]} shape, so it stays out of the generic picker.
    pickable: false,
  },
  {
    // Metric curves. Needs no external config (labels live in the file), and dataHas
    // gates the offer to files that actually carry a `series` key — so it IS pickable.
    id: "builtin:chart",
    title: "图表",
    format: ["json", "yaml"],
    source: "builtin",
    lensId: "chart",
    match: { format: ["json", "yaml"], dataHas: ["series"] },
  },
];

export function pluginRenderers(plugins: PluginMeta[]): RendererDesc[] {
  return plugins.flatMap((p) => {
    // A manifest declaring a protocol this host doesn't implement is skipped whole —
    // half-speaking its messages would be worse than not offering it at all.
    const proto = p.manifest.protocol ?? PLUGIN_PROTOCOL;
    if (proto !== PLUGIN_PROTOCOL) {
      console.warn(
        `workbench: skipping plugin ${p.plugin_id} — manifest protocol ${proto}, host implements ${PLUGIN_PROTOCOL}`
      );
      return [];
    }
    return (p.manifest.renderers ?? []).map((r) => ({
      id: `plugin:${p.plugin_id}:${r.id}`,
      title: r.title,
      format: formatsOf(r.match ?? {}),
      source: "plugin" as const,
      match: r.match ?? {},
      pluginId: p.plugin_id,
      rendererId: r.id,
    }));
  });
}

function allRenderers(plugins: PluginMeta[]): RendererDesc[] {
  return [...BUILTINS, ...pluginRenderers(plugins)];
}

// CSS-like specificity: the more (and stronger) constraints a renderer declares, the
// more specific it is. Used to ORDER candidates so the most-specific match is offered
// first when several renderers accept the same file. A user binding always overrides
// this (it's the "inline style"); specificity only decides default ordering.
export function specificity(desc: RendererDesc): number {
  const m = desc.match;
  let s = 0;
  if (m.requireAll?.length) s += m.requireAll.length;
  if (m.jsonHas?.length) s += m.jsonHas.length;
  if (m.dataHas?.length) s += m.dataHas.length;
  if (m.dataKind) s += 1;
  if (m.requireAny?.length) s += 1;
  if (m.glob) s += 1;
  if (desc.source === "plugin") s += 0.5; // a specialized plugin edges out a generic builtin on ties
  return s;
}

// Renderers that ACCEPT this file (format + declared structure), most-specific first.
// Content-aware, so a renderer needing `## ` headings won't be offered for prose.
// Multiple matches are NOT a conflict — they're a ranked candidate list; the user picks
// one and the choice persists as a binding.
export function candidatesFor(path: string, content: string, plugins: PluginMeta[]): RendererDesc[] {
  return allRenderers(plugins)
    .filter((r) => r.pickable !== false && accepts(r, path, content))
    .sort((a, b) => specificity(b) - specificity(a)); // stable: ties keep builtin-then-plugin order
}

export function getRenderer(id: string, plugins: PluginMeta[]): RendererDesc | undefined {
  return allRenderers(plugins).find((r) => r.id === id);
}
