import { describe, expect, it } from "vitest";
import {
  calculateStickySnap,
  STICKY_SNAP_THRESHOLD,
  STICKY_SNAP_MARGIN,
} from "./useWindowDrag";

describe("calculateStickySnap", () => {
  it("exports constants STICKY_SNAP_THRESHOLD and STICKY_SNAP_MARGIN", () => {
    expect(STICKY_SNAP_THRESHOLD).toBe(20);
    expect(STICKY_SNAP_MARGIN).toBe(8);
  });

  const bounds = {
    width: 1000,
    height: 800,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;

  it("snaps to left edge when within threshold", () => {
    // Left edge target is STICKY_SNAP_MARGIN (8)
    const result = calculateStickySnap(
      { x: STICKY_SNAP_MARGIN + 10, y: 300 },
      300,
      400,
      bounds
    );
    expect(result.snapped.left).toBe(true);
    expect(result.pos.x).toBe(STICKY_SNAP_MARGIN);
    expect(result.isSnapped).toBe(true);
  });

  it("snaps to right edge (docking) when within threshold", () => {
    // Right edge target is bounds.width - width - STICKY_SNAP_MARGIN = 1000 - 300 - 8 = 692
    const targetRight = 1000 - 300 - STICKY_SNAP_MARGIN;
    const result = calculateStickySnap(
      { x: targetRight - 12, y: 300 },
      300,
      400,
      bounds
    );
    expect(result.snapped.right).toBe(true);
    expect(result.pos.x).toBe(targetRight);
    expect(result.isSnapped).toBe(true);
  });

  it("snaps to top edge when within threshold", () => {
    const result = calculateStickySnap(
      { x: 500, y: STICKY_SNAP_MARGIN + 5 },
      300,
      400,
      bounds
    );
    expect(result.snapped.top).toBe(true);
    expect(result.pos.y).toBe(STICKY_SNAP_MARGIN);
    expect(result.isSnapped).toBe(true);
  });

  it("snaps to bottom edge when within threshold", () => {
    // Bottom edge target is bounds.height - height - STICKY_SNAP_MARGIN = 800 - 400 - 8 = 392
    const targetBottom = 800 - 400 - STICKY_SNAP_MARGIN;
    const result = calculateStickySnap(
      { x: 500, y: targetBottom + 8 },
      300,
      400,
      bounds
    );
    expect(result.snapped.bottom).toBe(true);
    expect(result.pos.y).toBe(targetBottom);
    expect(result.isSnapped).toBe(true);
  });

  it("does not snap when outside threshold", () => {
    const result = calculateStickySnap(
      { x: 400, y: 300 },
      300,
      200,
      bounds
    );
    expect(result.isSnapped).toBe(false);
    expect(result.pos.x).toBe(400);
    expect(result.pos.y).toBe(300);
  });

  it("snaps adjacent to neighboring panel (sticky note snapping)", () => {
    const neighbor = { x: 50, y: 50, w: 200, h: 300 };
    // Neighbor right edge is 50 + 200 + 8 = 258
    const result = calculateStickySnap(
      { x: 250, y: 60 },
      200,
      300,
      bounds,
      [neighbor]
    );
    expect(result.snapped.left).toBe(true);
    expect(result.pos.x).toBe(258);
    // Also aligns top edge to neighbor's y (50)
    expect(result.snapped.top).toBe(true);
    expect(result.pos.y).toBe(50);
    expect(result.isSnapped).toBe(true);
  });
});
