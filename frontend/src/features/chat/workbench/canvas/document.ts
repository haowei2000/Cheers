import type { PanelSourceContribution } from "../extensions/package";

// The canvas document: a channel file holding nodes and the edges between them.
//
// The node/edge model is JSON Canvas 1.0 (the format Obsidian opened up) with the
// divergences docs/arch/CANVAS.md argues for. Two of its decisions are copied outright:
// an edge binds to a node ID plus a SIDE rather than to points, so moving a node can
// never strand a connector; and a colour is an opaque preset slot the app maps to its
// own tokens.
//
// Where it diverges, and why it matters here:
//
//   - **Position is optional.** JSON Canvas requires absolute pixels because nobody but
//     a human ever writes one. An agent cannot invent `x: 480` meaningfully, but it can
//     state "these three nodes, these two dependencies" perfectly well. So an unpinned
//     node is laid out (see layout.ts) and `rect` means PINNED — which is what dragging
//     a node writes.
//   - **`z` is explicit**, not array order. Raising a node would otherwise rewrite the
//     whole array: an enormous diff, and unmergeable per node. Obsidian is single-user
//     and local-first; this file has concurrent writers.
//
// Parsing is deliberately TOLERANT. This file is hand-edited and agent-written, so one
// malformed node must not cost the reader every other node — it is dropped and the rest
// renders, the same rule sharedLayout.ts follows for `.workbench.json`.

export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CanvasSide = "top" | "right" | "bottom" | "left";
const SIDES: readonly string[] = ["top", "right", "bottom", "left"];

export type CanvasLayoutStrategy = "dag" | "grid" | "free";
const STRATEGIES: readonly string[] = ["dag", "grid", "free"];

interface CanvasNodeCommon {
  id: string;
  /** Where this node sits in the RAW `nodes` array — the index a patch op has to
   *  address. Not the same as its position in `nodes` below, because parsing drops
   *  unusable entries: with one bad node in the file, every index after it would be
   *  off by one and an edit would land on the wrong node. */
  at: number;
  /** Present = pinned. Absent = the layout engine places it. */
  rect?: CanvasRect;
  z?: number;
  /** A preset slot ("1".."6") or a hex value, resolved to theme tokens by the view. */
  color?: string;
}

/** A node is one of two shapes, not a four-way kind union: either literal text, or the
 *  same `{source, view, config}` a scene item and a lane panel already use. Keeping it
 *  that way is what makes "a canvas node is a panel with a position" true rather than
 *  aspirational — see docs/arch/PANEL_MODEL.md. */
export type CanvasNode =
  | (CanvasNodeCommon & { kind: "text"; text: string })
  | (CanvasNodeCommon & {
      kind: "source";
      source: PanelSourceContribution;
      view?: string;
      config?: unknown;
    });

export interface CanvasEdge {
  id: string;
  /** Index in the raw `edges` array — see `CanvasNodeCommon.at`. */
  at: number;
  from: { node: string; side?: CanvasSide };
  to: { node: string; side?: CanvasSide };
  label?: string;
}

export interface CanvasDocument {
  version: 1;
  layout: CanvasLayoutStrategy;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRect(raw: unknown): CanvasRect | undefined {
  if (!isMapping(raw)) return undefined;
  const x = finite(raw.x);
  const y = finite(raw.y);
  const w = finite(raw.w);
  const h = finite(raw.h);
  if (x === null || y === null || w === null || h === null) return undefined;
  // A zero-area node is not a placement, it is a mistake. Falling back to the layout
  // engine renders something the reader can actually grab.
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

function parseSource(raw: unknown): PanelSourceContribution | null {
  if (!isMapping(raw)) return null;
  if (raw.kind === "fs") {
    const path = raw.path;
    // Same shape check the workspace paths get everywhere else: relative, no traversal.
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
      return null;
    }
    return { kind: "fs", path };
  }
  if (raw.kind === "resource") {
    if (typeof raw.verb !== "string" || !raw.verb) return null;
    const pick = typeof raw.pick === "string" && raw.pick ? raw.pick : undefined;
    // NOTE: the verb is NOT allowlisted here, because nothing reads it yet — a source
    // node renders as a card. Before it ever fetches, it must be gated by the same
    // EXTENSION_CHANNEL_RESOURCES list a package panel is, for the same reason.
    return pick ? { kind: "resource", verb: raw.verb, pick } : { kind: "resource", verb: raw.verb };
  }
  return null;
}

function parseNode(raw: unknown, at: number): CanvasNode | null {
  if (!isMapping(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const common: CanvasNodeCommon = { id: raw.id, at };
  const rect = parseRect(raw.rect);
  if (rect) common.rect = rect;
  const z = finite(raw.z);
  if (z !== null) common.z = z;
  if (typeof raw.color === "string" && raw.color) common.color = raw.color;

  if (typeof raw.text === "string") return { ...common, kind: "text", text: raw.text };
  const source = parseSource(raw.source);
  if (!source) return null;
  return {
    ...common,
    kind: "source",
    source,
    ...(typeof raw.view === "string" && raw.view ? { view: raw.view } : {}),
    ...(raw.config !== undefined ? { config: raw.config } : {}),
  };
}

function parseEndpoint(raw: unknown): { node: string; side?: CanvasSide } | null {
  // `from: plan` is as valid as `from: {node: plan}` — an agent writing an edge should
  // not have to name a side it has no opinion about.
  if (typeof raw === "string" && raw) return { node: raw };
  if (!isMapping(raw) || typeof raw.node !== "string" || !raw.node) return null;
  const side = typeof raw.side === "string" && SIDES.includes(raw.side) ? (raw.side as CanvasSide) : undefined;
  return side ? { node: raw.node, side } : { node: raw.node };
}

function parseEdge(raw: unknown, at: number, nodeIds: ReadonlySet<string>): CanvasEdge | null {
  if (!isMapping(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const from = parseEndpoint(raw.from);
  const to = parseEndpoint(raw.to);
  if (!from || !to) return null;
  // A dangling edge has nothing to draw between. Dropping it is what keeps a node
  // deletion from leaving the document unrenderable.
  if (!nodeIds.has(from.node) || !nodeIds.has(to.node)) return null;
  return { id: raw.id, at, from, to, ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}) };
}

/** Read a canvas document. Returns null only when the value is not a canvas at all —
 *  a canvas with unusable parts still parses, minus those parts. */
export function parseCanvas(raw: unknown): CanvasDocument | null {
  if (!isMapping(raw) || raw.canvas !== 1) return null;
  const nodes: CanvasNode[] = [];
  const seen = new Set<string>();
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  for (let at = 0; at < rawNodes.length; at++) {
    const node = parseNode(rawNodes[at], at);
    // A duplicate id would make every path and every edge ambiguous; the first wins.
    if (node && !seen.has(node.id)) {
      seen.add(node.id);
      nodes.push(node);
    }
  }
  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  for (let at = 0; at < rawEdges.length; at++) {
    const edge = parseEdge(rawEdges[at], at, seen);
    if (edge && !edgeIds.has(edge.id)) {
      edgeIds.add(edge.id);
      edges.push(edge);
    }
  }
  const layout = typeof raw.layout === "string" && STRATEGIES.includes(raw.layout)
    ? (raw.layout as CanvasLayoutStrategy)
    : "dag";
  return { version: 1, layout, nodes, edges };
}

/** A node's title for chrome that needs one — the picker, a card header, a11y labels. */
export function nodeTitle(node: CanvasNode): string {
  if (node.kind === "text") {
    const firstLine = node.text.split("\n").find((line) => line.trim()) ?? "";
    const stripped = firstLine.replace(/^#+\s*/, "").trim();
    return stripped || node.id;
  }
  if (node.source.kind === "fs") {
    return node.source.path.split("/").pop() || node.source.path;
  }
  return node.source.verb;
}
