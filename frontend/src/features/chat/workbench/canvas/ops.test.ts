import { describe, expect, it } from "vitest";
import { applyPatchOps } from "../patchOps";
import { parseCanvas, type CanvasDocument } from "./document";
import { connectOps, edgeId, labelEdgeOps, pinNodeOps, removeNodeOps } from "./ops";

const raw = () => ({
  canvas: 1,
  nodes: [
    { id: "a", text: "alpha" },
    { id: "b", text: "beta" },
    { id: "c", text: "gamma" },
  ],
  edges: [
    { id: "a-b", from: "a", to: "b" },
    { id: "b-c", from: "b", to: "c" },
  ],
});

const parsed = (source: unknown = raw()) => parseCanvas(source) as CanvasDocument;

describe("pinNodeOps", () => {
  it("writes the rect, which is what pins the node", () => {
    const doc = parsed();
    const ops = pinNodeOps(doc.nodes[1], { x: 12.4, y: 20.6, w: 260, h: 160 });
    expect(ops).toEqual([{ op: "set", path: ["nodes", 1, "rect"], value: { x: 12, y: 21, w: 260, h: 160 } }]);
  });

  it("addresses the raw index, not the parsed position", () => {
    // With a node dropped ahead of it, these differ — and the edit would otherwise land
    // on the wrong node.
    const doc = parsed({ canvas: 1, nodes: [{ text: "dropped" }, { id: "real", text: "x" }] });
    expect(pinNodeOps(doc.nodes[0], { x: 0, y: 0, w: 1, h: 1 })[0].path).toEqual(["nodes", 1, "rect"]);
  });
});

describe("connectOps", () => {
  it("appends an edge carrying the sides the gesture used", () => {
    const doc = parsed();
    const ops = connectOps(doc, { node: "a", side: "right" }, { node: "c", side: "left" });
    expect(ops).toEqual([
      {
        op: "insert",
        path: ["edges"],
        index: 2,
        value: { id: "a-c", from: { node: "a", side: "right" }, to: { node: "c", side: "left" } },
      },
    ]);
  });

  it("creates the edges key when the file has none", () => {
    // A canvas an agent wrote may have no `edges` at all; the first connection has to
    // create the key before it can insert into it.
    const doc = parsed({ canvas: 1, nodes: [{ id: "a", text: "a" }, { id: "b", text: "b" }] });
    const ops = connectOps(doc, { node: "a" }, { node: "b" });
    expect(ops[0]).toEqual({ op: "set", path: ["edges"], value: [] });
    expect(ops).toHaveLength(2);
  });

  it("refuses a self-loop and a duplicate", () => {
    const doc = parsed();
    expect(connectOps(doc, { node: "a" }, { node: "a" })).toEqual([]);
    expect(connectOps(doc, { node: "a" }, { node: "b" })).toEqual([]);
  });

  it("refuses endpoints removed while a connection gesture is in flight", () => {
    const doc = parsed({ canvas: 1, nodes: [{ id: "b", text: "beta" }], edges: [] });
    expect(connectOps(doc, { node: "a" }, { node: "b" })).toEqual([]);
    expect(connectOps(doc, { node: "b" }, { node: "missing" })).toEqual([]);
  });

  it("names an edge after what it connects, and disambiguates", () => {
    const doc = parsed();
    expect(edgeId(doc, "a", "c")).toBe("a-c");
    // Readable ids collide; a timestamp would not, and would be unreadable in a file
    // whose whole point is being hand-editable.
    expect(edgeId(doc, "a", "b")).toBe("a-b-2");
  });
});

describe("removeNodeOps", () => {
  it("takes the node's edges with it, highest index first", () => {
    // Every removal shifts the indices after it, so descending order is not cosmetic.
    const ops = removeNodeOps(parsed(), "b");
    expect(ops).toEqual([
      { op: "remove", path: ["edges", 1] },
      { op: "remove", path: ["edges", 0] },
      { op: "remove", path: ["nodes", 1] },
    ]);
  });

  it("actually leaves a readable document behind", () => {
    const before = raw();
    const after = applyPatchOps(before, removeNodeOps(parsed(before), "b"));
    const doc = parseCanvas(after);
    expect(doc?.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(doc?.edges).toEqual([]);
  });

  it("does nothing for a node that is not there", () => {
    expect(removeNodeOps(parsed(), "ghost")).toEqual([]);
  });
});

describe("labelEdgeOps", () => {
  it("sets a label, and removes it when emptied", () => {
    expect(labelEdgeOps(1, "  blocks ")).toEqual([{ op: "set", path: ["edges", 1, "label"], value: "blocks" }]);
    expect(labelEdgeOps(1, "   ")).toEqual([{ op: "remove", path: ["edges", 1, "label"] }]);
  });
});
