import type { CanvasEdge, CanvasLayoutStrategy, CanvasNode, CanvasRect } from "./document";

// Placement for canvas nodes that do not carry one.
//
// The whole reason this exists: an agent can state "these nodes, these dependencies"
// and cannot meaningfully invent `x: 480`. Requiring coordinates would either bar
// agents from authoring canvases (defeating the point) or fill the file with machine
// numbers nobody can read or comment on. So a `rect` is a PIN — what dragging writes —
// and everything without one is placed here.
//
// Pinned nodes are never moved, and the flow starts below them. Deliberate, and easy to
// state to a user: what you placed stays where you put it, and new things arrive
// underneath rather than on top of your arrangement.
//
// Pure: no React, no DOM, no measurement. The size below is nominal — the view scales
// its content to the rect rather than the other way round, so layout never has to wait
// for a render pass to know how big anything is.

export const DEFAULT_NODE_SIZE = { w: 260, h: 160 } as const;
export const NODE_GAP = 32;

const step = {
  x: DEFAULT_NODE_SIZE.w + NODE_GAP,
  y: DEFAULT_NODE_SIZE.h + NODE_GAP,
};

/** Longest-path depth per node (Kahn), with everything left in a cycle pushed past the
 *  deepest resolved rank. Same treatment `codemapLayout` gives an unresolvable node:
 *  a cyclic graph still renders, it just stops claiming to be layered. */
function depthsOf(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    const { node: from } = edge.from;
    const { node: to } = edge.to;
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
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
  const deepest = Math.max(0, ...[...depths.values()]);
  for (const node of nodes) if (!visited.has(node.id)) depths.set(node.id, deepest + 1);
  return depths;
}

/** Where the flow starts: clear of everything the user pinned. */
function flowTop(pinned: readonly CanvasRect[]): number {
  if (pinned.length === 0) return 0;
  return Math.max(...pinned.map((rect) => rect.y + rect.h)) + NODE_GAP;
}

function place(id: string, column: number, row: number, top: number): [string, CanvasRect] {
  return [id, { x: column * step.x, y: top + row * step.y, ...DEFAULT_NODE_SIZE }];
}

/** Resolve every node to a rect: pinned ones as authored, the rest laid out.
 *
 *  `dag` ranks by dependency (column = depth, row = position within it); `grid` and
 *  `free` flow row-major. `free` shares the grid because a document that declares it
 *  and pins nothing still has to render somewhere — free means "the user owns the
 *  positions", not "there are none". */
export function canvasLayout(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  strategy: CanvasLayoutStrategy
): Map<string, CanvasRect> {
  const out = new Map<string, CanvasRect>();
  const loose: CanvasNode[] = [];
  for (const node of nodes) {
    if (node.rect) out.set(node.id, node.rect);
    else loose.push(node);
  }
  if (loose.length === 0) return out;

  const top = flowTop([...out.values()]);

  if (strategy === "dag") {
    const depths = depthsOf(nodes, edges);
    const rows = new Map<number, number>();
    // Ranked by depth, then by document order — so two runs of the same file lay out
    // identically, and a node keeps its place when an unrelated one is added.
    const ranked = [...loose].sort((a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0));
    for (const node of ranked) {
      const depth = depths.get(node.id) ?? 0;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      const [id, rect] = place(node.id, depth, row, top);
      out.set(id, rect);
    }
    return out;
  }

  const columns = Math.max(1, Math.ceil(Math.sqrt(loose.length)));
  loose.forEach((node, index) => {
    const [id, rect] = place(node.id, index % columns, Math.floor(index / columns), top);
    out.set(id, rect);
  });
  return out;
}
