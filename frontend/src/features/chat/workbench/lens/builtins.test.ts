import { describe, expect, it } from "vitest";
import { inferColumns, parseCodemap, updateRowCell, codemapLayout } from "./builtins";

// The registry only OFFERS the table for arrays of plain objects, but the lens can
// still receive anything (template bindings, files edited after binding) — these are
// the lens's own last-line guards against crashing or corrupting the file.
describe("table lens row guards", () => {
  it("inferColumns unions keys across plain-object rows, first-seen order", () => {
    expect(inferColumns([{ a: 1 }, { b: 2, a: 3 }])).toEqual([
      { key: "a", label: "a" },
      { key: "b", label: "b" },
    ]);
  });

  it("inferColumns skips null/scalar/array rows instead of throwing or faking columns", () => {
    // Object.keys(null) throws; Object.keys("alpha") yields "0","1",… index columns
    expect(inferColumns([{ a: 1 }, null, "alpha", 7, ["x"]])).toEqual([{ key: "a", label: "a" }]);
    expect(inferColumns([null, "alpha"])).toEqual([{ key: "value", label: "value" }]);
  });

  it("updateRowCell edits object rows immutably", () => {
    const rows = [{ a: "1" }, { a: "2" }];
    expect(updateRowCell(rows, 1, "a", "3")).toEqual([{ a: "1" }, { a: "3" }]);
    expect(rows[1]).toEqual({ a: "2" }); // input untouched
  });

  it("updateRowCell refuses non-object rows — a save can never corrupt the file", () => {
    // {..."alpha"} would silently become {"0":"a","1":"l",…} and get written back
    expect(updateRowCell(["alpha"], 0, "a", "x")).toBeNull();
    expect(updateRowCell([null], 0, "a", "x")).toBeNull();
    expect(updateRowCell([["x"]], 0, "a", "x")).toBeNull();
    expect(updateRowCell([{ a: 1 }], 5, "a", "x")).toBeNull(); // out of range
  });
});

describe("codemap lens parser", () => {
  it("normalizes nodes, edges, focus, and status metadata", () => {
    const parsed = parseCodemap({
      codemap: 1,
      repo: "haowei2000/Cheers",
      focus: ["gateway.fs"],
      nodes: {
        "gateway.fs": {
          kind: "module",
          label: "Filesystem resources",
          summary: "Reads and patches Workbench files",
          status: "explored",
          tags: ["gateway", "fs"],
        },
      },
      edges: [{ from: "gateway.fs", to: "web", kind: "data", label: "fs.patch" }],
    });

    expect(parsed?.repo).toBe("haowei2000/Cheers");
    expect(parsed?.focus).toEqual(new Set(["gateway.fs"]));
    expect(parsed?.nodes[0]).toMatchObject({ id: "gateway.fs", status: "explored" });
    expect(parsed?.edges[0]).toEqual({ from: "gateway.fs", to: "web", kind: "data", label: "fs.patch" });
  });

  it("rejects non-codemap documents", () => {
    expect(parseCodemap({ nodes: {} })).toBeNull();
  });
});

describe("codemap layout", () => {
  it("calculates positions and dimensions for nodes and edges", () => {
    const parsed = parseCodemap({
      codemap: 1,
      nodes: {
        a: { kind: "module", label: "A", summary: "", status: "explored", tags: [] },
        b: { kind: "module", label: "B", summary: "", status: "explored", tags: [] },
      },
      edges: [{ from: "a", to: "b" }],
    });
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const { positions, width, height } = codemapLayout(parsed.nodes, parsed.edges);
    expect(positions.has("a")).toBe(true);
    expect(positions.has("b")).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});
