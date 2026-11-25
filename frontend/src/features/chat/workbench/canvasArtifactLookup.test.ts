import { describe, expect, it } from "vitest";
import type { Artifact } from "../artifacts/client";
import { canvasLookupKey, settleCanvasLookup } from "./canvasArtifactLookup";

const artifact = (artifact_id: string) => ({ artifact_id, path: "board.canvas.yaml" }) as Artifact;
const key = canvasLookupKey("c1", "board.canvas.yaml");

describe("canvas artifact lookup", () => {
  it("settles on the first answer, including a failure", () => {
    expect(settleCanvasLookup(null, key, artifact("a"))).toEqual({ key, artifact: artifact("a") });
    expect(settleCanvasLookup(null, key, null)).toEqual({ key, artifact: null });
  });

  it("does not reuse another channel's answer for the same path", () => {
    const other = { key: canvasLookupKey("c2", "board.canvas.yaml"), artifact: artifact("a") };
    expect(settleCanvasLookup(other, key, artifact("b"))).toEqual({ key, artifact: artifact("b") });
  });

  it("keeps the open session's client across a refresh or a transient failure", () => {
    const settled = { key, artifact: artifact("a") };
    expect(settleCanvasLookup(settled, key, artifact("a"))).toBe(settled);
    expect(settleCanvasLookup(settled, key, null)).toBe(settled);
  });

  it("stays on the path after a fallback, even if a later lookup succeeds", () => {
    const fallback = { key, artifact: null };
    expect(settleCanvasLookup(fallback, key, artifact("a"))).toBe(fallback);
  });

  it("follows the path to a recreated artifact", () => {
    expect(settleCanvasLookup({ key, artifact: artifact("a") }, key, artifact("b"))).toEqual({ key, artifact: artifact("b") });
  });
});
