import { describe, expect, it } from "vitest";
import { placeNearRect, resolvePlacement } from "./floating-layer";

describe("resolvePlacement", () => {
  it("keeps the preferred side when both sides are ample", () => {
    expect(resolvePlacement("down", 400, 400)).toBe("down");
    expect(resolvePlacement("up", 400, 400)).toBe("up");
  });

  it("flips down→up when space below is cramped and above is roomier", () => {
    expect(resolvePlacement("down", 500, 100)).toBe("up");
  });

  it("flips up→down when space above is cramped and below is roomier", () => {
    expect(resolvePlacement("up", 100, 500)).toBe("down");
  });

  it("stays preferred when the other side is not roomier", () => {
    expect(resolvePlacement("down", 80, 100)).toBe("down");
    expect(resolvePlacement("up", 100, 80)).toBe("up");
  });

  it("stays preferred when the preferred side is still comfortable", () => {
    expect(resolvePlacement("down", 800, 300)).toBe("down");
    expect(resolvePlacement("up", 300, 800)).toBe("up");
  });
});

describe("placeNearRect", () => {
  const viewport = { width: 1200, height: 900 };

  it("opens below the anchor when there is room", () => {
    const anchor = { top: 100, bottom: 128, left: 40, right: 200, width: 160, height: 28 } as DOMRect;
    expect(placeNearRect(anchor, 400, 300, "down", viewport)).toEqual({ x: 40, y: 136 });
  });

  it("flips above the anchor near the bottom of the viewport", () => {
    const anchor = { top: 820, bottom: 848, left: 40, right: 200, width: 160, height: 28 } as DOMRect;
    expect(placeNearRect(anchor, 400, 300, "down", viewport)).toEqual({ x: 40, y: 512 });
  });

  it("opens to the left of a trace row in a right-side inspector", () => {
    const anchor = { top: 240, bottom: 268, left: 980, right: 1140, width: 160, height: 28 } as DOMRect;
    expect(placeNearRect(anchor, 640, 300, "left", viewport)).toEqual({ x: 332, y: 240 });
  });

  it("flips right when the left side cannot fit the panel", () => {
    const anchor = { top: 120, bottom: 148, left: 80, right: 240, width: 160, height: 28 } as DOMRect;
    expect(placeNearRect(anchor, 400, 300, "left", viewport)).toEqual({ x: 248, y: 120 });
  });
});
