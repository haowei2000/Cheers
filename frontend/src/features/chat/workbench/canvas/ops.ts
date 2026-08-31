import type { PatchOp } from "../patchOps";
import type { CanvasDocument, CanvasNode, CanvasRect, CanvasSide } from "./document";

// Gestures translated into file edits.
//
// Pure on purpose: a drag is easy to get subtly wrong (an index off by one lands the
// edit on a different node, and a removal in the wrong order corrupts the ones after
// it), and none of that needs a DOM to test.
//
// Every op addresses `node.at` / `edge.at` — the RAW array index — never the node's
// position in the parsed document. See CanvasNodeCommon.at.

/** Dragging a node writes its rect, and writing a rect is what pins it: from then on
 *  the layout engine leaves it alone. One gesture, one op, one meaning. */
export function pinNodeOps(node: CanvasNode, rect: CanvasRect): PatchOp[] {
  return [{ op: "set", path: ["nodes", node.at, "rect"], value: roundRect(rect) }];
}

function roundRect(rect: CanvasRect): CanvasRect {
  // Sub-pixel coordinates are noise in a file a human reads and an agent writes.
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
}

/** An id that reads as what it connects, and does not collide. A timestamp would be
 *  unique too, and unreadable in a file whose whole point is being hand-editable. */
export function edgeId(doc: CanvasDocument, from: string, to: string): string {
  const base = `${from}-${to}`;
  const taken = new Set(doc.edges.map((edge) => edge.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function connectOps(
  doc: CanvasDocument,
  from: { node: string; side?: CanvasSide },
  to: { node: string; side?: CanvasSide }
): PatchOp[] {
  // A self-loop and a duplicate both render as nothing a reader can use, so the gesture
  // is dropped rather than writing an edge the view will ignore.
  if (from.node === to.node) return [];
  if (doc.edges.some((edge) => edge.from.node === from.node && edge.to.node === to.node)) return [];
  const value = {
    id: edgeId(doc, from.node, to.node),
    from: from.side ? { node: from.node, side: from.side } : { node: from.node },
    to: to.side ? { node: to.node, side: to.side } : { node: to.node },
  };
  // `edges` may be absent from the file entirely — the first connection has to create
  // the key before it can insert into it.
  const insert: PatchOp = { op: "insert", path: ["edges"], index: doc.edges.length, value };
  return doc.edges.length === 0
    ? [{ op: "set", path: ["edges"], value: [] }, insert]
    : [insert];
}

/** Removing a node takes its edges with it — a dangling edge would be dropped on the
 *  next read anyway, so leaving one behind just makes the file lie.
 *
 *  Order matters: every removal shifts the indices after it, so this removes the
 *  highest index first and takes the node last. */
export function removeNodeOps(doc: CanvasDocument, id: string): PatchOp[] {
  const node = doc.nodes.find((candidate) => candidate.id === id);
  if (!node) return [];
  const edges = doc.edges
    .filter((edge) => edge.from.node === id || edge.to.node === id)
    .map((edge) => edge.at)
    .sort((a, b) => b - a);
  return [
    ...edges.map((at): PatchOp => ({ op: "remove", path: ["edges", at] })),
    { op: "remove", path: ["nodes", node.at] },
  ];
}

/** Retitle an edge, or clear the label when the text is emptied. */
export function labelEdgeOps(at: number, label: string): PatchOp[] {
  const trimmed = label.trim();
  return [
    trimmed
      ? { op: "set", path: ["edges", at, "label"], value: trimmed }
      : { op: "remove", path: ["edges", at, "label"] },
  ];
}
