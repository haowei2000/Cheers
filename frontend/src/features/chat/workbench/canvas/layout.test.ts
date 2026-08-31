import { describe, expect, it } from "vitest";
import { canvasLayout, DEFAULT_NODE_SIZE } from "./layout";
import type { CanvasEdge, CanvasNode } from "./document";

let seq = 0;
const text = (id: string, rect?: CanvasNode["rect"]): CanvasNode => ({ id, at: seq++, kind: "text", text: id, ...(rect ? { rect } : {}) });
const edge = (id: string, from: string, to: string): CanvasEdge => ({ id, at: 0, from: { node: from }, to: { node: to } });

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("canvasLayout", () => {
  it("leaves a pinned node exactly where it was pinned", () => {
    const rect = { x: 500, y: 40, w: 300, h: 200 };
    const out = canvasLayout([text("pinned", rect)], [], "dag");
    expect(out.get("pinned")).toEqual(rect);
  });

  it("gives every node a rect", () => {
    const out = canvasLayout([text("a"), text("b"), text("c")], [], "grid");
    expect([...out.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  it("never overlaps two laid-out nodes", () => {
    const nodes = ["a", "b", "c", "d", "e", "f", "g"].map((id) => text(id));
    const rects = [...canvasLayout(nodes, [], "grid").values()];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j]), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it("does not move any other node when one gets pinned", () => {
    // The property the browser caught the absence of: laying out only the UNPINNED
    // nodes renumbers the sequence on every pin, so one drag makes the rest of the
    // canvas jump. Every node keeps its slot; a pin only overrides its own.
    const before = canvasLayout([text("a"), text("b"), text("c")], [], "grid");
    const pinned = canvasLayout(
      [text("a"), text("b", { x: 900, y: 900, w: 260, h: 160 }), text("c")],
      [],
      "grid"
    );
    expect(pinned.get("a")).toEqual(before.get("a"));
    expect(pinned.get("c")).toEqual(before.get("c"));
    expect(pinned.get("b")).toEqual({ x: 900, y: 900, w: 260, h: 160 });
  });

  it("keeps a dag node's slot when a peer is pinned", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "a", "c")];
    const before = canvasLayout([text("a"), text("b"), text("c")], edges, "dag");
    const after = canvasLayout([text("a"), text("b", { x: 40, y: 800, w: 260, h: 160 }), text("c")], edges, "dag");
    expect(after.get("c")).toEqual(before.get("c"));
  });

  it("ranks a dag by dependency depth", () => {
    const nodes = [text("a"), text("b"), text("c")];
    const out = canvasLayout(nodes, [edge("e1", "a", "b"), edge("e2", "b", "c")], "dag");
    expect(out.get("a")!.x).toBeLessThan(out.get("b")!.x);
    expect(out.get("b")!.x).toBeLessThan(out.get("c")!.x);
  });

  it("puts independent nodes at the same depth in separate rows", () => {
    const out = canvasLayout([text("root"), text("x"), text("y")], [edge("e1", "root", "x"), edge("e2", "root", "y")], "dag");
    expect(out.get("x")!.x).toBe(out.get("y")!.x);
    expect(out.get("x")!.y).not.toBe(out.get("y")!.y);
  });

  it("still lays out a cycle", () => {
    // A cyclic graph is not layerable, but it must still render.
    const out = canvasLayout(
      [text("a"), text("b")],
      [edge("e1", "a", "b"), edge("e2", "b", "a")],
      "dag"
    );
    expect(out.size).toBe(2);
    expect(overlaps(out.get("a")!, out.get("b")!)).toBe(false);
  });

  it("is deterministic", () => {
    // Two runs of the same file must lay out identically, or every reload looks like an
    // edit and the diff of a saved layout would be noise.
    const nodes = [text("a"), text("b"), text("c")];
    const edges = [edge("e", "a", "c")];
    expect([...canvasLayout(nodes, edges, "dag")]).toEqual([...canvasLayout(nodes, edges, "dag")]);
  });

  it("places a free-layout document rather than leaving it blank", () => {
    // `free` means the user owns the positions, not that there are none.
    const out = canvasLayout([text("a"), text("b")], [], "free");
    expect(out.get("a")).toMatchObject(DEFAULT_NODE_SIZE);
    expect(out.size).toBe(2);
  });

  it("returns nothing for an empty canvas", () => {
    expect(canvasLayout([], [], "dag").size).toBe(0);
  });

  it("ignores an edge whose endpoint is not a node", () => {
    const out = canvasLayout([text("a")], [edge("e", "a", "ghost")], "dag");
    expect(out.size).toBe(1);
  });
});
