import { describe, expect, it } from "vitest";
import { nodeTitle, parseCanvas } from "./document";

describe("parseCanvas", () => {
  it("reads nodes, edges and the layout strategy", () => {
    const doc = parseCanvas({
      canvas: 1,
      layout: "grid",
      nodes: [
        { id: "plan", source: { kind: "fs", path: "dev/plan.yaml" }, view: "builtin:kanban" },
        { id: "note", text: "blocked" },
      ],
      edges: [{ id: "e1", from: { node: "plan", side: "right" }, to: { node: "note" }, label: "blocks" }],
    });
    expect(doc?.layout).toBe("grid");
    expect(doc?.nodes.map((n) => n.kind)).toEqual(["source", "text"]);
    expect(doc?.edges[0]).toEqual({ id: "e1", from: { node: "plan", side: "right" }, to: { node: "note" }, label: "blocks" });
  });

  it("is not a canvas unless it says so", () => {
    expect(parseCanvas({ nodes: [] })).toBeNull();
    expect(parseCanvas({ canvas: 2, nodes: [] })).toBeNull();
    expect(parseCanvas(null)).toBeNull();
    expect(parseCanvas("canvas")).toBeNull();
  });

  it("accepts an empty canvas", () => {
    expect(parseCanvas({ canvas: 1 })).toEqual({ version: 1, layout: "dag", nodes: [], edges: [] });
  });

  it("drops an unusable node rather than failing the whole read", () => {
    // The file is hand-edited and agent-written. One bad node must not cost the reader
    // every other node's placement.
    const doc = parseCanvas({
      canvas: 1,
      nodes: [
        { id: "good", text: "fine" },
        { text: "no id" },
        { id: "neither" },
        { id: "escapes", source: { kind: "fs", path: "../secrets" } },
        { id: "absolute", source: { kind: "fs", path: "/etc/passwd" } },
      ],
    });
    expect(doc?.nodes.map((n) => n.id)).toEqual(["good"]);
  });

  it("keeps the first of a duplicated id", () => {
    // A duplicate would make every path and every edge endpoint ambiguous.
    const doc = parseCanvas({
      canvas: 1,
      nodes: [{ id: "a", text: "first" }, { id: "a", text: "second" }],
    });
    expect(doc?.nodes).toHaveLength(1);
    expect(doc?.nodes[0]).toMatchObject({ text: "first" });
  });

  it("drops an edge that points at a node which is not there", () => {
    // This is what keeps deleting a node from leaving the document unrenderable.
    const doc = parseCanvas({
      canvas: 1,
      nodes: [{ id: "a", text: "a" }],
      edges: [
        { id: "ok", from: "a", to: "a" },
        { id: "dangling", from: "a", to: "ghost" },
      ],
    });
    expect(doc?.edges.map((e) => e.id)).toEqual(["ok"]);
  });

  it("accepts a bare node id as an edge endpoint", () => {
    // An agent writing an edge should not have to name a side it has no opinion about.
    const doc = parseCanvas({
      canvas: 1,
      nodes: [{ id: "a", text: "a" }, { id: "b", text: "b" }],
      edges: [{ id: "e", from: "a", to: "b" }],
    });
    expect(doc?.edges[0].from).toEqual({ node: "a" });
    expect(doc?.edges[0].to.side).toBeUndefined();
  });

  it("treats a rect as pinning, and a zero-area one as absent", () => {
    const doc = parseCanvas({
      canvas: 1,
      nodes: [
        { id: "pinned", text: "x", rect: { x: 10, y: 20, w: 100, h: 60 } },
        { id: "flat", text: "y", rect: { x: 0, y: 0, w: 0, h: 60 } },
        { id: "partial", text: "z", rect: { x: 1, y: 2 } },
      ],
    });
    expect(doc?.nodes[0].rect).toEqual({ x: 10, y: 20, w: 100, h: 60 });
    expect(doc?.nodes[1].rect).toBeUndefined();
    expect(doc?.nodes[2].rect).toBeUndefined();
  });

  it("falls back to dag for an unknown layout strategy", () => {
    expect(parseCanvas({ canvas: 1, layout: "spiral" })?.layout).toBe("dag");
  });

  it("ignores a side it does not know", () => {
    const doc = parseCanvas({
      canvas: 1,
      nodes: [{ id: "a", text: "a" }],
      edges: [{ id: "e", from: { node: "a", side: "diagonal" }, to: "a" }],
    });
    expect(doc?.edges[0].from).toEqual({ node: "a" });
  });

  it("reads a resource source, with and without pick", () => {
    const doc = parseCanvas({
      canvas: 1,
      nodes: [
        { id: "roster", source: { kind: "resource", verb: "channel.members", pick: "members" } },
        { id: "info", source: { kind: "resource", verb: "channel.info" } },
        { id: "verbless", source: { kind: "resource" } },
      ],
    });
    expect(doc?.nodes.map((n) => n.id)).toEqual(["roster", "info"]);
    expect(doc?.nodes[0]).toMatchObject({ source: { kind: "resource", verb: "channel.members", pick: "members" } });
  });
});

describe("nodeTitle", () => {
  it("uses a heading, a filename, or a verb", () => {
    expect(nodeTitle({ id: "n", kind: "text", text: "# Open questions\nbody" })).toBe("Open questions");
    expect(nodeTitle({ id: "n", kind: "source", source: { kind: "fs", path: "dev/plan.yaml" } })).toBe("plan.yaml");
    expect(nodeTitle({ id: "n", kind: "source", source: { kind: "resource", verb: "channel.members" } })).toBe("channel.members");
  });

  it("falls back to the id when the text has no first line", () => {
    expect(nodeTitle({ id: "blank", kind: "text", text: "\n\n  \n" })).toBe("blank");
  });
});
