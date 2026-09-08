import { describe, expect, it } from "vitest";
import { applyPatchOps, invertPatchOps, PatchError, type PatchOp } from "./patchOps";

const doc = () => ({
  canvas: 1,
  nodes: [
    { id: "a", text: "alpha" },
    { id: "b", text: "beta" },
    { id: "c", text: "gamma" },
  ],
  edges: [] as unknown[],
});

describe("applyPatchOps", () => {
  it("does not touch the caller's data", () => {
    // A batch is atomic on the gateway; locally that means the previous state survives
    // intact whether the batch succeeds or throws.
    const before = doc();
    applyPatchOps(before, [{ op: "set", path: ["nodes", 0, "text"], value: "changed" }]);
    expect(before.nodes[0].text).toBe("alpha");
  });

  it("sets a nested value", () => {
    const next = applyPatchOps(doc(), [
      { op: "set", path: ["nodes", 1, "rect"], value: { x: 10, y: 20, w: 100, h: 60 } },
    ]) as ReturnType<typeof doc>;
    expect(next.nodes[1]).toEqual({ id: "b", text: "beta", rect: { x: 10, y: 20, w: 100, h: 60 } });
  });

  it("creates a key that was absent, but refuses an index that is", () => {
    // `set` on a key is the only op that creates; every other addressing mode must
    // already resolve. This asymmetry is the gateway's, mirrored here deliberately.
    const next = applyPatchOps(doc(), [{ op: "set", path: ["layout"], value: "dag" }]) as Record<string, unknown>;
    expect(next.layout).toBe("dag");
    expect(() => applyPatchOps(doc(), [{ op: "set", path: ["nodes", 9], value: {} }])).toThrow(PatchError);
  });

  it("inserts, including at the end", () => {
    const appended = applyPatchOps(doc(), [
      { op: "insert", path: ["nodes"], index: 3, value: { id: "d" } },
    ]) as ReturnType<typeof doc>;
    expect(appended.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    // index === length appends; beyond it is a mistake, not a grow.
    expect(() =>
      applyPatchOps(doc(), [{ op: "insert", path: ["nodes"], index: 4, value: {} }])
    ).toThrow(PatchError);
  });

  it("removes by index and by key", () => {
    const next = applyPatchOps(doc(), [
      { op: "remove", path: ["nodes", 1] },
      { op: "remove", path: ["edges"] },
    ]) as Record<string, unknown>;
    expect((next.nodes as { id: string }[]).map((n) => n.id)).toEqual(["a", "c"]);
    expect("edges" in next).toBe(false);
  });

  it("refuses to remove the document root or a key that is not there", () => {
    expect(() => applyPatchOps(doc(), [{ op: "remove", path: [] }])).toThrow(PatchError);
    expect(() => applyPatchOps(doc(), [{ op: "remove", path: ["nope"] }])).toThrow(PatchError);
  });

  it("moves within a sequence", () => {
    const next = applyPatchOps(doc(), [{ op: "move", path: ["nodes"], from: 2, to: 0 }]) as ReturnType<typeof doc>;
    expect(next.nodes.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("treats a sequence as a sequence, not a mapping", () => {
    // `as_object_mut()` returns None for an array on the server. A bare
    // `typeof x === "object"` here would accept documents the gateway rejects.
    expect(() => applyPatchOps(doc(), [{ op: "set", path: ["nodes", "id"], value: "x" }])).toThrow(PatchError);
    expect(() => applyPatchOps(doc(), [{ op: "insert", path: ["canvas"], index: 0, value: 1 }])).toThrow(PatchError);
  });

  it("applies a batch in order", () => {
    const ops: PatchOp[] = [
      { op: "remove", path: ["nodes", 0] },
      { op: "insert", path: ["nodes"], index: 0, value: { id: "z" } },
      { op: "set", path: ["nodes", 0, "text"], value: "zeta" },
    ];
    const next = applyPatchOps(doc(), ops) as ReturnType<typeof doc>;
    expect(next.nodes.map((n) => n.id)).toEqual(["z", "b", "c"]);
    expect(next.nodes[0].text).toBe("zeta");
  });

  it("leaves nothing half-applied when a later op fails", () => {
    const before = doc();
    expect(() =>
      applyPatchOps(before, [
        { op: "set", path: ["nodes", 0, "text"], value: "changed" },
        { op: "remove", path: ["nodes", 99] },
      ])
    ).toThrow(PatchError);
    expect(before.nodes[0].text).toBe("alpha");
  });
});

describe("invertPatchOps", () => {
  const roundTrip = (ops: PatchOp[]) => {
    const before = doc();
    const after = applyPatchOps(before, ops);
    return applyPatchOps(after, invertPatchOps(before, ops));
  };

  it("undoes a set", () => {
    expect(roundTrip([{ op: "set", path: ["nodes", 0, "text"], value: "changed" }])).toEqual(doc());
  });

  it("undoes a set that created the key, by removing it", () => {
    // `set` on an absent key creates it, so its inverse is a removal — restoring
    // `undefined` would leave a phantom key in the document.
    const before = doc();
    const ops: PatchOp[] = [{ op: "set", path: ["layout"], value: "dag" }];
    const inverse = invertPatchOps(before, ops);
    expect(inverse).toEqual([{ op: "remove", path: ["layout"] }]);
    expect(applyPatchOps(applyPatchOps(before, ops), inverse)).toEqual(before);
  });

  it("undoes insert, remove and move", () => {
    expect(roundTrip([{ op: "insert", path: ["nodes"], index: 1, value: { id: "new" } }])).toEqual(doc());
    expect(roundTrip([{ op: "remove", path: ["nodes", 1] }])).toEqual(doc());
    expect(roundTrip([{ op: "move", path: ["nodes"], from: 0, to: 2 }])).toEqual(doc());
  });

  it("undoes a whole batch, in reverse", () => {
    // The gesture that deletes a node emits several ops; undo has to walk them
    // backwards, each against the state it actually saw.
    expect(
      roundTrip([
        { op: "set", path: ["nodes", 0, "text"], value: "x" },
        { op: "remove", path: ["nodes", 2] },
        { op: "insert", path: ["nodes"], index: 0, value: { id: "z" } },
      ])
    ).toEqual(doc());
  });
});
