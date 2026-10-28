import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollRootOf } from "./useNearViewport";

/** A parent chain of fake elements, innermost first, with their overflow-y. */
function chain(...overflows: string[]) {
  const nodes = overflows.map((overflowY) => ({ overflowY, parentElement: null as unknown }));
  nodes.forEach((node, i) => (node.parentElement = nodes[i + 1] ?? null));
  vi.stubGlobal("getComputedStyle", (node: { overflowY: string }) => ({ overflowY: node.overflowY }));
  return { leaf: { parentElement: nodes[0] ?? null } as unknown as Element, nodes };
}

describe("scrollRootOf", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("roots the observer at the nearest vertically scrolling ancestor", () => {
    const { leaf, nodes } = chain("visible", "auto", "scroll");
    expect(scrollRootOf(leaf)).toBe(nodes[1]);
  });

  it("falls back to the viewport when nothing scrolls", () => {
    const { leaf } = chain("visible", "hidden");
    expect(scrollRootOf(leaf)).toBeNull();
  });
});
